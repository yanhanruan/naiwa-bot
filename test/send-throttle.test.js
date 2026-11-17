import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { SendThrottle } from '../src/adapters/send-throttle.js';

// 用真实时间、很小的间隔测试。计时器只会晚到不会早到，所以只断言下限。
const MARGIN = 5;

function recorder() {
  const starts = [];
  const task = (name, ms = 0) => async () => {
    starts.push({ name, at: Date.now() });
    if (ms) await sleep(ms);
    return name;
  };
  return { starts, task };
}

test('按顺序逐条发送，相邻两条至少间隔 minIntervalMs', async () => {
  const throttle = new SendThrottle({ minIntervalMs: 60, jitterMs: 0 });
  const { starts, task } = recorder();
  const results = await Promise.all(['a', 'b', 'c'].map((n) => throttle.schedule(task(n))));
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(starts.map((s) => s.name), ['a', 'b', 'c']);
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i].at - starts[i - 1].at >= 60 - MARGIN);
});

test('上一条发完才开始下一条（不会并发发送）', async () => {
  const throttle = new SendThrottle({ minIntervalMs: 0, jitterMs: 0 });
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(15);
    active -= 1;
  };
  await Promise.all([1, 2, 3].map(() => throttle.schedule(task)));
  assert.equal(maxActive, 1);
});

test('随机间隔：jitterMs 加在 minIntervalMs 之上', async () => {
  const throttle = new SendThrottle({ minIntervalMs: 20, jitterMs: 100, random: () => 0.5 });
  const { starts, task } = recorder();
  await Promise.all(['a', 'b'].map((n) => throttle.schedule(task(n))));
  assert.ok(starts[1].at - starts[0].at >= 70 - MARGIN);
});

test('窗口上限：windowMs 内最多 maxPerWindow 条，多出的等最早一条移出窗口', async () => {
  const throttle = new SendThrottle({ minIntervalMs: 0, jitterMs: 0, maxPerWindow: 2, windowMs: 150 });
  const { starts, task } = recorder();
  await Promise.all(['a', 'b', 'c'].map((n) => throttle.schedule(task(n))));
  assert.ok(starts[1].at - starts[0].at < 150 - MARGIN, '第二条不应被窗口限制');
  assert.ok(starts[2].at - starts[0].at >= 150 - MARGIN);
});

test('队列满了直接拒绝，消息肯定没发出', async () => {
  const throttle = new SendThrottle({ minIntervalMs: 100, jitterMs: 0, maxQueue: 1 });
  const { task } = recorder();
  const first = throttle.schedule(task('a')); // 立刻开始发送，不占队列
  const second = throttle.schedule(task('b')); // 排队中
  await assert.rejects(throttle.schedule(task('c')), { code: 'QUEUE_FULL', delivery: 'not_sent' });
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
});

test('预计排队超过 maxWaitMs 的提前放弃，不白等', async () => {
  const throttle = new SendThrottle({ minIntervalMs: 300, jitterMs: 0, maxWaitMs: 100 });
  const { starts, task } = recorder();
  const first = throttle.schedule(task('a'));
  const startedAt = Date.now();
  await assert.rejects(throttle.schedule(task('b')), { code: 'QUEUE_TIMEOUT', delivery: 'not_sent' });
  assert.ok(Date.now() - startedAt < 250, '应在等待前就放弃');
  await first;
  assert.deepEqual(starts.map((s) => s.name), ['a']);
});

test('某一条发送失败，只影响它自己，后面的照常发送', async () => {
  const throttle = new SendThrottle({ minIntervalMs: 0, jitterMs: 0 });
  const bad = throttle.schedule(async () => { throw new Error('boom'); });
  const good = throttle.schedule(async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
});

test('stop：排队中的全部以 STOPPED 拒绝，之后的也直接拒绝，不留计时器', async () => {
  const throttle = new SendThrottle({ minIntervalMs: 10_000, jitterMs: 0 });
  const { starts, task } = recorder();
  const first = throttle.schedule(task('a'));
  const queued = throttle.schedule(task('b'));
  await first;
  throttle.stop();
  await assert.rejects(queued, { code: 'STOPPED', delivery: 'not_sent' });
  await assert.rejects(throttle.schedule(task('c')), { code: 'STOPPED' });
  assert.deepEqual(starts.map((s) => s.name), ['a']);
});
