#!/usr/bin/env node
// 提醒服务（Module 10）：docker compose 的 alert 服务跑它，每 5 分钟查一次，出问题 QQ 私聊你、用 Bark 推到手机。
//   node scripts/alert-check.mjs          一直跑
//   node scripts/alert-check.mjs --once   查一次就退出
//   node scripts/alert-check.mjs --test   两路各发一条测试提醒，看收不收得到
// 环境变量：
//   ALERT_QQ            收提醒的 QQ 号（你的主号），经 SnowLuma 用小号私聊发
//   ALERT_BARK_URL      Bark App 里显示的推送地址
//   ALERT_BALANCE_CNY   DeepSeek 余额低于多少提醒，默认 50
//   ALERT_ONEBOT_WS     连 SnowLuma 的地址，默认同 ONEBOT_WS；ONEBOT_TOKEN 同奶蛙
//   DATABASE_URL、DEEPSEEK_API_KEY 同奶蛙；LOG_DIR 写日志和提醒状态（alert-state.json）；BACKUP_DIR 备份目录
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loggerFromEnv } from '../src/log.js';
import { readStatus } from '../src/admin/status.js';
import { Settings } from '../src/admin/settings.js';
import { ModelUsageLedger } from '../src/model/usage-ledger.js';
import { backupState } from '../src/ops/backups.js';
import {
  ALERT_DEFAULTS, checkResults, decide, markSent, oneBotCall, deepseekBalance, sendBark,
} from '../src/ops/alerts.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const log = loggerFromEnv(env, process.stdout, { prefix: 'alert' });
const logDir = resolve(env.LOG_DIR || join(root, 'logs'));
const backupDir = resolve(env.BACKUP_DIR || join(root, 'backups'));
const statePath = join(logDir, 'alert-state.json');
const onebot = { url: env.ALERT_ONEBOT_WS || env.ONEBOT_WS || 'ws://127.0.0.1:3001', token: env.ONEBOT_TOKEN || '' };
const alertQQ = env.ALERT_QQ?.trim() || '';
const barkUrl = env.ALERT_BARK_URL?.trim() || '';
const balanceCny = Number(env.ALERT_BALANCE_CNY || ALERT_DEFAULTS.balanceCny);

if (alertQQ && !/^\d+$/.test(alertQQ)) {
  console.error('ALERT_QQ 只能是 QQ 号（数字）');
  process.exit(1);
}
if (!Number.isFinite(balanceCny) || balanceCny < 0) {
  console.error('ALERT_BALANCE_CNY 必须是不小于 0 的数字');
  process.exit(1);
}

// 两路都发；返回发出去了几路。
async function notify(text, { qqUsable }) {
  let sent = 0;
  if (alertQQ) {
    if (!qqUsable) log.info('alert.skipped', { msg: 'QQ 小号不在线，这一路先不发', channel: 'qq' });
    else {
      try {
        await oneBotCall({ ...onebot, action: 'send_private_msg', params: { user_id: Number(alertQQ), message: text } });
        sent += 1;
      } catch (error) {
        log.warn('alert.send_failed', { msg: 'QQ 私聊没发出去', channel: 'qq', error });
      }
    }
  }
  if (barkUrl) {
    try {
      await sendBark({ url: barkUrl, text });
      sent += 1;
    } catch (error) {
      log.warn('alert.send_failed', { msg: 'Bark 没推出去', channel: 'bark', error });
    }
  }
  return sent;
}

async function look() {
  const seen = { backups: backupState(backupDir), balanceCny };
  try {
    seen.qq = await oneBotCall({ ...onebot, action: 'get_status' });
  } catch {
    seen.qq = null;
  }
  if (env.DATABASE_URL) {
    const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
    try {
      await client.connect();
      seen.bot = await readStatus(client);
      const settings = new Settings({ db: client });
      await settings.refresh();
      seen.budget = { spent: (await new ModelUsageLedger({ db: client }).day()).costCny, budget: settings.dailyBudgetCny };
    } catch {
      seen.bot = null;
      seen.budget = null;
    } finally {
      await client.end().catch(() => {});
    }
  }
  if (env.DEEPSEEK_API_KEY) {
    try {
      seen.balance = await deepseekBalance({ apiKey: env.DEEPSEEK_API_KEY });
    } catch (error) {
      seen.balance = null;
      log.warn('alert.balance_failed', { msg: '查 DeepSeek 余额失败', error });
    }
  }
  return seen;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
  } catch (error) {
    log.warn('alert.state_save_failed', { msg: '提醒状态存不下来，重启后可能重复提醒', error });
  }
}

async function round() {
  const now = Date.now();
  const seen = await look();
  const { state, messages } = decide(loadState(), checkResults(seen, now), now);
  if (messages.length) {
    const text = messages.map((m) => m.text).join('\n');
    if (!alertQQ && !barkUrl) {
      log.info('alert.would_send', { msg: '没设收提醒的地方，只记日志', keys: messages.map((m) => `${m.kind}:${m.key}`) });
      markSent(state, messages);
      saveState(state);
      return;
    }
    const sent = await notify(text, { qqUsable: Boolean(seen.qq?.online) });
    log.info(sent ? 'alert.sent' : 'alert.send_failed', {
      msg: sent ? '提醒已发出' : '两路都没发出去，下一轮再发', keys: messages.map((m) => `${m.kind}:${m.key}`), channels: sent,
    });
    if (sent) markSent(state, messages);
    else for (const m of messages) if (m.kind === 'ok') state[m.key] = { badSince: now, notified: true };
  }
  // “好了”没发出去的那几项：上面暂时留着，下一轮查到还是好的会再说一次。
  saveState(state);
}

const args = process.argv.slice(2);
if (!alertQQ && !barkUrl) {
  log.warn('alert.not_configured', { msg: '没设 ALERT_QQ 和 ALERT_BARK_URL，不知道提醒发给谁；只记日志' });
}
if (args.includes('--test')) {
  let online = false;
  try {
    online = Boolean((await oneBotCall({ ...onebot, action: 'get_status' }))?.online);
  } catch { /* SnowLuma 没响应 */ }
  const sent = await notify('✓ 奶蛙：这是一条测试提醒，收到就说明这一路通了', { qqUsable: online });
  console.log(`测试提醒发出了 ${sent} 路（QQ ${alertQQ ? (online ? '已发' : '小号不在线，没发') : '没设'}，Bark ${barkUrl ? '已发' : '没设'}；失败的看日志）`);
  process.exit(sent ? 0 : 1);
}
log.info('alert.started', { msg: '提醒服务启动', everyMs: ALERT_DEFAULTS.everyMs, qq: Boolean(alertQQ), bark: Boolean(barkUrl), balanceCny });
for (;;) {
  try {
    await round();
  } catch (error) {
    log.error('alert.round_failed', { msg: '这一轮检查出错', error });
  }
  log.pruneFiles();
  if (args.includes('--once')) break;
  await new Promise((r) => setTimeout(r, ALERT_DEFAULTS.everyMs));
}
