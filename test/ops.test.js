// Module 10：日志文件、查卡在哪（trace）、提醒、到期清理。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogFile, loggerFromEnv } from '../src/log.js';
import {
  parseArgs, readLogs, statusTimeline, conversationReport, describeMessage, nowLine, overviewLines,
} from '../src/ops/trace.js';
import { checkResults, decide, markSent, barkEndpoint } from '../src/ops/alerts.js';
import { ModelUsageLedger } from '../src/model/usage-ledger.js';
import { EventStore } from '../src/eventstore.js';
import { testDb, closeTestDb } from './helpers.js';

after(closeTestDb);

const tmp = () => mkdtempSync(join(tmpdir(), 'naiwa-ops-'));
// 北京时间 2026-11-26 hh:mm:ss
const at = (hms, day = '2026-11-26') => Date.parse(`${day}T${hms}+08:00`);
const NOW = at('15:00:00');

// ---------- 日志文件 ----------

test('日志文件：按北京时间分天、只有本人能读、过期删除', () => {
  const dir = tmp();
  let now = new Date(at('23:59:59'));
  const file = createLogFile({ dir, keepDays: 2, now: () => now });
  file.write({ ts: new Date(at('23:59:59')).toISOString(), event: 'a' }); // UTC 还是 15:59，北京已经是 26 号晚上
  file.write({ ts: new Date(at('00:00:01', '2026-11-27')).toISOString(), event: 'b' });
  assert.deepEqual(readdirSync(dir).sort(), ['bot-2026-11-26.jsonl', 'bot-2026-11-27.jsonl']);
  assert.equal(statSync(join(dir, 'bot-2026-11-26.jsonl')).mode & 0o777, 0o600);
  writeFileSync(join(dir, 'alert-2026-11-20.jsonl'), '');
  writeFileSync(join(dir, 'alert-state.json'), '{}');
  now = new Date(at('12:00:00', '2026-11-28'));
  assert.equal(file.prune(), 2); // 留 2 天：27、28 号；26 号和 20 号的删掉，别的文件不动
  assert.deepEqual(readdirSync(dir).sort(), ['alert-state.json', 'bot-2026-11-27.jsonl']);
});

test('日志文件：写不进去不抛错，只说一次', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'blocked'), '');
  const said = [];
  const file = createLogFile({ dir: join(dir, 'blocked'), onError: (t) => said.push(t) });
  file.write({ ts: new Date().toISOString(), event: 'x' });
  file.write({ ts: new Date().toISOString(), event: 'y' });
  assert.equal(said.length, 1);
});

