import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Mood, MOOD_LEVELS, moodDay, drawBase } from '../src/mood/mood.js';
import { loadMoodTexts, moodSection, extractMoodTags } from '../src/mood/prompt.js';
import { testDb, closeTestDb } from './helpers.js';

after(closeTestDb);

const HOUR = 3_600_000;
// 2026-11-24 10:00 北京时间
const T0 = Date.parse('2026-11-24T02:00:00Z');

async function setup({ base } = {}) {
  const clock = { t: T0 };
  const mood = new Mood({ db: await testDb(), tenantId: `mood-${randomUUID()}`, now: () => clock.t });
  if (base) await mood.set(base);
  return { mood, clock };
}
const nudge = (mood, direction, person, conversation = 'g1') => mood.nudge(direction, { personKey: person, conversationKey: conversation });

test('换天：北京时间早上 5 点', () => {
  assert.equal(moodDay(Date.parse('2026-11-23T20:59:59Z')), '2026-11-23'); // 北京 04:59
  assert.equal(moodDay(Date.parse('2026-11-23T21:00:00Z')), '2026-11-24'); // 北京 05:00
});

test('抽基调：同一天结果固定；平常最多、很低落最少；昨天负面的今天不负面', () => {
  assert.equal(drawBase({ tenantId: 'a', day: '2026-11-24' }), drawBase({ tenantId: 'a', day: '2026-11-24' }));
  const count = new Map(MOOD_LEVELS.map((l) => [l.value, 0]));
  for (let i = 0; i < 4000; i += 1) {
    const base = drawBase({ tenantId: `t${i}`, day: '2026-11-24' });
    count.set(base, count.get(base) + 1);
  }
  const share = (v) => count.get(v) / 4000;
  assert.ok(share(0) > 0.45 && share(0) < 0.65, `平常 ${share(0)}`);
  assert.ok(share(-2) < share(-1) && share(-2) < share(2), '很低落最少');
  for (let i = 0; i < 500; i += 1) assert.ok(drawBase({ tenantId: `t${i}`, day: '2026-11-25', previousBase: -1 }) >= 0);
});

test('今天第一次读时抽基调，之后不变；第二天重新抽，起伏清零，记下昨天的基调', async () => {
  const { mood, clock } = await setup();
  const first = await mood.current();
  assert.equal(first.drawn, true);
  assert.equal(first.ripple, 0);
  assert.equal((await mood.current()).drawn, false);
  await nudge(mood, 1, 'p1');
  clock.t += 24 * HOUR;
  const next = await mood.current();
  assert.deepEqual([next.drawn, next.ripple, next.manual, next.day], [true, 0, false, '2026-11-25']);
});

test('昨天是负面的（包括手动改的），今天不会再负面', async () => {
  for (let i = 0; i < 20; i += 1) {
    const { mood, clock } = await setup({ base: '有点低落' });
    clock.t += 24 * HOUR;
    assert.ok((await mood.current()).base >= 0);
  }
});

test('起伏：一次挪 0.25，两次就换一档（隔一会儿也算）；最多离基调一档', async () => {
  const { mood, clock } = await setup({ base: '平常' });
  assert.equal((await nudge(mood, -1, 'p1')).level, 0);
  clock.t += 10 * 60_000;
  assert.equal((await nudge(mood, -1, 'p2', 'g2')).level, -1, '隔 10 分钟第二次，挪到有点低落');
  await nudge(mood, -1, 'p3', 'g3');
  await nudge(mood, -1, 'p4', 'g4');
  const r = await nudge(mood, -1, 'p5', 'g5');
  assert.deepEqual([r.ripple, r.level], [-1, -1], '再骂也只差一档');
});

test('起伏不超过 5 档的两头', async () => {
  const { mood } = await setup({ base: '很开心' });
  await nudge(mood, 1, 'p1');
  const r = await nudge(mood, 1, 'p2', 'g2');
  assert.equal(r.level, 2);
});

