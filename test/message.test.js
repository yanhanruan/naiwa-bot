import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fish, entityKey, conversationKey, normalizeOneBotMessage, messageForModel } from '../src/index.js';
import { createQQHandler } from '../src/qq-handler.js';

function event(overrides = {}) {
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: 900, user_id: 101, group_id: 200, message_id: 1, time: 1700000000,
    sender: { nickname: '小甲', card: '甲的群名片' },
    message: [{ type: 'text', data: { text: '你好' } }], ...overrides,
  };
}

test('同号的用户、群、私聊和群聊有不同标识；机器人账号隔离会话', () => {
  assert.notEqual(entityKey('qq', 'user', 100), entityKey('qq', 'group', 100));
  const dm = normalizeOneBotMessage(event({ message_type: 'private', user_id: 200 }));
  const group = normalizeOneBotMessage(event());
  const otherAccount = normalizeOneBotMessage(event({ self_id: 901 }));
  assert.equal(dm.conversation.key, 'qq:account:900:conversation:private:200');
  assert.equal(group.conversation.key, 'qq:account:900:conversation:group:200');
  assert.notEqual(group.conversation.key, otherAccount.conversation.key);
  assert.notEqual(group.key, otherAccount.key);
  assert.equal(group.ts, 1700000000000);
});

test('改名不改变用户身份；同群共享会话，跨群仍是同一用户', () => {
  const first = normalizeOneBotMessage(event());
  const renamed = normalizeOneBotMessage(event({ sender: { nickname: '新名字' } }));
  const another = normalizeOneBotMessage(event({ user_id: 102 }));
  const otherGroup = normalizeOneBotMessage(event({ group_id: 201 }));
  assert.equal(first.sender.key, renamed.sender.key);
  assert.equal(first.sender.key, otherGroup.sender.key);
  assert.notEqual(first.sender.key, another.sender.key);
  assert.equal(first.conversation.key, another.conversation.key);
  assert.notEqual(first.conversation.key, otherGroup.conversation.key);
  assert.equal(first.sender.displayName, '甲的群名片');
  assert.equal(renamed.sender.displayName, '新名字');
});

test('相同投递具有稳定消息 key；消息 ID 可为 0 或负数', () => {
  const first = normalizeOneBotMessage(event({ message_id: 0 }));
  assert.equal(first.key, normalizeOneBotMessage(event({ message_id: '0' })).key);
  assert.notEqual(first.key, normalizeOneBotMessage(event({ message_id: -1 })).key);
  assert.notEqual(first.key, normalizeOneBotMessage(event({ message_id: 0, group_id: 201 })).key);
});

test('标识分段转义防止分隔符碰撞；拒绝已丢失精度的 number', () => {
  assert.notEqual(entityKey('qq', 'user', 'a:b'), entityKey('qq', 'user', 'a%3Ab'));
  assert.throws(() => entityKey('qq', 'user', Number.MAX_SAFE_INTEGER + 1), /safe integer/);
  assert.equal(entityKey('qq', 'user', '9007199254740993'), 'qq:user:9007199254740993');
});

test('保留消息段顺序、@、引用与非文本内容，不修改上游事件', () => {
  const input = event({ message_id: 2, message: [
    { type: 'reply', data: { id: '-1' } },
    { type: 'at', data: { qq: '900' } },
    { type: 'text', data: { text: ' 看这个 ' } },
    { type: 'image', data: { file: 'a.jpg', extension: { flag: true } } },
    { type: 'at', data: { qq: 'all' } },
  ] });
  const normalized = normalizeOneBotMessage(input);
  assert.deepEqual(normalized.segments.map((s) => s.type), ['reply', 'mention', 'text', 'opaque', 'mention']);
  assert.equal(normalized.segments[0].messageKey, 'qq:account:900:conversation:group:200:message:-1');
  assert.equal(normalized.segments[1].userKey, 'qq:user:900');
  assert.equal(normalized.mentionsSelf, true);
  assert.equal(normalized.text, ' 看这个 ');
  normalized.segments[3].data.extension.flag = false;
  assert.equal(input.message[3].data.extension.flag, true);
  const modelInput = JSON.parse(messageForModel(normalized));
  assert.deepEqual(modelInput.segments[3], { type: 'uninterpreted', sourceType: 'image' });
});