test('loggerFromEnv：设了 LOG_DIR，文件记到 debug，终端还按 LOG_LEVEL', () => {
  const dir = tmp();
  const log = loggerFromEnv({ LOG_DIR: dir, LOG_LEVEL: 'error', LOG_FORMAT: 'json' }, { isTTY: false });
  assert.equal(log.level, 'error');
  log.child({ messageKey: 'k' }).debug('message.ignored', { reason: 'not_addressed' });
  const [name] = readdirSync(dir);
  assert.match(name, /^bot-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const line = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  assert.deepEqual([line.event, line.messageKey, line.level], ['message.ignored', 'k', 'debug']);
  assert.equal(loggerFromEnv({}, { isTTY: false }).pruneFiles(), 0);
});

// ---------- trace：参数 ----------

test('trace 参数：群、QQ、日期、时间', () => {
  const q = parseArgs(['群', '123456', 'QQ', '10001', '昨天', '21:30'], NOW);
  assert.deepEqual([q.mode, q.kind, q.target, q.qq], ['conversation', 'group', '123456', '10001']);
  assert.deepEqual([q.from, q.to], [at('21:20:00', '2026-11-25'), at('21:40:00', '2026-11-25')]);
  const day = parseArgs(['私聊', '10001', '11-24'], NOW);
  assert.deepEqual([day.from, day.to], [at('00:00:00', '2026-11-24'), at('00:00:00', '2026-11-25')]);
  const recent = parseArgs(['群', '1'], NOW);
  assert.deepEqual([recent.from, recent.to], [NOW - 30 * 60_000, NOW]);
  assert.equal(parseArgs([], NOW).mode, 'overview');
  assert.equal(parseArgs(['qq:account:1:conversation:group:2:message:3'], NOW).mode, 'message');
  assert.equal(parseArgs(['12-31'], at('10:00:00', '2027-01-02')).from, at('00:00:00', '2026-12-31')); // 1 月查去年 12 月
  assert.throws(() => parseArgs(['群'], NOW), /号码/);
  assert.throws(() => parseArgs(['私聊', '1', 'QQ', '2'], NOW), /私聊/);
  assert.throws(() => parseArgs(['随便'], NOW), /看不懂/);
});

// ---------- trace：报告 ----------

const ACCOUNT = 'qq:account:999';
const gkey = (id, group = '123456') => `${ACCOUNT}:conversation:group:${group}:message:${id}`;
const rec = (hms, event, fields = {}, day = '2026-11-26') => ({ ts: new Date(at(hms, day)).toISOString(), ms: at(hms, day), level: 'info', event, ...fields });
const said = (hms, id, user, event, fields = {}) => rec(hms, event, { messageKey: gkey(id), sender: `qq:user:${user}`, ...fields });
const logs = (records) => ({ records: records.sort((a, b) => a.ms - b.ms), oldestDay: '2026-11-20' });
const running = [rec('09:00:00', 'bot.started', { version: 'abc1234' }), rec('09:00:01', 'onebot.connected')];

test('trace：一个人说的每一句走到了哪一步', () => {
  const lines = conversationReport(parseArgs(['群', '123456', 'QQ', '10001', '14:05'], NOW), logs([
    ...running,
    said('14:04:12', 1, 10001, 'message.ignored', { level: 'debug', reason: 'not_addressed' }),
    said('14:05:30', 2, 10001, 'message.accepted', { trigger: 'mention' }),
    rec('14:05:38', 'round.started', { messageKeys: [gkey(2)] }),
    said('14:05:48', 2, 10001, 'message.done', { outcome: 'replied', replyMs: 9200 }),
    said('14:06:02', 3, 10001, 'message.accepted', { trigger: 'follow_up' }),
    said('14:06:09', 3, 10001, 'message.done', { outcome: 'model_silent' }),
    said('14:08:40', 4, 10001, 'message.ignored', { level: 'debug', reason: 'group_off' }),
    said('14:07:00', 5, 20002, 'message.accepted', { trigger: 'mention' }), // 别人
    rec('14:07:30', 'message.ignored', { messageKey: gkey(6, '777'), sender: 'qq:user:10001', reason: 'not_addressed' }), // 别的群
  ]), NOW).join('\n');
  assert.match(lines, /当时（13:55:00～14:15:00）/);
  assert.match(lines, /奶蛙在跑 · 连着 SnowLuma · QQ 小号在线/);
  assert.match(lines, /说了 4 句/);
  assert.match(lines, /14:04:12 {2}没叫奶蛙/);
  assert.match(lines, /14:05:30 {2}@ 了奶蛙 → 14:05:38 开始看 → 模型 9\.2 秒 → 发出 ✓/);
  assert.match(lines, /14:06:02 {2}在留意中 → 模型看了，觉得不用回/);
  assert.match(lines, /14:08:40 {2}这个群当时设成了“不说话”/);
});

test('trace：钱花完了、余额不足、发送失败都说得出来', () => {
  const d = (outcome, extra = {}) => describeMessage([said('14:05:30', 1, 1, 'message.accepted', { trigger: 'mention' }), said('14:05:31', 1, 1, 'message.done', { outcome, ...extra })]);
  assert.match(d('budget_exceeded'), /花费到了上限/);
  assert.match(d('fallback', { errorCode: 'INSUFFICIENT_BALANCE' }), /余额不足 → 发了固定提示/);
  assert.match(d('send_failed', { errorCode: 'QUEUE_TIMEOUT', delivery: 'not_sent' }), /发送没成功：排队太久，肯定没发出/);
  assert.match(describeMessage([said('14:00:00', 1, 1, 'message.ignored', { reason: 'at_only' })]), /只回 @/);
  assert.match(describeMessage([said('14:00:00', 1, 1, 'message.skipped', { reason: 'stale' })]), /太旧/);
});

test('trace：查不到消息时说清是掉线、断开、停着还是没记录', () => {
  const q = parseArgs(['群', '123456', 'QQ', '10001', '昨天', '21:30'], NOW);
  const offline = conversationReport(q, logs([
    rec('20:00:00', 'bot.started', {}, '2026-11-25'), rec('20:00:01', 'onebot.connected', {}, '2026-11-25'),
    rec('21:18:05', 'onebot.bot_offline', { level: 'warn' }, '2026-11-25'), rec('21:52:40', 'onebot.bot_online', {}, '2026-11-25'),
  ]), NOW).join('\n');
  assert.match(offline, /当时（11-25 21:20:00～11-25 21:40:00）：奶蛙在跑 · 连着 SnowLuma · ⚠ QQ 小号离线/);
  assert.match(offline, /这段时间一条都没收到/);
  assert.match(offline, /11-25 21:18:05～11-25 21:52:40 QQ 小号离线，群消息到不了奶蛙/);

  const disconnected = conversationReport(q, logs([
    rec('20:00:00', 'bot.started', {}, '2026-11-25'), rec('20:00:01', 'onebot.connected', {}, '2026-11-25'),
    rec('21:25:00', 'onebot.disconnected', { level: 'warn' }, '2026-11-25'), rec('21:35:00', 'onebot.connected', {}, '2026-11-25'),
  ]), NOW).join('\n');
  assert.match(disconnected, /11-25 21:25:00～11-25 21:35:00 奶蛙和 SnowLuma 断开了/);

  const stopped = conversationReport(q, logs([
    rec('20:00:00', 'bot.started', {}, '2026-11-25'), rec('21:10:00', 'bot.stopping', {}, '2026-11-25'),
    rec('22:05:00', 'bot.started', {}, '2026-11-25'),
  ]), NOW).join('\n');
  assert.match(stopped, /奶蛙没在跑/);

  const quiet = conversationReport(q, logs([
    rec('20:00:00', 'bot.started', {}, '2026-11-25'), rec('20:00:01', 'onebot.connected', {}, '2026-11-25'),
    rec('02:41:00', 'message.ignored', { messageKey: gkey(1, '5') }, '2026-11-26'),
  ]), NOW).join('\n');
  assert.match(quiet, /一行日志都没有（上一行是 11-25 20:00:01，下一行是 02:41:00）/);

  const old = conversationReport(parseArgs(['群', '1', '11-01'], NOW), logs([]), NOW).join('\n');
  assert.match(old, /日志只留 14 天，现在最早的是 2026-11-20/);
});

test('trace：两次启动之间没有退出记录，就是意外退出', () => {
  const { changes } = statusTimeline([
    rec('09:00:00', 'bot.started'), rec('10:30:00', 'message.ignored', { messageKey: gkey(1) }), rec('10:31:09', 'bot.started'),
  ]);
  assert.deepEqual(changes.map((c) => [new Date(c.ms).toISOString(), c.text.slice(0, 6)]), [
    [new Date(at('09:00:00')).toISOString(), '奶蛙启动'],
    [new Date(at('10:30:00')).toISOString(), '奶蛙意外退出'],
    [new Date(at('10:31:09')).toISOString(), '奶蛙启动'],
  ]);
});

test('trace：现在那一行', () => {
  const t = statusTimeline([...running, rec('13:50:00', 'onebot.bot_offline', { level: 'warn' })]);
  const base = { startedAt: new Date(at('09:00:00')), code: { commit: 'abc1234' }, onebot: { connected: true, since: new Date(at('09:00:01')) } };
  assert.match(nowLine(null, t, NOW), /数据库连不上/);
  assert.match(nowLine({ ...base, state: 'running' }, t, NOW), /奶蛙在跑（09:00:00 启动，版本 abc1234） · 连着 SnowLuma · ⚠ QQ 小号 13:50 起离线（已经 1 小时 10 分钟）/);
  assert.match(nowLine({ ...base, state: 'running', onebot: { connected: false, since: new Date(at('14:30:00')) } }, t, NOW), /⚠ 连不上 SnowLuma（14:30 起，已经 30 分钟）/);
  assert.match(nowLine({ state: 'stopped', stoppedAt: new Date(at('14:58:31')) }, t, NOW), /没在跑（14:58:31 正常退出）/);
  assert.match(nowLine({ state: 'unresponsive', heartbeatAt: new Date(at('10:31:00')) }, t, NOW), /没响应/);
});

test('trace：整体情况', () => {
  const [recent, problems] = overviewLines(logs([
    said('14:30:00', 1, 1, 'message.ignored'), said('14:31:00', 2, 1, 'message.accepted'), rec('14:31:05', 'round.started', { messageKeys: [gkey(2)] }),
    said('14:31:10', 2, 1, 'message.done', { outcome: 'replied' }), said('14:40:00', 3, 1, 'send.failed', { level: 'error' }),
    said('13:00:00', 9, 1, 'message.ignored'), // 一小时以前
  ]), NOW);
  assert.equal(recent, '最近 1 小时：收到 3 条群消息，请模型看了 1 轮，回了 1 句');
  assert.match(problems, /发送失败 1 次（最近 14:40:00）/);
});

test('trace：读日志目录，坏行跳过，不读以后的文件', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'bot-2026-11-25.jsonl'), `${JSON.stringify(rec('21:00:00', 'bot.started', {}, '2026-11-25'))}\n{坏的\n`);
  writeFileSync(join(dir, 'bot-2026-11-27.jsonl'), `${JSON.stringify(rec('01:00:00', 'bot.started', {}, '2026-11-27'))}\n`);
  writeFileSync(join(dir, 'alert-state.json'), '{}');
  const { records, oldestDay } = readLogs(dir, { to: NOW });
  assert.deepEqual([records.length, oldestDay], [1, '2026-11-25']);
  assert.deepEqual(readLogs(join(dir, 'nope')).records, []);
});