test('防刷：同一个人一小时只算一次；同一个会话一小时最多算 3 次', async () => {
  const { mood, clock } = await setup({ base: '平常' });
  assert.equal((await nudge(mood, -1, 'p1')).counted, true);
  const again = await nudge(mood, -1, 'p1', 'g2');
  assert.deepEqual([again.counted, again.reason], [false, 'person']);
  await nudge(mood, -1, 'p2');
  await nudge(mood, -1, 'p3');
  const fourth = await nudge(mood, -1, 'p4');
  assert.deepEqual([fourth.counted, fourth.reason], [false, 'conversation']);
  clock.t += HOUR;
  assert.equal((await nudge(mood, -1, 'p1')).counted, true, '过了一小时又算了');
});

test('回落：每 2 小时离基调的距离减半', async () => {
  const { mood, clock } = await setup({ base: '平常' });
  await nudge(mood, 1, 'p1');
  await nudge(mood, 1, 'p2', 'g2');
  assert.equal((await mood.current()).level, 1);
  clock.t += 2 * HOUR;
  const later = await mood.current();
  assert.ok(Math.abs(later.ripple - 0.25) < 1e-9);
  assert.equal(later.level, 0, '缓回平常');
});

test('挪满以后大约两个半小时才缓回基调', async () => {
  const { mood, clock } = await setup({ base: '平常' });
  for (const p of ['p1', 'p2', 'p3']) await nudge(mood, 1, p, p);
  await nudge(mood, 1, 'p4', 'p4');
  clock.t += 2.5 * HOUR;
  assert.equal((await mood.current()).level, 1);
  clock.t += 0.25 * HOUR;
  assert.equal((await mood.current()).level, 0);
});

test('运营改今天的基调；没有这一档就报错', async () => {
  const { mood } = await setup();
  const m = await mood.set('开心');
  assert.deepEqual([m.base, m.manual], [1, true]);
  await assert.rejects(mood.set('暴躁'), /没有这一档心情/);
});

test('心情文件：每一档一个，平常没有', () => {
  const texts = loadMoodTexts(join(dirname(fileURLToPath(import.meta.url)), '..', 'persona', 'moods'));
  assert.deepEqual(Object.keys(texts).sort(), ['开心', '很开心', '很低落', '有点低落'].sort());
  for (const text of Object.values(texts)) assert.match(text, /口癖/);
});

test('给模型看的一段：平常和没有文件的档是空的；离开早上的基调时补一句，不说是谁', () => {
  const texts = { 有点低落: '今天你有点低落。', 开心: '今天你心情不错。' };
  assert.equal(moodSection({ level: 0, base: 0 }, texts), '');
  assert.equal(moodSection({ level: 2, base: 2 }, texts), '');
  assert.equal(moodSection(null, texts), '');
  assert.equal(moodSection({ level: -1, base: -1 }, texts), '## 现在的心情\n今天你有点低落。');
  assert.equal(moodSection({ level: -1, base: 0 }, texts), '## 现在的心情\n今天你有点低落。\n刚才被人说了几句，比早上更蔫一点。');
  assert.equal(moodSection({ level: 1, base: 0 }, texts), '## 现在的心情\n今天你心情不错。\n刚才有人让你挺开心的，比早上好一点。');
});

test('心情那一行：单独一行、写在句子里、全角括号都拿掉；没有就原样返回', () => {
  assert.deepEqual(extractMoodTags('[回 u1]\n呜……好吧\n[心情 变差 u1]'), { text: '[回 u1]\n呜……好吧', tags: [{ direction: -1, alias: 'u1' }] });
  assert.deepEqual(extractMoodTags('嘿嘿谢谢【心情：变好 u2】'), { text: '嘿嘿谢谢', tags: [{ direction: 1, alias: 'u2' }] });
  assert.deepEqual(extractMoodTags('[不回复]\n[心情 变差]'), { text: '[不回复]', tags: [{ direction: -1, alias: null }] });
  assert.deepEqual(extractMoodTags('[心情 变差 u1]'), { text: '', tags: [{ direction: -1, alias: 'u1' }] });
  assert.deepEqual(extractMoodTags('今天心情不错\n\n真的'), { text: '今天心情不错\n\n真的', tags: [] });
});
