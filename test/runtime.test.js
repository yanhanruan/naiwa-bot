import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConversationQueue } from '../src/runtime/conversation-queue.js';
import { MessageInbox, MemoryInbox } from '../src/runtime/inbox.js';
import { openStorage } from '../src/storage/index.js';
import { testDb, closeTestDb } from './helpers.js';

// 消息记录默认在 PGlite 上测；设置 TEST_DATABASE_URL 时也在真实 PostgreSQL 上测（有真正的并发）。
const backends = [{ name: 'PGlite', open: testDb }];
if (process.env.TEST_DATABASE_URL) {
  let pg = null;
  backends.push({ name: 'PostgreSQL', open: () => (pg ??= openStorage({ databaseUrl: process.env.TEST_DATABASE_URL })) });
  after(async () => { if (pg) await (await pg).close(); });
}
after(closeTestDb);

test('会话队列：同一会话逐条处理、保持顺序；不同会话并行', async () => {
  const queue = new ConversationQueue({ maxConcurrent: 4, maxPending: 10 });
  const events = [];
  let activeA = 0;
  let maxActiveA = 0;
  const task = (name, conversation, ms) => async () => {
    if (conversation === 'a') maxActiveA = Math.max(maxActiveA, ++activeA);
    events.push(`start ${name}`);
    await sleep(ms);
    events.push(`end ${name}`);
    if (conversation === 'a') activeA -= 1;
    return name;
  };
  const results = await Promise.all([
    queue.run('a', task('a1', 'a', 30)), queue.run('a', task('a2', 'a', 5)), queue.run('b', task('b1', 'b', 5)),
  ]);
  assert.deepEqual(results, ['a1', 'a2', 'b1']);
  assert.equal(maxActiveA, 1, '同一会话同时只处理一条');
  assert.ok(events.indexOf('end a1') < events.indexOf('start a2'), '前一条处理完才开始下一条');
  assert.ok(events.indexOf('end b1') < events.indexOf('end a1'), '另一个会话不必等');
});

test('会话队列：同时处理的会话数有上限；多个会话在等时轮流来', async () => {
  const queue = new ConversationQueue({ maxConcurrent: 1, maxPending: 10 });
  const order = [];
  const task = (name) => async () => {
    order.push(name);
    await sleep(2);
  };
  await Promise.all([queue.run('a', task('a1')), queue.run('a', task('a2')), queue.run('b', task('b1')), queue.run('b', task('b2'))]);
  // a1 处理完时 a 还有 a2，但 b 已经在等，所以 b1 先于 a2
  assert.deepEqual(order, ['a1', 'b1', 'a2', 'b2']);
});

test('会话队列：排队条数有上限，满了拒绝（QUEUE_FULL）；关闭后拒绝新任务（CLOSED）', async () => {
  const queue = new ConversationQueue({ maxConcurrent: 1, maxPending: 1 });
  let release;
  const first = queue.run('a', () => new Promise((resolve) => { release = resolve; })); // 正在处理
  const second = queue.run('a', async () => 'second'); // 排队 1 条
  await assert.rejects(queue.run('a', async () => 'third'), { name: 'QueueError', code: 'QUEUE_FULL' });
  const other = queue.run('b', async () => 'other'); // 另一个会话不受这个会话排队上限的影响
  release('first');
  assert.deepEqual(await Promise.all([first, second, other]), ['first', 'second', 'other']);
  assert.equal(queue.size, 0);
  const closing = queue.close(1000);
  await assert.rejects(queue.run('a', async () => 'late'), { code: 'CLOSED' });
  assert.equal(await closing, 0);
});

