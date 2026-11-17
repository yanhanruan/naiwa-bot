import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { estimateCostCny, isPeak, beijingDate } from '../src/model/pricing.js';
import { trimToSentence } from '../src/model/brain.js';
import { ConversationRateLimiter } from '../src/model/rate-limiter.js';
import { ModelUsageLedger } from '../src/model/usage-ledger.js';
import { openStorage } from '../src/storage/index.js';
import { testDb, closeTestDb } from './helpers.js';

// 账本默认在 PGlite 上测；设置 TEST_DATABASE_URL 时也在真实 PostgreSQL 上测（有真正的并发）。
const backends = [{ name: 'PGlite', open: testDb }];
if (process.env.TEST_DATABASE_URL) {
  let pg = null;
  backends.push({ name: 'PostgreSQL', open: () => (pg ??= openStorage({ databaseUrl: process.env.TEST_DATABASE_URL })) });
  after(async () => { if (pg) await (await pg).close(); });
}
after(closeTestDb);

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('高峰时段按北京时间判断：工作日 9–12 点、14–18 点；周末全天空闲', () => {
  const peak = (utc) => isPeak(new Date(utc));
  // 2026-11-17 是周二
  assert.equal(peak('2026-11-17T00:59:59Z'), false); // 08:59:59
  assert.equal(peak('2026-11-17T01:00:00Z'), true); // 09:00
  assert.equal(peak('2026-11-17T03:59:59Z'), true); // 11:59:59
  assert.equal(peak('2026-11-17T04:00:00Z'), false); // 12:00
  assert.equal(peak('2026-11-17T06:00:00Z'), true); // 14:00
  assert.equal(peak('2026-11-17T09:59:59Z'), true); // 17:59:59
  assert.equal(peak('2026-11-17T10:00:00Z'), false); // 18:00
  assert.equal(peak('2026-11-20T09:30:00Z'), true); // 周五 17:30
  assert.equal(peak('2026-11-21T01:30:00Z'), false); // 周六 09:30
  // UTC 还是周五，北京时间已经是周六凌晨：按北京时间算
  assert.equal(peak('2026-11-20T16:30:00Z'), false);
});

test('每日花费按北京时间的日期划分', () => {
  assert.equal(beijingDate(new Date('2026-11-17T15:59:59Z')), '2026-11-17');
  assert.equal(beijingDate(new Date('2026-11-17T16:00:00Z')), '2026-11-18');
});

test('花费估算：缓存命中、未命中、输出分别计价，高峰 token 价格翻倍，搜索和读网页按次计费', () => {
  const usage = { inputTokens: 6400, cachedTokens: 2944, outputTokens: 326, searches: 2, fetches: 1 };
  const offPeakAt = new Date('2026-11-17T10:00:00Z');
  const peakAt = new Date('2026-11-17T02:00:00Z');
  const tokensOffPeak = ((6400 - 2944) * 4.5 + 2944 * 0.15 + 326 * 13.5) / 1e6;
  const offPeak = estimateCostCny({ model: 'deepseek-v4-pro', usage, at: offPeakAt });
  assert.ok(close(offPeak, tokensOffPeak + 0.015), String(offPeak));
  assert.ok(close(offPeak, 0.0353946));
  assert.ok(close(estimateCostCny({ model: 'deepseek-v4-pro', usage, at: peakAt }), tokensOffPeak * 2 + 0.015));
  // 价目表里没有的模型按 v4-pro 估算（宁可偏高）；flash 便宜得多
  assert.equal(estimateCostCny({ model: 'some-new-model', usage, at: offPeakAt }), offPeak);
  const flash = estimateCostCny({ model: 'deepseek-flash', usage, at: offPeakAt });
  assert.ok(close(flash, ((6400 - 2944) * 1 + 2944 * 0.02 + 326 * 4) / 1e6 + 0.015));
});

test('截断的回复保留到最后一个完整句子；完整的部分太短就加省略号', () => {
  assert.equal(trimToSentence('第一句。第二句！第三句没说完'), '第一句。第二句！');
  assert.equal(trimToSentence('完整的一句话。'), '完整的一句话。');
  assert.equal(trimToSentence('短。后面是很长很长很长很长很长的一段没有标点的话'), '短。后面是很长很长很长很长很长的一段没有标点的话…');
  assert.equal(trimToSentence('完全没有标点'), '完全没有标点…');
});