test('CQ 字符串与等价数组归一化后相同，转义只解码一次', () => {
  const string = '[CQ:reply,id=-1][CQ:at,qq=900]你好&#91;世界&#93;&amp;[CQ:image,file=a&#44;b=x.jpg]';
  const array = [
    { type: 'reply', data: { id: '-1' } }, { type: 'at', data: { qq: '900' } },
    { type: 'text', data: { text: '你好[世界]&' } }, { type: 'image', data: { file: 'a,b=x.jpg' } },
  ];
  assert.deepEqual(normalizeOneBotMessage(event({ message: string })), normalizeOneBotMessage(event({ message: array })));
  const literal = normalizeOneBotMessage(event({ message: '&#91;CQ:at,qq=900&#93; &amp;#91; &#44;' }));
  assert.equal(literal.mentionsSelf, false);
  assert.equal(literal.text, '[CQ:at,qq=900] &#91; &#44;');
  const alreadyDecoded = normalizeOneBotMessage(event({ message: [{ type: 'text', data: { text: '&#91;' } }] }));
  assert.equal(alreadyDecoded.text, '&#91;');
});

test('@全体不等于单独@机器人；普通文本中的 CQ 字样不解析', () => {
  const message = normalizeOneBotMessage(event({ message: [
    { type: 'at', data: { qq: 'all' } },
    { type: 'text', data: { text: '[CQ:at,qq=900]' } },
  ] }));
  assert.equal(message.mentionsSelf, false);
  assert.deepEqual(message.segments[0], { type: 'mention', target: 'all' });
});

test('缺少昵称仍有稳定身份；sender 缓存不能覆盖事件发言者', () => {
  const unknown = normalizeOneBotMessage(event({ sender: undefined }));
  assert.equal(unknown.sender.displayName, null);
  assert.equal(unknown.sender.key, 'qq:user:101');
  const stale = normalizeOneBotMessage(event({ sender: { user_id: 999, nickname: '甲' } }));
  assert.equal(stale.sender.id, '101');
  const privateMessage = normalizeOneBotMessage(event({ message_type: 'private', sub_type: 'friend' }));
  assert.equal(privateMessage.sender.displayName, '小甲');
  assert.equal(privateMessage.sender.card, null);
});

test('忽略非消息、匿名、系统提示和机器人自己的消息；不将匿名占位号记成真实用户', () => {
  for (const input of [null, {}, event({ post_type: 'notice' }), event({ message_type: 'guild' }),
    event({ sub_type: 'anonymous' }), event({ anonymous: { id: 3, name: '匿名' } }), event({ sub_type: 'notice' }),
    event({ user_id: 900 }), event({ message_type: 'private', user_id: '900' })]) {
    assert.equal(normalizeOneBotMessage(input), null);
  }
});

test('缺少路由身份、时间或消息结构损坏，必须明确拒绝', () => {
  for (const override of [
    { self_id: undefined }, { user_id: null }, { group_id: '' }, { message_id: {} },
    { time: undefined }, { time: Infinity }, { message: null }, { message: [null] },
    { message: [{ data: {} }] }, { message: [{ type: 'at', data: 'x' }] },
  ]) assert.throws(() => normalizeOneBotMessage(event(override)), TypeError);
});

test('单个已知消息段字段损坏只降级该段，正文仍保留', () => {
  const message = normalizeOneBotMessage(event({ message: [
    { type: 'reply', data: { id: null } }, { type: 'at', data: { qq: '' } },
    { type: 'text', data: {} }, { type: 'text', data: { text: '正文还在' } },
  ] }));
  assert.deepEqual(message.segments.slice(0, 3).map((s) => [s.type, s.sourceType, s.invalid]),
    [['opaque', 'reply', true], ['opaque', 'at', true], ['opaque', 'text', true]]);
  assert.equal(message.text, '正文还在');
  assert.equal(message.mentionsSelf, false);
});

