// 运行状态（Module 9，见 docs/module-09-admin-design.md 第 5、6 节）：bot_status 表，每个租户一行。
// - 奶蛙这边（BotStatus）：每 5 秒先读一遍设置，再写一次心跳（连没连上 QQ、最后收发消息的时间、刚读过设置的时间）；
//   正常退出时写“正常退出”。
// - 命令这边（readStatus、waitForApply）：按心跳判断在跑 / 没在跑 / 没响应；改完设置等奶蛙读到。
// 时间：心跳和读设置的时间用数据库的时钟，命令和奶蛙比较时不怕两边电脑时间不一样。
import { execFileSync } from 'node:child_process';
import { silentLogger } from '../log.js';

export const STATUS_DEFAULTS = {
  beatMs: 5_000, // 多久读一次设置、写一次心跳
  aliveMs: 20_000, // 这么久内有心跳算“在跑”
  applyWaitMs: 10_000, // 改完设置最多等多久奶蛙读到
};

// 跑的是哪份代码：目录、分支、提交号。Docker 里没有 git，提交号读环境变量 GIT_COMMIT（Module 10 在镜像里设）。
export function codeInfo(dir) {
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  };
  return {
    dir,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    commit: process.env.GIT_COMMIT?.trim() || git('rev-parse', '--short', 'HEAD'),
  };
}

export class BotStatus {
  /**
   * @param {object} opts
   * @param {object} opts.db
   * @param {import('./settings.js').Settings} opts.settings 每次心跳前先刷新它
   * @param {object} [opts.logger]
   */
  constructor({ db, tenantId = 'default', settings, logger = silentLogger, beatMs = STATUS_DEFAULTS.beatMs }) {
    this.db = db;
    this.tenantId = tenantId;
    this.settings = settings;
    this.log = logger;
    this.beatMs = beatMs;
    this.connected = false;
    this.connectedChangedAt = null;
    this.lastMessageAt = null;
    this.lastReplyAt = null;
    this.timer = null;
    this.refreshFailing = false;
    this.beating = null;
  }

  /**
   * 启动时：先读一遍设置（读不到直接抛错，奶蛙不启动），再写“在跑”。之后每 beatMs 一次。
   * @param {{dir?: string, branch?: string|null, commit?: string|null}} [code]
   */
  async start(code = {}) {
    await this.settings.refresh();
    await this.db.query(
      `INSERT INTO bot_status (tenant_id, started_at, heartbeat_at, stopped_at, pid, code_dir, code_branch, code_commit,
         onebot_connected, onebot_since, last_message_at, last_reply_at, settings_read_at)
       VALUES ($1, now(), now(), NULL, $2, $3, $4, $5, false, NULL, NULL, NULL, $6)
       ON CONFLICT (tenant_id) DO UPDATE SET started_at = now(), heartbeat_at = now(), stopped_at = NULL, pid = $2,
         code_dir = $3, code_branch = $4, code_commit = $5, onebot_connected = false, onebot_since = NULL,
         last_message_at = NULL, last_reply_at = NULL, settings_read_at = $6`,
      [this.tenantId, process.pid, code.dir ?? null, code.branch ?? null, code.commit ?? null, this.settings.readAt],
    );
    this.timer = setInterval(() => void this.beat(), this.beatMs);
    this.timer.unref?.();
    return this;
  }

  noteConnection(connected) {
    if (connected === this.connected && this.connectedChangedAt) return;
    this.connected = connected;
    this.connectedChangedAt = new Date();
  }

  noteMessage() {
    this.lastMessageAt = new Date();
  }

  noteReply() {
    this.lastReplyAt = new Date();
  }

