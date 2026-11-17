#!/usr/bin/env node
// 数字生命 QQ 入口：fish-os 核心 + OneBot v11（SnowLuma/NapCat）+ DeepSeek 大脑。
// 用法：
//   export DEEPSEEK_API_KEY=sk-xxx
//   export ONEBOT_TOKEN=xxx   # SnowLuma 的 OneBot WS token
//   export DATABASE_URL=postgres://...   # PostgreSQL（见 docker-compose.yml 的 db 服务）
//   node bin/fish-bot.mjs     # 默认连 ws://127.0.0.1:3001
// 日志：LOG_LEVEL=debug|info|warn|error（默认 info）；LOG_FORMAT=pretty|json（默认：终端里 pretty，否则 json）。
// 模型调用的限制（见 docs/module-04-model.md）：
//   MODEL_DAILY_BUDGET_CNY   每日花费上限（元，按官方价格估算），默认 20；0 表示不限
//   MODEL_RATE_PER_MINUTE    每个会话每分钟最多调用几次，默认 10；0 表示不限
//   MODEL_RATE_PER_HOUR      每个会话每小时最多调用几次，默认 120；0 表示不限
//   DEEPSEEK_WEB_SEARCH      off 关闭联网搜索（默认开启，只有 deepseek-v4-pro 支持）
//   DEEPSEEK_REASONING_EFFORT 思考强度，例如 none 关闭思考；不设置时用模型默认
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { Fish } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import { OneBotClient } from '../src/adapters/onebot.js';
import { DeepSeekBrain } from '../src/model/brain.js';
import { ModelUsageLedger } from '../src/model/usage-ledger.js';
import { ConversationRateLimiter } from '../src/model/rate-limiter.js';
import { createQQHandler } from '../src/qq-handler.js';
import { loggerFromEnv } from '../src/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// 可选：把收到的原始 OneBot 事件逐行追加到这个文件（JSONL），用于收集真实格式样本。含聊天原文，只存本地。
const recordFile = process.env.ONEBOT_RECORD_FILE ?? '';
const ws = process.env.ONEBOT_WS ?? 'ws://127.0.0.1:3001';
const token = process.env.ONEBOT_TOKEN ?? '';
const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro';
const personaPath = process.env.FISH_PERSONA ?? join(root, 'persona', 'naiwa.md');
const log = loggerFromEnv();

if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY。到 platform.deepseek.com 申请后：');
  console.error('  export DEEPSEEK_API_KEY=sk-...');
  process.exit(1);
}

// 数字配置写错时直接退出，不能悄悄当成“不限”。
function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} 必须是不小于 0 的数字（0 表示不限），当前值无效`);
    process.exit(1);
  }
  return value;
}
const dailyBudgetCny = numberFromEnv('MODEL_DAILY_BUDGET_CNY', 20);
const ratePerMinute = numberFromEnv('MODEL_RATE_PER_MINUTE', 10);
const ratePerHour = numberFromEnv('MODEL_RATE_PER_HOUR', 120);
const webSearch = !/^(off|false|0|no)$/i.test(process.env.DEEPSEEK_WEB_SEARCH ?? '');
const reasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT?.trim() || undefined;
if (reasoningEffort && !/^[a-z]+$/.test(reasoningEffort)) {
  console.error('DEEPSEEK_REASONING_EFFORT 只能是小写字母组成的强度名，例如 none、low、high');
  process.exit(1);
}

const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf8') : '你是一只小青蛙。';
const socialRulesPath = process.env.FISH_SOCIAL_RULES ?? join(root, 'persona', 'social-rules.md');
const socialRules = existsSync(socialRulesPath) ? readFileSync(socialRulesPath, 'utf8') : '';
// 连不上数据库或迁移失败会直接抛错退出，不会以空记忆启动。
const db = await openStorage();
const fish = await (await Fish.open({ db, name: '奶蛙' })).start();
// 模型调用适配器：超时与重试、花费估算入账、每日花费上限、按会话限速都在里面完成。
const brain = new DeepSeekBrain({
  apiKey, model, webSearch, reasoningEffort, logger: log, dailyBudgetCny,
  ledger: new ModelUsageLedger({ db, tenantId: fish.tenantId }),
  limiter: new ConversationRateLimiter({ perMinute: ratePerMinute, perHour: ratePerHour }),
});

function record(ev) {
  // 心跳（SnowLuma 每 30 秒一次）没有样本价值，不录。录制失败不能影响聊天。
  if (!recordFile || (ev.post_type === 'meta_event' && ev.meta_event_type === 'heartbeat')) return;
  try {
    mkdirSync(dirname(recordFile), { recursive: true });
    appendFileSync(recordFile, `${JSON.stringify({ receivedAt: Date.now(), event: ev })}\n`, { mode: 0o600 });
  } catch (error) {
    log.error('recording.failed', { msg: '录制事件失败', error });
  }
}

const handleEvent = createQQHandler({ fish, brain, getClient: () => client, persona, socialRules, logger: log });
// 一个长期存在的客户端：断线重连、请求超时、无响应探测、发送节流都在客户端内部完成。
const client = new OneBotClient({
  url: ws,
  token,
  logger: log,
  onEvent: (ev) => {
    record(ev);
    return handleEvent(ev);
  },
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('bot.stopping', { msg: '准备退出', signal });
  client.stop();
  try {
    await fish.stop();
    await db.close();
  } catch (error) {
    log.error('bot.stop_failed', { msg: '退出时出错', error });
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

log.info('bot.started', {
  msg: `${fish.character.name} 醒来`, model, webSearch, reasoningEffort, storage: 'PostgreSQL', recordFile: recordFile || undefined,
  dailyBudgetCny: dailyBudgetCny || '不限', ratePerMinute: ratePerMinute || '不限', ratePerHour: ratePerHour || '不限',
});
client.start();
