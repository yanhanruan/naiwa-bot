import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fish, scope, normalizeVideo } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// 用 workspace 内的临时目录，保证 sandbox 下可写。
function tmpHome() {
  return mkdtempSync(join(root, '.tmp-test-'));
}

// 测试结束清理临时目录，避免 .tmp-test-* 堆积
after(() => {
  for (const d of readdirSync(root)) {
    if (d.startsWith('.tmp-test-')) rmSync(join(root, d), { recursive: true, force: true });
  }
});

test('验收1：连续对话保持稳定人格，情绪随事件自然变化', () => {
  const fish = new Fish({
    home: tmpHome(),
    name: '小渔',
    persona: { core: '温柔好奇的小鱼', style: '爱用波浪线' },
  }).start();

  const before = fish.bridge.getCharacterState();
  const v0 = before.mood.valence;

  fish.reactTo({
    platform: 'qq',
    kind: 'message.received',
    actor: 'peerA',
    payload: { text: '你好呀', sentiment: 'positive', mentionsSelf: true },
  });

  const after = fish.bridge.getCharacterState();
  assert.equal(after.name, '小渔');
  assert.equal(after.persona.core, '温柔好奇的小鱼');
  assert.ok(after.mood.valence > v0, '正向事件后 valence 应上升');
  assert.equal(after.persona.style, '爱用波浪线');
  fish.stop();
});