  // 读一遍设置，写一次心跳。各自失败只记日志：读设置失败就继续用上一次的值，settings_read_at 不往前走。
  async beat() {
    if (this.beating) return this.beating; // 上一次还没写完（数据库慢）就不叠着写
    this.beating = (async () => {
      try {
        await this.settings.refresh();
        if (this.refreshFailing) this.log.info('settings.refresh_recovered', { msg: '又读到设置了' });
        this.refreshFailing = false;
      } catch (error) {
        if (!this.refreshFailing) this.log.warn('settings.refresh_failed', { msg: '读设置失败，继续用上一次的值', error });
        this.refreshFailing = true;
      }
      try {
        await this.db.query(
          `UPDATE bot_status SET heartbeat_at = now(), onebot_connected = $2, onebot_since = $3,
             last_message_at = $4, last_reply_at = $5, settings_read_at = $6 WHERE tenant_id = $1`,
          [this.tenantId, this.connected, this.connectedChangedAt, this.lastMessageAt, this.lastReplyAt, this.settings.readAt],
        );
      } catch (error) {
        this.log.warn('status.beat_failed', { msg: '写心跳失败', error });
      }
    })().finally(() => { this.beating = null; });
    return this.beating;
  }

  // 正常退出：写“没在跑”。
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.beating;
    await this.db.query(
      'UPDATE bot_status SET stopped_at = now(), heartbeat_at = now(), onebot_connected = false WHERE tenant_id = $1',
      [this.tenantId],
    );
  }
}

/**
 * 命令读：奶蛙现在怎么样。
 * state：running 在跑；stopped 正常退出了；unresponsive 没心跳也没正常退出（卡住或被强杀）；never 这个库里还没跑过。
 * 所有时间都换成“离数据库现在多少毫秒”（ago），方便显示“10 秒前”。
 */
export async function readStatus(db, { tenantId = 'default', aliveMs = STATUS_DEFAULTS.aliveMs } = {}) {
  const { rows } = await db.query(
    `SELECT now() AS db_now, s.* FROM (SELECT 1) one LEFT JOIN bot_status s ON s.tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  const dbNow = new Date(row.db_now);
  if (!row.tenant_id) return { state: 'never', dbNow };
  const at = (v) => (v ? new Date(v) : null);
  const ago = (v) => (v ? dbNow - new Date(v) : null);
  const heartbeatAgo = ago(row.heartbeat_at);
  const stoppedAt = at(row.stopped_at);
  let state;
  if (stoppedAt && stoppedAt >= at(row.heartbeat_at)) state = 'stopped';
  else state = heartbeatAgo <= aliveMs ? 'running' : 'unresponsive';
  return {
    state,
    dbNow,
    startedAt: at(row.started_at),
    heartbeatAt: at(row.heartbeat_at),
    heartbeatAgo,
    stoppedAt,
    pid: row.pid,
    code: { dir: row.code_dir, branch: row.code_branch, commit: row.code_commit },
    onebot: { connected: row.onebot_connected, since: at(row.onebot_since) },
    lastMessageAgo: ago(row.last_message_at),
    lastReplyAgo: ago(row.last_reply_at),
    settingsReadAt: at(row.settings_read_at),
  };
}

/**
 * 命令改完设置以后：等奶蛙读到。since 是改完以后取的数据库时间（Settings.dbNow）。
 * @returns {Promise<{result: 'applied', afterMs: number} | {result: 'not_running', status: object} | {result: 'pending'}>}
 *   applied：奶蛙已经读到（afterMs：改完以后多久读到的）；not_running：奶蛙没在跑；pending：在跑，但等了 timeoutMs 还没读到
 */
export async function waitForApply(db, since, {
  tenantId = 'default', timeoutMs = STATUS_DEFAULTS.applyWaitMs, pollMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await readStatus(db, { tenantId });
    if (status.state !== 'running') return { result: 'not_running', status };
    if (status.settingsReadAt && status.settingsReadAt > since) return { result: 'applied', afterMs: status.settingsReadAt - since };
    if (Date.now() >= deadline) return { result: 'pending' };
    await sleep(pollMs);
  }
}
