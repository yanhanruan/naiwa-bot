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
// 记忆（见 docs/memory-v2-design.md）：
//   MEMORY_EXTRACTION        off 关闭后台提炼（回复时仍会用已有事实），默认开启
//   MEMORY_MODEL             提炼用的模型，默认 deepseek-flash
//   MEMORY_QUIET_MS          会话安静多久后提炼（毫秒），默认 600000（10 分钟）
//   MEMORY_BATCH_FORCE       未提炼的原话攒到多少条就提炼，默认 40
// 群里什么时候说话（见 docs/module-07-group-chat-design.md）：
//   BOT_NAMES                能叫它的名字（逗号分隔），默认 奶蛙；消息以名字开头才算叫它
//   IGNORE_QQ                不理的 QQ 号（逗号分隔），例如群里别的机器人；他们的话也不进群里最近的聊天
//   GROUP_CONTEXT            off 不把群里最近的聊天放进提示（默认放：最近 20 条、10 分钟内、整段最多 1000 字，只在内存里）；
//                            关掉后不记内容，只记谁什么时候说了话，用来判断回复时要不要引用原消息
// 看懂图片、引用带原文（见 docs/image-understanding-design.md）：
//   IMAGE_UNDERSTANDING      off 不看图（图片都按“[图片]”处理），默认看；引用带原文不受影响
//   IMAGE_MODEL              看图用的模型，默认 deepseek-flash（只有它能看图）
// 运行锁：同一个数据库同时只能有一个机器人在跑；运行中 forget-person 会被拒绝（见 src/storage/run-lock.js）。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { Fish } from '../src/index.js';
import { openStorage, migrate } from '../src/storage/index.js';
import { OneBotClient } from '../src/adapters/onebot.js';
import { DeepSeekBrain } from '../src/model/brain.js';
import { ModelUsageLedger } from '../src/model/usage-ledger.js';
import { ConversationRateLimiter } from '../src/model/rate-limiter.js';
import { MessageInbox } from '../src/runtime/inbox.js';
import { ConversationHistory } from '../src/context/history.js';
import { PersonAliases } from '../src/context/aliases.js';
import { FactStore } from '../src/memory/facts.js';
import { MemoryExtractor } from '../src/memory/extractor.js';
import { acquireRunLock } from '../src/storage/run-lock.js';
import { Participation } from '../src/runtime/participation.js';
import { GroupContext } from '../src/runtime/group-context.js';
import { RoundLooker } from '../src/images/look.js';
import { entityKey } from '../src/identity.js';
import { createQQHandler } from '../src/qq-handler.js';
import { loadMoodTexts } from '../src/mood/prompt.js';
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
const memoryExtraction = !/^(off|false|0|no)$/i.test(process.env.MEMORY_EXTRACTION ?? '');
const memoryModel = process.env.MEMORY_MODEL?.trim() || 'deepseek-flash';
const memoryQuietMs = numberFromEnv('MEMORY_QUIET_MS', 10 * 60_000);
const memoryBatchForce = numberFromEnv('MEMORY_BATCH_FORCE', 40);
if (!(memoryBatchForce >= 1)) {
  console.error('MEMORY_BATCH_FORCE 必须不小于 1');
  process.exit(1);
}
// 只按逗号分隔：名字里可以有空格（例如 "Nai Wa"）。
const listFromEnv = (name) => (process.env[name] ?? '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const botNames = listFromEnv('BOT_NAMES').length ? listFromEnv('BOT_NAMES') : ['奶蛙'];
const ignoreQQ = listFromEnv('IGNORE_QQ');
if (ignoreQQ.some((id) => !/^\d+$/.test(id))) {
  console.error('IGNORE_QQ 只能填 QQ 号（数字），多个用逗号分隔');
  process.exit(1);
}
const groupContextOn = !/^(off|false|0|no)$/i.test(process.env.GROUP_CONTEXT ?? '');
const imageUnderstanding = !/^(off|false|0|no)$/i.test(process.env.IMAGE_UNDERSTANDING ?? '');
const imageModel = process.env.IMAGE_MODEL?.trim() || 'deepseek-flash';
if (reasoningEffort && !/^[a-z]+$/.test(reasoningEffort)) {
  console.error('DEEPSEEK_REASONING_EFFORT 只能是小写字母组成的强度名，例如 none、low、high');
  process.exit(1);
}

const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf8') : '你是一只小青蛙。';
const socialRulesPath = process.env.FISH_SOCIAL_RULES ?? join(root, 'persona', 'social-rules.md');
const socialRules = existsSync(socialRulesPath) ? readFileSync(socialRulesPath, 'utf8') : '';
// 每一档心情的说法和口癖（Module 8）：persona/moods/<档>.md，平常没有文件。
const moodTexts = loadMoodTexts(process.env.FISH_MOODS_DIR ?? join(root, 'persona', 'moods'));
// 连不上数据库会直接抛错退出，不会以空记忆启动。迁移等拿到运行锁以后再跑（见下）。
const db = await openStorage({ migrateOnOpen: false });
// 运行锁：拿不到说明已有机器人在跑（或者 forget-person 正在删数据），拒绝启动。
// 先拿锁再迁移：误启动的第二个机器人（可能是更新的代码）不会在运行中的机器人底下改表结构。
// 拿到以后，原话、关系记录、代号、事实、提炼进度只经这条连接写入；这条连接一断，立即退出。
let writer;
try {
  writer = await acquireRunLock({
    databaseUrl: process.env.DATABASE_URL,
    onLost: (error) => {
      log.error('bot.run_lock_lost', { msg: '持锁连接断开，运行锁已失效，立即退出；请重新启动', error });
      process.exit(1);
    },
  });
} catch (error) {
  console.error(error?.code === 'RUN_LOCK_BUSY'
    ? '已有奶蛙在运行（或者 forget-person 正在删除数据），本次不启动。'
    : `拿运行锁失败：${error?.message ?? error}`);
  await db.close().catch(() => {});
  process.exit(1);
}
try {
  await migrate(db);
} catch (error) {
  // 迁移失败（整体回滚）：不以旧表结构启动。
  console.error(`数据库迁移失败：${error?.message ?? error}`);
  await writer.close();
  await db.close().catch(() => {});
  process.exit(1);
}
const fish = await (await Fish.open({ db, writer, name: '奶蛙' })).start();
// 模型调用适配器：超时与重试、花费估算入账、每日花费上限、按会话限速都在里面完成。
const ledger = new ModelUsageLedger({ db, tenantId: fish.tenantId });
const brain = new DeepSeekBrain({
  apiKey, model, webSearch, reasoningEffort, logger: log, dailyBudgetCny, ledger,
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

// 入站消息记录：去重、记录每条消息的处理结果（见 docs/module-05-runtime.md）。
// 上次退出时没处理完的消息标为 abandoned；超过 30 天的记录每天清理一次。
const inbox = new MessageInbox({ db, tenantId: fish.tenantId });
const interrupted = await inbox.recoverInterrupted();
if (interrupted) log.warn('runtime.recovered', { msg: '上次退出时有消息没处理完，已标为中断', count: interrupted });
// 短期对话历史存在数据库里（见 docs/module-06-context.md），超过 7 天的每天清理一次。
const history = new ConversationHistory({ db, writer, tenantId: fish.tenantId });
const aliases = new PersonAliases({ db, writer, tenantId: fish.tenantId });
// 记得的事（事实）：回复时读，后台提炼写；到期的每天清理一次。
const facts = new FactStore({ db, writer, tenantId: fish.tenantId });
// 各项分开清理：一项失败不能拖累另一项（对话历史含聊天原文，必须按期删除）。
async function prune() {
  try {
    const removed = await inbox.prune();
    if (removed) log.info('runtime.pruned', { msg: '已清理 30 天前的消息记录', count: removed });
  } catch (error) {
    log.error('runtime.prune_failed', { msg: '清理消息记录失败', error });
  }
  try {
    const turns = await history.prune();
    if (turns) log.info('context.pruned', { msg: '已清理 7 天前的对话历史', count: turns });
  } catch (error) {
    log.error('context.prune_failed', { msg: '清理对话历史失败', error });
  }
  try {
    const expired = await facts.prune();
    if (expired) log.info('memory.pruned', { msg: '已清理到期的事实', count: expired });
  } catch (error) {
    log.error('memory.prune_failed', { msg: '清理到期事实失败', error });
  }
}
await prune();
setInterval(() => void prune(), 24 * 3_600_000).unref();
// 重启前奶蛙发过的消息：有人引用它们时仍算“叫到了奶蛙”。
const sentMessageKeys = await inbox.recentSentMessages();

// 看图：flash，不联网、不思考，最多写 150 字；一次最多 20 秒（和查引用、下载共用，见 src/images/look.js）。
// 花费记在同一本账上，计入每日上限；另外按会话限速（和回复一样的次数，分开计）。
const looker = new RoundLooker({
  logger: log,
  brain: imageUnderstanding ? new DeepSeekBrain({
    apiKey, model: imageModel, webSearch: false, reasoningEffort: 'none', maxOutputTokens: 300,
    deadlineMs: 20_000, firstAttemptMs: 15_000, logger: log, dailyBudgetCny, ledger,
    limiter: new ConversationRateLimiter({ perMinute: ratePerMinute, perHour: ratePerHour }),
  }) : null,
});

const handleEvent = createQQHandler({
  fish, brain, getClient: () => client, persona, socialRules, logger: log, inbox, history, aliases, facts, sentMessageKeys,
  botNames,
  participation: new Participation({ botNames, ignoreUsers: ignoreQQ.map((id) => entityKey('qq', 'user', id)) }),
  groupContext: new GroupContext({ keepText: groupContextOn }),
  looker,
  mood: fish.mood,
  moodTexts,
});

// 后台提炼：便宜的模型，不联网、不思考；花费记在同一本账上，计入每日上限。
const extractor = memoryExtraction ? new MemoryExtractor({
  db, writer, tenantId: fish.tenantId, aliases, facts, logger: log, quietMs: memoryQuietMs, batchForce: memoryBatchForce,
  brain: new DeepSeekBrain({
    apiKey, model: memoryModel, webSearch: false, reasoningEffort: 'none', logger: log, dailyBudgetCny, ledger,
  }),
}).start() : null;
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
  if (stopping) {
    // 正在等手上的消息处理完时再按一次 Ctrl-C：立即退出。没处理完的消息下次启动时标为中断。
    log.warn('bot.force_exit', { msg: '强制退出', signal });
    process.exit(1);
  }
  stopping = true;
  log.info('bot.stopping', { msg: '准备退出，先处理完手上的消息（最多 10 秒）', signal });
  // 先停止接收新消息、等手上的处理完（发送还需要连接），再断开 OneBot。
  const unfinished = await handleEvent.stop(10_000);
  if (unfinished) log.warn('runtime.stopped', { msg: '还有消息没处理完，下次启动时标为中断', unfinished });
  client.stop();
  extractor?.stop();
  try {
    await fish.stop();
    await writer.close();
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
  memoryExtraction, memoryModel: memoryExtraction ? memoryModel : undefined,
  imageUnderstanding, imageModel: imageUnderstanding ? imageModel : undefined,
  memoryQuietMs: memoryExtraction ? memoryQuietMs : undefined,
  botNames, ignoreQQ: ignoreQQ.length || undefined, groupContext: groupContextOn,
});
client.start();