test('验收2：重启（重新实例化）后能恢复长期记忆与角色状态', () => {
  const home = tmpHome();
  const f1 = new Fish({ home, name: '小渔' }).start();
  f1.remember({ type: 'episodic', content: '用户说自己最喜欢鲸鱼，尤其是蓝鲸', access: 'public', tags: ['鲸鱼'] });
  f1.character.growInterest('鲸鱼', 0.5);
  f1.stop();

  const f2 = new Fish({ home, name: '小渔' }).start();
  const hits = f2.recall({ query: '鲸鱼', requester: 'self' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /鲸鱼/);

  const st = f2.bridge.getCharacterState();
  assert.equal(st.name, '小渔');
  assert.ok(st.interests.some((i) => i.topic === '鲸鱼'));
  f2.stop();
});

test('验收5：所有跨平台事件具有统一数据结构', () => {
  const fish = new Fish({ home: tmpHome() }).start();
  const ev = fish.reactTo({
    platform: 'bilibili',
    kind: 'message.received',
    actor: 'u1',
    payload: { text: 'x' },
  });
  for (const k of ['id', 'ts', 'platform', 'kind', 'actor', 'target', 'payload', 'privacy', 'meta']) {
    assert.ok(k in ev, `缺少字段 ${k}`);
  }
  assert.equal(ev.platform, 'bilibili');
  assert.equal(ev.kind, 'message.received');
  assert.equal(ev.actor, 'u1');
  fish.stop();
});

test('验收6：未经批准不能执行发布或私信', () => {
  const fish = new Fish({ home: tmpHome() }).start();

  const publish = fish.bridge.act({ type: 'publish', platform: 'bilibili', target: '评论', text: '好想看' });
  assert.equal(publish.ok, false);
  assert.equal(publish.approved, false);
  assert.ok(publish.pendingApprovalId, '应返回待审批 id');

  const ap = fish.bridge.approve(publish.pendingApprovalId);
  assert.equal(ap.ok, true);

  // 最小权限：每次发布仍需独立审批
  const publish2 = fish.bridge.act({ type: 'publish', platform: 'bilibili', target: '评论', text: 'again' });
  assert.equal(publish2.ok, false);
  assert.ok(publish2.pendingApprovalId);

  // 私信默认也需审批
  const dm = fish.bridge.act({ type: 'dm', platform: 'qq', target: 'peerA', text: 'hi' });
  assert.equal(dm.ok, false);
  assert.equal(dm.reason, 'dm-requires-approval');
  fish.stop();
});

test('主动行为受总开关控制，关闭时不触发', () => {
  const fish = new Fish({ home: tmpHome() }).start();
  let calls = 0;
  fish.schedule({ id: 'browse', intervalMs: 0, fn: () => { calls += 1; return 'browsed'; } });

  assert.equal(fish.policy.proactiveEnabled, false);
  assert.deepEqual(fish.proactiveTick(), []);
  assert.equal(calls, 0);

  fish.policy.setProactiveEnabled(true);
  const res = fish.proactiveTick();
  assert.equal(res.length, 1);
  assert.equal(calls, 1);
  fish.stop();
});

test('验收7：记忆可导出与删除', () => {
  const fish = new Fish({ home: tmpHome() }).start();
  const a = fish.remember({ type: 'semantic', content: '地球的海洋面积约占 71%', access: 'public' });
  const b = fish.remember({ type: 'episodic', content: '今天下午用户带我去晒了太阳', access: 'self' });
  assert.ok(a.added && b.added);

  const exported = fish.memory.export({ requester: 'self' });
  assert.equal(exported.length, 2);

  const del = fish.memory.deleteAll('self');
  assert.equal(del.deleted, 2);
  assert.equal(fish.memory.count(), 0);
  fish.stop();
});

test('隐私隔离：私有记忆不跨用户泄露', () => {
  const fish = new Fish({ home: tmpHome() }).start();
  fish.remember({ type: 'episodic', content: 'A 告诉我他家的秘密', access: scope.private('A'), peers: ['A'] });
  fish.remember({ type: 'episodic', content: '大家都知道的公开信息', access: 'public', peers: [] });

  const asA = fish.recall({ requester: 'A' });
  const asB = fish.recall({ requester: 'B' });

  assert.ok(asA.some((r) => r.content.includes('A 告诉我')));
  assert.ok(!asB.some((r) => r.content.includes('A 告诉我')));
  assert.ok(asB.some((r) => r.content.includes('公开信息')));
  fish.stop();
});

test('验收8：Character OS Bridge 返回结构化角色状态', () => {
  const fish = new Fish({ home: tmpHome() }).start();
  const st = fish.bridge.getStatus();
  assert.equal(typeof st.character.mood.valence, 'number');
  assert.equal(typeof st.character.mood.label, 'string');
  assert.equal(typeof st.policy.proactiveEnabled, 'boolean');
  assert.equal(typeof st.memory.count, 'number');
  assert.equal(typeof st.events.count, 'number');
  fish.stop();
});

test('记忆去重：重复内容不重复入库', () => {
  const fish = new Fish({ home: tmpHome() }).start();
  const r1 = fish.remember({ type: 'episodic', content: '同一件事重复发生' });
  const r2 = fish.remember({ type: 'episodic', content: '同一件事重复发生' });
  assert.equal(r1.added, true);
  assert.equal(r2.added, false);
  assert.equal(fish.memory.count(), 1);
  fish.stop();
});

test('关系记忆：互动被记录且不影响他人', () => {
  const fish = new Fish({ home: tmpHome() }).start();
  fish.touch('peerA', { name: '小明', deltaSentiment: 0.2, note: '很友好' });
  fish.touch('peerA', { deltaSentiment: 0.1 });
  const rel = fish.character.getRelationship('peerA');
  assert.equal(rel.interactions, 2);
  assert.ok(rel.sentiment > 0);
  const st = fish.bridge.getCharacterState();
  assert.ok(st.relationships.some((r) => r.peerId === 'peerA'));
  fish.stop();
});

test('B站内容归一化为统一结构（只读，无鉴权）', () => {
  const v = normalizeVideo({
    bvid: 'BV1xx',
    title: '测试<em class="keyword">视频</em>',
    author: 'UP主',
    play: 123,
    like: 4,
    video_review: 5,
    review: 6,
    pubdate: 1700000000,
  });
  assert.equal(v.platform, 'bilibili');
  assert.equal(v.kind, 'content.video');
  assert.equal(v.title, '测试视频');
  assert.equal(v.author, 'UP主');
  assert.equal(v.stats.view, 123);
  assert.equal(v.stats.danmaku, 5);
  assert.equal(v.url, 'https://www.bilibili.com/video/BV1xx');
  assert.equal(v.publishedAt, 1700000000000);
});

test('ingestContent 产生统一 content.read 事件（不产生写操作）', () => {
  const fish = new Fish({ home: tmpHome() }).start();
  const evs = fish.ingestContent([
    { platform: 'bilibili', id: 'bilibili:video:BV1xx', title: 'T', author: 'A', url: 'u', stats: { view: 1 } },
  ]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'content.read');
  assert.equal(evs[0].platform, 'bilibili');
  assert.equal(evs[0].target, 'bilibili:video:BV1xx');
  assert.equal(evs[0].privacy, 'self');
  fish.stop();
});

test('observe 写入自我记忆', () => {
  const fish = new Fish({ home: tmpHome() }).start();
  const r = fish.observe('在 B站 看到一条关于鲸鱼的视频，很感兴趣');
  assert.equal(r.added, true);
  assert.equal(r.record.type, 'self');
  assert.equal(r.record.access, 'self');
  fish.stop();
});