test('@ 段保留显示名；模型信封精简但仍区分发言者和引用目标', () => {
  const message = normalizeOneBotMessage(event({ message_id: 5,
    message: '[CQ:reply,id=3][CQ:at,qq=102,name=小乙][CQ:at,qq=103]看' }));
  assert.equal(message.segments[1].name, '小乙');
  assert.equal(message.segments[2].name, null);
  const envelope = JSON.parse(messageForModel(message));
  assert.deepEqual(envelope, {
    sender: { key: 'qq:user:101', name: '甲的群名片' }, messageId: '5',
    segments: [
      { type: 'reply', messageId: '3' },
      { type: 'mention', userKey: 'qq:user:102', name: '小乙' },
      { type: 'mention', userKey: 'qq:user:103' },
      { type: 'text', text: '看' },
    ],
  });
});

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'fish-module1-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fish = new Fish({ home });
  const requests = [], sent = [], errors = [];
  const brain = { chat: async (messages) => { requests.push(messages); return '收到'; } };
  const client = {
    sendGroupMsg: async (id, message) => sent.push({ kind: 'group', id, message }),
    sendPrivateMsg: async (id, message) => sent.push({ kind: 'private', id, message }),
  };
  const handle = createQQHandler({
    fish, brain, getClient: () => client, persona: '测试角色',
    now: () => new Date('2026-11-12T00:00:00Z'), onError: (stage, error) => errors.push({ stage, error }),
  });
  return { fish, handle, requests, sent, errors, brain };
}

const userMessages = (request) => request.filter((m) => m.role === 'user').map((m) => JSON.parse(m.content));

test('真实入口函数：同号私聊与群聊不共享历史，并路由到正确目标', async (t) => {
  const h = setup(t);
  await h.handle(event({ message_type: 'private', user_id: 200, message: '私聊秘密' }));
  await h.handle(event({ message_id: 2, message: '群里你好' }));
  assert.equal(userMessages(h.requests[1]).length, 1);
  assert.ok(!JSON.stringify(h.requests[1]).includes('私聊秘密'));
  assert.deepEqual(h.sent.map(({ kind, id }) => ({ kind, id })), [
    { kind: 'private', id: 200 }, { kind: 'group', id: 200 },
  ]);
});

test('真实入口函数：群聊保留每轮发言者，关系属于个人', async (t) => {
  const h = setup(t);
  await h.handle(event());
  await h.handle(event({ user_id: 102, message_id: 2, sender: { nickname: '小乙' }, message: '我是小乙' }));
  const users = userMessages(h.requests[1]);
  assert.deepEqual(users.map((m) => m.sender.key), ['qq:user:101', 'qq:user:102']);
  assert.deepEqual(users.map((m) => m.sender.name), ['甲的群名片', '小乙']);
  assert.ok(h.requests[1][0].content.includes('qq:account:900:conversation:group:200'));
  assert.deepEqual(h.fish.character.state().relationships.map((r) => r.peerId), ['qq:user:101', 'qq:user:102']);
  assert.equal(h.fish.character.getRelationship('qq:user:101').name, '小甲');
  const stored = h.fish.memory.export();
  assert.equal(stored[1].meta.senderKey, 'qq:user:102');
  assert.equal(stored[1].meta.messageKey, 'qq:account:900:conversation:group:200:message:2');
});

test('真实入口函数：不同机器人账号、不同群的历史隔离', async (t) => {
  const h = setup(t);
  await h.handle(event());
  await h.handle(event({ self_id: 901 }));
  await h.handle(event({ group_id: 201 }));
  assert.deepEqual(h.requests.map((r) => userMessages(r).length), [1, 1, 1]);
});

test('真实入口函数：同一人先私聊后群聊，不以个人私有权限检索群上下文', async (t) => {
  const h = setup(t);
  const privateScope = conversationKey('qq', 900, 'private', 101);
  h.fish.remember({ type: 'semantic', content: '私聊专属内容', access: `private:${privateScope}` });
  await h.handle(event({ message_type: 'private', message: '私聊专属内容' }));
  await h.handle(event({ message_id: 2, message: '你好' }));
  assert.ok(h.requests[0][0].content.includes('私聊专属内容'));
  assert.ok(!JSON.stringify(h.requests[1]).includes('私聊专属内容'));
});

test('真实入口函数：CQ 的 @/引用进入模型；损坏消息被跳过，后续仍能处理', async (t) => {
  const h = setup(t);
  await h.handle(event({ self_id: undefined }));
  await h.handle(event({ message: '[CQ:reply,id=-5][CQ:at,qq=900]你好' }));
  const [user] = userMessages(h.requests[0]);
  assert.deepEqual(user.segments.map((s) => s.type), ['reply', 'mention', 'text']);
  assert.equal(h.errors.length, 1);
  assert.equal(h.sent.length, 1);
});

