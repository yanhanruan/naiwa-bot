// 数据库连接的最小抽象：生产用 pg（真 PostgreSQL），测试用 PGlite（进程内 WASM PostgreSQL）。
// 上层只用这三个方法：
//   query(sql, params) -> { rows }   单条语句，参数化
//   exec(sql)                         可含多条语句、无参数（只给迁移用）
//   transaction(async (tx) => ...)    tx 也有 query / exec；回调抛错则整体回滚
//   close()

export async function connectPostgres(connectionString, { max = 5 } = {}) {
  if (!connectionString) throw new Error('缺少 DATABASE_URL（PostgreSQL 连接串）');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max });
  // 空闲连接出错（例如数据库重启）时不能让进程崩溃；下次 query 会拿新连接。
  pool.on('error', (error) => console.error(`[storage] PostgreSQL 空闲连接出错：${error.message}`));
  await pool.query('SELECT 1'); // 连不上就立即失败，不以空数据启动
  return {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (sql, params) => client.query(sql, params),
          exec: (sql) => client.query(sql),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function connectPGlite(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return {
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction((tx) => fn({
      query: (sql, params) => tx.query(sql, params),
      exec: (sql) => tx.exec(sql),
    })),
    close: () => db.close(),
  };
}