// ---------- 提醒 ----------

const MIN = 60_000;
const bot = (fields) => ({ state: 'running', startedAt: new Date(NOW - 60 * MIN), heartbeatAt: new Date(NOW), onebot: { connected: true, since: new Date(NOW - 60 * MIN) }, ...fields });
const run = (state, seen, now) => decide(state, checkResults(seen, now), now);
const texts = (r) => r.messages.map((m) => m.text);

test('提醒：问题持续 5 分钟才说，只说一次，好了再说一声', () => {
  let r = run({}, { qq: { online: false } }, NOW);
  assert.deepEqual(r.messages, []); // 刚发现
  r = run(r.state, { qq: { online: false } }, NOW + 5 * MIN);
  assert.match(texts(r)[0], /QQ 小号 15:00 起离线，去 noVNC 重新扫码/);
  markSent(r.state, r.messages);
  r = run(r.state, { qq: { online: false } }, NOW + 10 * MIN);
  assert.deepEqual(r.messages, []); // 不重复
  r = run(r.state, { qq: { online: true } }, NOW + 15 * MIN);
  assert.match(texts(r)[0], /QQ 小号 15:15 恢复在线/);
  assert.deepEqual(r.state, {});
});

test('提醒：没发出去就不记成已提醒，下一轮再发；没提醒过的好了不说', () => {
  let r = run({}, { qq: { online: false } }, NOW);
  r = run(r.state, { qq: { online: false } }, NOW + 6 * MIN);
  assert.equal(r.messages.length, 1);
  r = run(r.state, { qq: { online: false } }, NOW + 11 * MIN); // 上一轮没 markSent
  assert.equal(r.messages.length, 1);
  r = run({}, { qq: { online: false } }, NOW);
  r = run(r.state, { qq: { online: true } }, NOW + MIN); // 1 分钟就好了：不打扰
  assert.deepEqual(r.messages, []);
});