test('会话限速：分钟、小时两个窗口；被拒的不计数，窗口过了就恢复；再次超限会再提示一次', () => {
  let now = 0;
  const limiter = new ConversationRateLimiter({ perMinute: 2, perHour: 3, now: () => now });
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, true);
  assert.deepEqual(limiter.take('a'), { allowed: false, window: 'minute', retryAfterMs: 60_000, notify: true });
  now = 30_000;
  assert.deepEqual(limiter.take('a'), { allowed: false, window: 'minute', retryAfterMs: 30_000, notify: false });
  now = 60_000;
  assert.equal(limiter.take('a').allowed, true); // 第 3 次：分钟窗口已过，小时窗口刚好用满
  now = 130_000;
  const hourly = limiter.take('a');
  assert.deepEqual(hourly, { allowed: false, window: 'hour', retryAfterMs: 3_600_000 - 130_000, notify: true });
  assert.equal(limiter.take('b').allowed, true, '不同会话互不影响');
  now = 3_600_000;
  assert.equal(limiter.take('a').allowed, true, '最早的一次移出小时窗口后恢复');
});

test('会话限速：0 表示不限；跟踪的会话太多时丢掉最久没活动的', () => {
  const unlimited = new ConversationRateLimiter({ perMinute: 0, perHour: 0 });
  for (let i = 0; i < 50; i += 1) assert.equal(unlimited.take('a').allowed, true);

  const limiter = new ConversationRateLimiter({ perMinute: 1, perHour: 0, now: () => 0, maxConversations: 2 });
  limiter.take('a');
  limiter.take('b');
  limiter.take('c'); // 'a' 最久没活动，被丢掉
  assert.equal(limiter.state.size, 2);
  assert.equal(limiter.take('a').allowed, true);
});

const USAGE = { inputTokens: 100, cachedTokens: 40, outputTokens: 10, reasoningTokens: 5, searches: 1, fetches: 0 };

for (const { name, open } of backends) {
  test(`[${name}] 用量账本：按北京时间的日期累计，各会话合计，租户之间隔离`, async () => {
    const db = await open();
    const ledger = new ModelUsageLedger({ db, tenantId: `test-${randomUUID()}` });
    const other = new ModelUsageLedger({ db, tenantId: `test-${randomUUID()}` });
    const lateNight = new Date('2026-11-17T15:59:59Z'); // 北京时间 11-17 23:59:59
    const midnight = new Date('2026-11-17T16:00:00Z'); // 北京时间 11-18 00:00
    await ledger.record({ at: lateNight, conversationKey: 'a', model: 'deepseek-v4-pro', usage: USAGE, costCny: 0.01 });
    await ledger.record({ at: lateNight, conversationKey: 'b', model: 'deepseek-v4-pro', usage: USAGE, costCny: 0.02 });
    await ledger.record({ at: lateNight, conversationKey: 'a', model: 'deepseek-v4-pro', usage: null, costCny: 0.05 });
    await ledger.record({ at: midnight, conversationKey: 'a', model: 'deepseek-v4-pro', usage: USAGE, costCny: 0.5 });
    await other.record({ at: lateNight, conversationKey: 'a', model: 'deepseek-v4-pro', usage: USAGE, costCny: 9 });

    const day = await ledger.day(lateNight);
    assert.equal(day.day, '2026-11-17');
    assert.deepEqual([day.calls, day.unknownCalls, day.inputTokens, day.outputTokens, day.searches], [2, 1, 200, 20, 2]);
    assert.ok(close(day.costCny, 0.08), String(day.costCny));
    assert.ok(close((await ledger.day(midnight)).costCny, 0.5));
    assert.deepEqual(await new ModelUsageLedger({ db, tenantId: `test-${randomUUID()}` }).day(lateNight), {
      day: '2026-11-17', costCny: 0, calls: 0, unknownCalls: 0, inputTokens: 0, outputTokens: 0, searches: 0,
    });
  });

  test(`[${name}] 用量账本：多个进程同时记账不丢计数`, async () => {
    const db = await open();
    const tenantId = `test-${randomUUID()}`;
    const a = new ModelUsageLedger({ db, tenantId });
    const b = new ModelUsageLedger({ db, tenantId });
    const at = new Date('2026-11-17T10:00:00Z');
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).record({
      at, conversationKey: 'same', model: 'deepseek-v4-pro', usage: USAGE, costCny: 0.001,
    })));
    const day = await a.day(at);
    assert.equal(day.calls, 20);
    assert.equal(day.inputTokens, 2000);
    assert.ok(close(day.costCny, 0.02), String(day.costCny));
  });
}