test('会话队列：某条任务出错只影响它自己，后面的照常处理', async () => {
  const queue = new ConversationQueue();
  const bad = queue.run('a', async () => { throw new Error('boom'); });
  const good = queue.run('a', async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
});

test('会话队列：关闭时等已经接收的处理完；超时就不再等，返回没处理完的条数', async () => {
  const queue = new ConversationQueue();
  const done = queue.run('a', () => sleep(30));
  assert.equal(await queue.close(1000), 0);
  await done;

  const slow = new ConversationQueue();
  const tasks = [slow.run('a', () => sleep(200)), slow.run('a', () => sleep(200))];
  const startedAt = Date.now();
  assert.equal(await slow.close(50), 2);
  assert.ok(Date.now() - startedAt < 180, '超时后不应继续等');
  await Promise.all(tasks);
});

const msg = (key, conversationKey = 'conv') => ({ key, conversation: { key: conversationKey }, ts: Date.now() });

for (const { name, open } of backends) {
  test(`[${name}] 消息记录：同一条消息只认领一次，同时到达几次也只有一次成功`, async () => {
    const inbox = new MessageInbox({ db: await open(), tenantId: `test-${randomUUID()}` });
    const results = await Promise.all([inbox.claim(msg('k1')), inbox.claim(msg('k1')), inbox.claim(msg('k1'))]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await inbox.claim(msg('k1')), false);
    assert.equal((await inbox.get('k1')).status, 'queued');
  });

  test(`[${name}] 消息记录：如实记录结果；超过去重窗口的旧记录可以重新认领`, async () => {
    const db = await open();
    const tenantId = `test-${randomUUID()}`;
    const inbox = new MessageInbox({ db, tenantId });
    await inbox.claim(msg('k2'));
    await inbox.update('k2', { status: 'processing' });
    await inbox.update('k2', { status: 'send_failed', outcome: 'send_failed', errorCode: 'TIMEOUT', delivery: 'unknown', sendAttempts: 1 });
    assert.deepEqual(await inbox.get('k2'), {
      messageKey: 'k2', conversationKey: 'conv', status: 'send_failed', outcome: 'send_failed',
      errorCode: 'TIMEOUT', delivery: 'unknown', sentMessageId: undefined, sendAttempts: 1,
    });
    // 改成 25 小时前收到的：已超过 24 小时的去重窗口（消息编号可能被重新使用）
    await db.query(`UPDATE inbound_messages SET received_at = now() - interval '25 hours' WHERE tenant_id = $1`, [tenantId]);
    assert.equal(await inbox.claim(msg('k2')), true);
    assert.deepEqual(await inbox.get('k2'), {
      messageKey: 'k2', conversationKey: 'conv', status: 'queued', outcome: undefined,
      errorCode: undefined, delivery: undefined, sentMessageId: undefined, sendAttempts: 0,
    });
  });

  test(`[${name}] 消息记录：启动时把没处理完的标为中断；清理旧记录；租户之间隔离`, async () => {
    const db = await open();
    const tenantId = `test-${randomUUID()}`;
    const inbox = new MessageInbox({ db, tenantId });
    const other = new MessageInbox({ db, tenantId: `test-${randomUUID()}` });
    for (const key of ['queued', 'processing', 'done']) await inbox.claim(msg(key));
    await inbox.update('processing', { status: 'processing' });
    await inbox.update('done', { status: 'replied', outcome: 'replied', sentMessageId: 123, sendAttempts: 1 });
    await other.claim(msg('queued'));

    assert.equal(await inbox.recoverInterrupted(), 2);
    assert.deepEqual([(await inbox.get('queued')).status, (await inbox.get('queued')).outcome], ['abandoned', 'interrupted']);
    assert.equal((await inbox.get('processing')).status, 'abandoned');
    assert.deepEqual([(await inbox.get('done')).status, (await inbox.get('done')).sentMessageId], ['replied', '123']);
    assert.equal((await other.get('queued')).status, 'queued', '其他租户不受影响');

    await db.query(`UPDATE inbound_messages SET received_at = now() - interval '31 days' WHERE tenant_id = $1 AND message_key = 'done'`, [tenantId]);
    assert.equal(await inbox.prune(), 1);
    assert.equal(await inbox.get('done'), null);
    assert.notEqual(await inbox.get('queued'), null);
  });
}

test('内存版消息记录：接口相同；去重窗口过后可以重新认领；条数有上限', async () => {
  let now = 0;
  const inbox = new MemoryInbox({ now: () => now, dedupeWindowMs: 1000, maxEntries: 2 });
  assert.equal(await inbox.claim(msg('a')), true);
  assert.equal(await inbox.claim(msg('a')), false);
  await inbox.update('a', { status: 'replied', sentMessageId: 5, sendAttempts: 1 });
  assert.deepEqual(await inbox.get('a'), {
    messageKey: 'a', conversationKey: 'conv', status: 'replied', sentMessageId: '5', sendAttempts: 1,
  });
  now = 1000;
  assert.equal(await inbox.claim(msg('a')), true, '超过去重窗口后可以重新认领');
  await inbox.claim(msg('b'));
  await inbox.claim(msg('c'));
  assert.equal(await inbox.get('a'), null, '超过条数上限时丢掉最早的');
  assert.equal(await inbox.recoverInterrupted(), 0);
});