test('提醒：主动停机不打扰，意外停机才通知；连不上 SnowLuma、数据库也提醒', () => {
  const stopped = { state: 'stopped', stoppedAt: new Date(NOW - 60 * MIN), heartbeatAt: new Date(NOW - 60 * MIN) };
  assert.deepEqual(run({}, { bot: stopped }, NOW).messages, []);
  const dead = { state: 'unresponsive', heartbeatAt: new Date(NOW - 6 * MIN), onebot: { connected: true } };
  assert.match(texts(run({}, { bot: dead }, NOW))[0], /14:54 起意外停了/); // 心跳停了 6 分钟：从心跳停的时候算
  const off = bot({ onebot: { connected: false, since: new Date(NOW - 7 * MIN) } });
  assert.match(texts(run({}, { bot: off }, NOW))[0], /14:53 起连不上 SnowLuma/);
  let r = run({}, { bot: null }, NOW);
  r = run(r.state, { bot: null }, NOW + 5 * MIN);
  assert.match(texts(r)[0], /连不上数据库/);
  assert.deepEqual(run({}, { bot: bot({}) }, NOW).messages, []);
});

test('提醒：SnowLuma 没响应时 QQ 小号那一项不动', () => {
  let r = run({}, { qq: { online: false } }, NOW);
  r = run(r.state, { qq: null }, NOW + 6 * MIN);
  assert.ok(r.state.qq_offline, 'QQ 离线的记录还在');
  assert.ok(r.state.snowluma_down);
});