test('归一化保留纯图片和纯@，入口维持本阶段只回复含文本消息的行为', async (t) => {
  const h = setup(t);
  const image = event({ message: [{ type: 'image', data: { file: 'x.jpg' } }] });
  assert.equal(normalizeOneBotMessage(image).segments.length, 1);
  await h.handle(image);
  await h.handle(event({ message: '[CQ:at,qq=900]' }));
  assert.equal(h.requests.length, 0);
  assert.equal(h.sent.length, 0);
});

test('入口发送保留上游目标 ID 类型，数值和字符串输入使用同一会话', async (t) => {
  const h = setup(t);
  await h.handle(event());
  await h.handle(event({ self_id: '900', group_id: '200', user_id: '101', message_id: '2' }));
  assert.equal(userMessages(h.requests[1]).length, 2);
  assert.deepEqual(h.sent.map((s) => s.id), [200, '200']);
});

test('真实入口函数：情节记忆只在原会话召回，不跨群或私聊', async (t) => {
  const h = setup(t);
  await h.handle(event({ message: '暗号是蓝色海豚' }));
  await h.handle(event({ message_id: 2, message: '蓝色海豚' }));
  await h.handle(event({ group_id: 201, message_id: 3, message: '蓝色海豚' }));
  await h.handle(event({ message_type: 'private', message_id: 4, message: '蓝色海豚' }));
  const memoryOf = (r) => r[0].content.split('## 长期记忆')[1];
  assert.ok(memoryOf(h.requests[1]).includes('暗号是蓝色海豚'));
  assert.ok(!memoryOf(h.requests[2]).includes('暗号是蓝色海豚'));
  assert.ok(!memoryOf(h.requests[3]).includes('暗号是蓝色海豚'));
});

test('入口模型失败记录内部错误，聊天对象只收到通用提示', async (t) => {
  const h = setup(t);
  h.brain.chat = async () => { throw new Error('internal-provider-details'); };
  await h.handle(event());
  assert.equal(h.errors[0].error.message, 'internal-provider-details');
  assert.equal(h.sent.length, 1);
  assert.ok(!JSON.stringify(h.sent).includes('internal-provider-details'));
  assert.equal(h.fish.memory.count(), 0);
});

test('相同聊天内容在不同群、私聊和机器人账号下分别保存，同一范围仍去重', async (t) => {
  const h = setup(t);
  const inputs = [
    event({ message_id: 10 }),
    event({ group_id: 201, message_id: 11 }),
    event({ message_type: 'private', sub_type: 'friend', message_id: 12 }),
    event({ self_id: 901, message_id: 13 }),
  ].map((input) => ({ ...input, sender: { nickname: '小甲' }, message: '我喜欢鲸鱼' }));
  for (const input of inputs) await h.handle(input);
  assert.equal(h.fish.memory.count(), 4);
  assert.equal(new Set(h.fish.memory.export().map((r) => r.content)).size, 1);

  // 同一可见范围内的相同内容仍应去重，不通过完全关闭去重掩盖问题。
  await h.handle({ ...inputs[0], message_id: 14 });
  assert.equal(h.fish.memory.count(), 4);

  const reloaded = new Fish({ home: h.fish.home });
  for (const input of inputs) {
    const conversation = normalizeOneBotMessage(input).conversation.key;
    const records = reloaded.recall({ requester: conversation, query: '鲸鱼' });
    assert.equal(records.length, 1);
    assert.equal(records[0].meta.conversationKey, conversation);
  }
});

test('系统提示中的机器人用户标识与实际 @ 消息一致，随账号变化', async (t) => {
  const h = setup(t);
  for (const account of [900, 901]) {
    await h.handle(event({ self_id: account, message: `[CQ:at,qq=${account}]你好` }));
    const request = h.requests.at(-1);
    const mention = userMessages(request).at(-1).segments.find((s) => s.type === 'mention');
    const selfUserKey = /^用户标识：(.+)$/m.exec(request[0].content)?.[1];
    assert.equal(selfUserKey, mention.userKey);
    assert.ok(request[0].content.includes(`qq:account:${account}`));
    assert.ok(!request[0].content.includes(`qq:account:${account}（@ 这个 key 就是在叫你）`));
  }
});
