// 运行锁（见 docs/memory-v2-design.md 第 8 节）。
// - 机器人用一条专用连接一直拿着这把数据库锁（和迁移锁同一种 advisory 锁，但是会话级的）。拿不到就拒绝启动，
//   所以同一时间只有一个机器人在跑；forget-person 也要先拿到它才删，机器人运行时删除会被拒绝。
// - forget-person 会删的数据（原话、关系记录、代号、事实、提炼进度），写入都只走这条连接。
//   连接一断，没提交的写入由数据库回滚，锁同时释放，之后旧进程在这条连接上什么都写不进去：
//   不会出现“锁已经没了，旧任务又把删掉的数据写回来”。
// - 这条连接上的操作一个接一个执行（排队），每次是一个短事务，不在事务里等模型。
// - 连接出错或关闭时调用 onLost：机器人收到后立即退出。
export const RUN_LOCK_KEY = 4_204_202;

export class RunLockBusyError extends Error {
  constructor() {
    super('运行锁被占用：已有机器人在运行，或者 forget-person 正在删除数据');
    this.name = 'RunLockBusyError';
    this.code = 'RUN_LOCK_BUSY';
  }
}

/**
 * 把只有一条连接的 { query, transaction } 包成排队执行的版本。
 * 注意：transaction 的回调里只能用传进来的 tx，不能再用包装后的对象，否则会自己等自己。
 */
export function serialize(conn) {
  let tail = Promise.resolve();
  const run = (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
  return {
    query: (sql, params) => run(() => conn.query(sql, params)),
    transaction: (fn) => run(() => conn.transaction(fn)),
  };
}

/**
 * 在一条新连接上拿运行锁。拿不到抛 RunLockBusyError。
 * @param {object} opts
 * @param {string} opts.databaseUrl
 * @param {number} [opts.lockKey] 测试用不同的数，免得和正在运行的机器人互相影响
 * @param {(error: Error) => void} [opts.onLost] 拿到锁以后连接出错或关闭时调用（只调一次）；主动 close() 不算
 * @param {number} [opts.heartbeatMs] 每隔多久在这条连接上查一次，尽早发现断线；0 表示不查
 * @returns {Promise<{query: Function, transaction: Function, pid: number, held: boolean, close: () => Promise<void>}>}
 */
export async function acquireRunLock({ databaseUrl, lockKey = RUN_LOCK_KEY, onLost = () => {}, heartbeatMs = 30_000 } = {}) {
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL（PostgreSQL 连接串）');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl, keepAlive: true });
  let state = 'connecting'; // connecting → held → lost | closed
  let timer = null;
  const lose = (error) => {
    if (state !== 'held') return;
    state = 'lost';
    clearInterval(timer);
    onLost(error ?? new Error('持锁连接已关闭'));
  };
  client.on('error', (error) => lose(error));
  client.on('end', () => lose());
  await client.connect();
  let pid;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok, pg_backend_pid() AS pid', [lockKey]);
    if (!rows[0].ok) throw new RunLockBusyError();
    pid = rows[0].pid;
  } catch (error) {
    state = 'closed';
    await client.end().catch(() => {});
    throw error;
  }
  state = 'held';

  const writer = serialize({
    query: (sql, params) => client.query(sql, params),
    async transaction(fn) {
      await client.query('BEGIN');
      try {
        const result = await fn({ query: (sql, params) => client.query(sql, params), exec: (sql) => client.query(sql) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    },
  });
  if (heartbeatMs > 0) {
    timer = setInterval(() => { writer.query('SELECT 1').catch((error) => lose(error)); }, heartbeatMs);
    timer.unref();
  }
  return {
    ...writer,
    pid,
    get held() { return state === 'held'; },
    // 主动释放：结束这条连接，锁随之释放。
    async close() {
      if (state === 'held') state = 'closed';
      clearInterval(timer);
      await client.end().catch(() => {});
    },
  };
}