test('提醒：备份、花费上限、余额', () => {
  const fresh = { latest: { file: 'naiwa-pg-20261126-040000.dump', at: NOW - 3_600_000 }, drill: { file: 'naiwa-pg-20261126-040000.dump', ok: true } };
  assert.deepEqual(run({}, { backups: fresh }, NOW).messages, []);
  const stale = { latest: { file: 'a', at: NOW - 40 * 3_600_000 }, drill: null };
  assert.match(texts(run({}, { backups: stale }, NOW))[0], /超过一天半没有新备份/);
  const failed = { ...fresh, drill: { ...fresh.drill, ok: false } };
  assert.match(texts(run({}, { backups: failed }, NOW))[0], /恢复演练失败/);
  assert.match(texts(run({}, { budget: { spent: 20.1, budget: 20 } }, NOW))[0], /今天花到 20 元上限了/);
  assert.deepEqual(run({}, { budget: { spent: 99, budget: 0 } }, NOW).messages, []); // 0 是不限
  assert.match(texts(run({}, { balance: { available: true, totalCny: 38 }, balanceCny: 50 }, NOW))[0], /余额只剩 ¥38\.00/);
  const empty = texts(run({}, { balance: { available: false, totalCny: 0 } }, NOW));
  assert.equal(empty.length, 2);
  assert.match(empty[0], /余额用完了/);
  let r = run({}, { balance: { available: false, totalCny: 0 } }, NOW);
  markSent(r.state, r.messages);
  r = run(r.state, { balance: { available: true, totalCny: 200 } }, NOW + MIN);
  assert.deepEqual(texts(r), ['✓ 奶蛙：DeepSeek 余额恢复到 ¥200.00']); // 充值以后只说一句
});

test('提醒：Bark 地址只取到 key', () => {
  assert.equal(barkEndpoint('https://api.day.app/AbC123/这里改成你自己的推送内容'), 'https://api.day.app/AbC123');
  assert.equal(barkEndpoint('https://api.day.app/AbC123/'), 'https://api.day.app/AbC123');
  assert.throws(() => barkEndpoint('https://api.day.app/'), /key/);
});

test('提醒的话里没有群号和 QQ 号', () => {
  const all = checkResults({
    qq: { online: false }, bot: { state: 'unresponsive', heartbeatAt: new Date(NOW - 9 * MIN) },
    backups: { latest: null, drill: null }, budget: { spent: 30, budget: 20 }, balance: { available: false, totalCny: 0 },
  }, NOW);
  for (const res of all) {
    if (res.bad) assert.doesNotMatch(res.text(NOW - 9 * MIN), /\d{5,}/);
  }
});

// ---------- 到期清理 ----------

test('花费表、事件表留 90 天', async () => {
  const db = await testDb();
  const tenantId = `t-${randomUUID()}`;
  const ledger = new ModelUsageLedger({ db, tenantId });
  const now = new Date(at('12:00:00'));
  await ledger.record({ at: new Date(now.getTime() - 89 * 86_400_000), conversationKey: 'c', model: 'm', costCny: 1 });
  await ledger.record({ at: new Date(now.getTime() - 91 * 86_400_000), conversationKey: 'c', model: 'm', costCny: 1 });
  assert.equal(await ledger.prune({ keepDays: 90, at: now }), 1);
  assert.equal(await ledger.prune({ keepDays: 90, at: now }), 0);

  const events = new EventStore(db, { tenantId });
  await events.append({ kind: 'system.started', payload: {} });
  const old = await events.append({ kind: 'system.started', payload: {} });
  await db.query(`UPDATE events SET ts = now() - interval '91 days' WHERE id = $1`, [old.id]);
  assert.equal(await events.prune({ keepDays: 90 }), 1);
  assert.equal(await events.count(), 1);
});

// 测试用的临时目录用完删掉。
after(() => {
  for (const name of readdirSync(tmpdir())) if (name.startsWith('naiwa-ops-')) rmSync(join(tmpdir(), name), { recursive: true, force: true });
});
