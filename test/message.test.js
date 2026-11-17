import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  Fish, scope, visibleTo, entityKey, conversationKey, normalizeOneBotMessage, messageForModel, createAliasBook, OneBotError,
  ModelError, MessageInbox, MemoryInbox, RUNTIME_DEFAULTS, OPERATOR,
} from '../src/index.js';
import { createQQHandler, NOTICES } from '../src/qq-handler.js';
import { openFish, testDb, closeTestDb, captureLogger, waitFor } from './helpers.js';

after(closeTestDb);

// 测试事件的时间固定；处理器的时钟设在它之后 5 秒，消息就不会被当成“太旧”。
const EVENT_TIME = 1700000000;
const fixtureClock = () => EVENT_TIME * 1000 + 5000;

function event(overrides = {}) {
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: 900, user_id: 101, group_id: 200, message_id: 1, time: EVENT_TIME,
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
  const modelInput = JSON.parse(messageForModel(normalized, createAliasBook()));
  assert.deepEqual(modelInput.segments[1], { type: 'mention', toYou: true });
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

test('@ 段保留显示名；模型信封用会话内代号区分发言者和被 @ 的人', () => {
  const message = normalizeOneBotMessage(event({ message_id: 5,
    message: '[CQ:reply,id=3][CQ:at,qq=102,name=小乙][CQ:at,qq=103][CQ:at,qq=101]看' }));
  assert.equal(message.segments[1].name, '小乙');
  assert.equal(message.segments[2].name, null);
  const envelope = JSON.parse(messageForModel(message, createAliasBook()));
  assert.deepEqual(envelope, {
    sender: { alias: 'u1', name: '甲的群名片' }, messageId: '5',
    segments: [
      { type: 'reply', messageId: '3' },
      { type: 'mention', alias: 'u2', name: '小乙' },
      { type: 'mention', alias: 'u3' },
      { type: 'mention', alias: 'u1' },
      { type: 'text', text: '看' },
    ],
  });
  assert.throws(() => messageForModel(message), TypeError);
});

// 多数入口测试关注身份与记录，不关心群聊闸门，因此默认沿用“群里每条都回复”的兼容模式；闸门有单独测试。
// runtime：传给 createQQHandler 的其他参数（inbox、clock、maxAgeMs……）。
async function setup(t, { replyToAllGroupMessages = true, ...runtime } = {}) {
  const fish = await openFish();
  const requests = [], sent = [];
  const logs = captureLogger();
  // 警告和错误级别的日志，相当于原来的 onError 收集到的内容。
  const errors = { get list() { return logs.entries.filter((e) => e.level === 'warn' || e.level === 'error'); } };
  const brain = { chat: async (messages) => { requests.push(messages); return '收到'; } };
  // 模拟 OneBot 的发送结果：返回新消息的 message_id。
  const client = {
    sendGroupMsg: async (id, message, opts) => ({ message_id: 9000 + sent.push({ kind: 'group', id, message, opts }) }),
    sendPrivateMsg: async (id, message, opts) => ({ message_id: 9000 + sent.push({ kind: 'private', id, message, opts }) }),
  };
  const options = {
    fish, brain, getClient: () => client, persona: '测试角色',
    now: () => new Date('2026-11-12T00:00:00Z'), logger: logs.logger, clock: fixtureClock,
    replyToAllGroupMessages, ...runtime,
  };
  const handle = createQQHandler(options);
  // 用同样的参数（可以替换其中几项）再建一个处理器，例如模拟重启、换一个 OneBot 客户端。
  const another = (overrides = {}) => createQQHandler({ ...options, ...overrides });
  return { fish, handle, stop: handle.stop, another, client, requests, sent, get errors() { return errors.list; }, brain, logs };
}

const userMessages = (request) => request.filter((m) => m.role === 'user').map((m) => JSON.parse(m.content));

test('真实入口函数：同号私聊与群聊不共享历史，并路由到正确目标', async (t) => {
  const h = await setup(t);
  await h.handle(event({ message_type: 'private', user_id: 200, message: '私聊秘密' }));
  await h.handle(event({ message_id: 2, message: '群里你好' }));
  assert.equal(userMessages(h.requests[1]).length, 1);
  assert.ok(!JSON.stringify(h.requests[1]).includes('私聊秘密'));
  assert.deepEqual(h.sent.map(({ kind, id }) => ({ kind, id })), [
    { kind: 'private', id: 200 }, { kind: 'group', id: 200 },
  ]);
});

test('真实入口函数：群聊保留每轮发言者，关系属于个人', async (t) => {
  const h = await setup(t);
  await h.handle(event());
  await h.handle(event({ user_id: 102, message_id: 2, sender: { nickname: '小乙' }, message: '我是小乙' }));
  const users = userMessages(h.requests[1]);
  assert.deepEqual(users.map((m) => m.sender.alias), ['u1', 'u2']);
  assert.deepEqual(users.map((m) => m.sender.name), ['甲的群名片', '小乙']);
  assert.ok(h.requests[1][0].content.includes('## 当前会话\n群聊'));
  assert.deepEqual((await h.fish.character.state()).relationships.map((r) => r.peerId), ['qq:user:101', 'qq:user:102']);
  assert.equal((await h.fish.character.getRelationship('qq:user:101')).name, '小甲');
  const stored = await h.fish.memory.export({ requester: OPERATOR });
  assert.equal(stored[1].meta.senderKey, 'qq:user:102');
  assert.equal(stored[1].meta.messageKey, 'qq:account:900:conversation:group:200:message:2');
});

test('真实入口函数：不同机器人账号、不同群的历史隔离', async (t) => {
  const h = await setup(t);
  await h.handle(event());
  await h.handle(event({ self_id: 901 }));
  await h.handle(event({ group_id: 201 }));
  assert.deepEqual(h.requests.map((r) => userMessages(r).length), [1, 1, 1]);
});

test('真实入口函数：同一人先私聊后群聊，不以个人私有权限检索群上下文', async (t) => {
  const h = await setup(t);
  const privateScope = conversationKey('qq', 900, 'private', 101);
  await h.fish.remember({ type: 'semantic', content: '私聊专属内容', access: scope.conversation(privateScope) });
  await h.handle(event({ message_type: 'private', message: '私聊专属内容' }));
  await h.handle(event({ message_id: 2, message: '你好' }));
  assert.ok(h.requests[0][0].content.includes('私聊专属内容'));
  assert.ok(!JSON.stringify(h.requests[1]).includes('私聊专属内容'));
});

test('真实入口函数：CQ 的 @/引用进入模型；损坏消息被跳过，后续仍能处理', async (t) => {
  const h = await setup(t);
  await h.handle(event({ self_id: undefined }));
  await h.handle(event({ message: '[CQ:reply,id=-5][CQ:at,qq=900]你好' }));
  const [user] = userMessages(h.requests[0]);
  assert.deepEqual(user.segments.map((s) => s.type), ['reply', 'mention', 'text']);
  assert.equal(h.errors.length, 1);
  assert.equal(h.sent.length, 1);
});

test('归一化保留纯图片和纯@，入口维持本阶段只回复含文本消息的行为', async (t) => {
  const h = await setup(t);
  const image = event({ message: [{ type: 'image', data: { file: 'x.jpg' } }] });
  assert.equal(normalizeOneBotMessage(image).segments.length, 1);
  await h.handle(image);
  await h.handle(event({ message: '[CQ:at,qq=900]' }));
  assert.equal(h.requests.length, 0);
  assert.equal(h.sent.length, 0);
});

test('入口发送保留上游目标 ID 类型，数值和字符串输入使用同一会话', async (t) => {
  const h = await setup(t);
  await h.handle(event());
  await h.handle(event({ self_id: '900', group_id: '200', user_id: '101', message_id: '2' }));
  assert.equal(userMessages(h.requests[1]).length, 2);
  assert.deepEqual(h.sent.map((s) => s.id), [200, '200']);
});

test('真实入口函数：情节记忆只在原会话召回，不跨群或私聊', async (t) => {
  const h = await setup(t);
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
  const h = await setup(t);
  h.brain.chat = async () => { throw new Error('internal-provider-details'); };
  await h.handle(event());
  assert.equal(h.errors[0].event, 'reply.failed');
  assert.equal(h.errors[0].error.message, 'internal-provider-details');
  assert.equal(h.sent.length, 1);
  assert.ok(!JSON.stringify(h.sent).includes('internal-provider-details'));
  assert.equal(await h.fish.memory.count(), 0);
});

const sentTexts = (h) => h.sent.map((s) => s.message[0].data.text);

// 让模型调用卡住，直到测试逐个放行：gates[i]() 放行第 i 次调用。
function gatedBrain(h) {
  const gates = [];
  h.brain.chat = async (messages) => {
    const n = h.requests.push(messages);
    await new Promise((resolve) => gates.push(resolve));
    return `回复${n}`;
  };
  return gates;
}

test('同一会话的连续消息逐条处理：后一条看得到前一条的对话，历史不会被覆盖', async (t) => {
  const h = await setup(t);
  const gates = gatedBrain(h);
  const done = [1, 2, 3].map((id) => h.handle(event({ message_id: id, message: `第${id}条` })));
  for (let i = 0; i < 3; i += 1) {
    await waitFor(() => gates.length > i, { what: `第 ${i + 1} 次模型调用` });
    assert.equal(gates.length, i + 1, '同一会话同时只应有一次模型调用');
    gates[i]();
  }
  await Promise.all(done);
  const history = h.requests[2].filter((m) => m.role !== 'system');
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(history.filter((m) => m.role === 'assistant').map((m) => m.content), ['回复1', '回复2']);
  assert.deepEqual(sentTexts(h), ['回复1', '回复2', '回复3']);
});

test('不同会话的消息并行处理，互不等待', async (t) => {
  const h = await setup(t);
  const gates = gatedBrain(h);
  const a = h.handle(event({ group_id: 201 }));
  const b = h.handle(event({ group_id: 202 }));
  await waitFor(() => gates.length === 2, { what: '两个会话同时在调用模型' });
  gates[1]();
  await b; // 第二个会话不必等第一个
  gates[0]();
  await a;
  assert.equal(h.sent.length, 2);
});

test('同一条消息收到两次（先后或同时）：只处理一次、只回复一次', async (t) => {
  const h = await setup(t);
  await h.handle(event({ message_id: 7 }));
  await h.handle(event({ message_id: 7 }));
  await Promise.all([h.handle(event({ message_id: 8 })), h.handle(event({ message_id: 8 }))]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.sent.length, 2);
  assert.equal(h.logs.find('message.duplicate').length, 2);
});

test('用数据库记录消息：重启后再收到同一条也不会重复回复；记录里如实写明结果', async (t) => {
  const inbox = new MessageInbox({ db: await testDb(), tenantId: `test-${randomUUID()}` });
  const h = await setup(t, { inbox });
  await h.handle(event({ message_id: 42 }));
  const restarted = h.another(); // 模拟重启：新的处理器，同一个数据库
  await restarted(event({ message_id: 42 }));
  assert.equal(h.sent.length, 1);
  assert.deepEqual(await inbox.get('qq:account:900:conversation:group:200:message:42'), {
    messageKey: 'qq:account:900:conversation:group:200:message:42',
    conversationKey: 'qq:account:900:conversation:group:200',
    status: 'replied', outcome: 'replied', errorCode: undefined, delivery: undefined, sentMessageId: '9001', sendAttempts: 1,
  });
});

test('太旧的消息不再回复：收到时已超时的直接跳过；排队期间超时的也丢弃', async (t) => {
  let clock = fixtureClock();
  const h = await setup(t, { clock: () => clock, maxAgeMs: 60_000 });
  await h.handle(event({ message_id: 1, time: EVENT_TIME - 120 })); // 两分钟前的消息
  assert.equal(h.requests.length, 0);
  assert.equal(h.logs.find('message.skipped')[0].reason, 'stale');

  const gates = gatedBrain(h);
  const first = h.handle(event({ message_id: 2 }));
  await waitFor(() => gates.length === 1);
  const second = h.handle(event({ message_id: 3 })); // 排在第一条后面
  await waitFor(() => h.logs.find('message.accepted').length === 2);
  clock += 61_000; // 第一条处理了很久
  gates[0]();
  await Promise.all([first, second]);
  assert.equal(h.requests.length, 1, '排队太久的第二条不应调用模型');
  const [dropped] = h.logs.find('message.dropped');
  assert.equal(dropped.reason, 'stale');
  assert.equal(dropped.messageKey, 'qq:account:900:conversation:group:200:message:3');
});

test('同一会话排队太多：超过上限的新消息不处理，记为 dropped', async (t) => {
  const inbox = new MemoryInbox();
  const h = await setup(t, { maxPendingPerConversation: 1, inbox });
  const gates = gatedBrain(h);
  const first = h.handle(event({ message_id: 1 }));
  await waitFor(() => gates.length === 1);
  const second = h.handle(event({ message_id: 2 }));
  await waitFor(() => h.logs.find('message.accepted').length === 2);
  await h.handle(event({ message_id: 3 })); // 队列已满，立即返回
  assert.equal(h.logs.find('message.dropped')[0].reason, 'queue_full');
  assert.equal((await inbox.get('qq:account:900:conversation:group:200:message:3')).status, 'dropped');
  gates[0]();
  await waitFor(() => gates.length === 2);
  gates[1]();
  await Promise.all([first, second]);
  assert.deepEqual(sentTexts(h), ['回复1', '回复2']);
});

test('没连上 OneBot（肯定没发出）：等重连后再发一次，发出后照常记录', async (t) => {
  const inbox = new MemoryInbox();
  const h = await setup(t, { inbox });
  let calls = 0;
  let waitedMs = null;
  const client = {
    sendGroupMsg: async () => {
      calls += 1;
      if (calls === 1) throw new OneBotError('NOT_CONNECTED', '未连接 OneBot，未发送', { delivery: 'not_sent', action: 'send_group_msg' });
      return { message_id: 9100 };
    },
    waitForConnection: async (ms) => { waitedMs = ms; return true; },
  };
  await h.another({ getClient: () => client })(event());
  assert.equal(calls, 2);
  assert.equal(waitedMs, RUNTIME_DEFAULTS.sendRetryWaitMs);
  const [done] = h.logs.find('message.done');
  assert.deepEqual([done.outcome, done.sendAttempts], ['replied', 2]);
  assert.equal(h.logs.find('send.retry_wait').length, 1);
  assert.equal(await h.fish.memory.count(), 1);
  const record = await inbox.get('qq:account:900:conversation:group:200:message:1');
  assert.deepEqual([record.status, record.sendAttempts, record.sentMessageId], ['replied', 2, '9100']);
});

test('发送失败不记成已回复：等不到重连、结果未知、SnowLuma 拒绝，都只发一次，也不写记忆', async (t) => {
  const cases = [
    { error: new OneBotError('NOT_CONNECTED', '未连接', { delivery: 'not_sent' }), connected: false, delivery: 'not_sent', waits: 1 },
    { error: new OneBotError('TIMEOUT', '超时，结果未知', { delivery: 'unknown' }), connected: true, delivery: 'unknown', waits: 0 },
    { error: new OneBotError('ACTION_FAILED', '发送失败', { delivery: 'not_sent', retcode: 100 }), connected: true, delivery: 'not_sent', waits: 0 },
  ];
  for (const c of cases) {
    const inbox = new MemoryInbox();
    const h = await setup(t, { inbox });
    let calls = 0;
    let waits = 0;
    const client = {
      sendGroupMsg: async () => { calls += 1; throw c.error; },
      waitForConnection: async () => { waits += 1; return c.connected; },
    };
    await h.another({ getClient: () => client })(event());
    assert.equal(calls, 1, c.error.code);
    assert.equal(waits, c.waits, c.error.code);
    assert.equal(await h.fish.memory.count(), 0, c.error.code);
    const record = await inbox.get('qq:account:900:conversation:group:200:message:1');
    assert.deepEqual([record.status, record.errorCode, record.delivery], ['send_failed', c.error.code, c.delivery]);
    const [done] = h.logs.find('message.done');
    assert.deepEqual([done.outcome, done.delivery], ['send_failed', c.delivery]);
  }
});

test('退出时：停止接收新消息，等手上的处理完再返回', async (t) => {
  const h = await setup(t);
  const gates = gatedBrain(h);
  const inflight = h.handle(event({ message_id: 1 }));
  await waitFor(() => gates.length === 1);
  const stopping = h.stop(2000);
  await h.handle(event({ message_id: 2 })); // 退出过程中收到的新消息不再处理
  gates[0]();
  assert.equal(await stopping, 0);
  await inflight;
  assert.equal(h.sent.length, 1);
  assert.equal(h.logs.find('message.ignored').filter((e) => e.reason === 'shutting_down').length, 1);
});

// 取系统提示里的某一节（各节之间用空行分隔）。
const promptSection = (request, title) => request[0].content.split('\n\n').find((s) => s.startsWith(`## ${title}`));

test('重启后记得之前的对话：短期历史和代号都存在数据库里', async (t) => {
  const h = await setup(t);
  await h.handle(event({ message_id: 1, message: '我叫小甲' }));
  const restarted = h.another(); // 新的处理器：内存里什么都没有，只有同一个数据库
  await restarted(event({ message_id: 2, message: '我叫什么' }));
  const turns = h.requests[1].filter((m) => m.role !== 'system');
  assert.deepEqual(turns.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(JSON.parse(turns[0].content).segments[0].text, '我叫小甲');
  assert.equal(turns[1].content, '收到');
  assert.deepEqual(userMessages(h.requests[1]).map((m) => m.sender.alias), ['u1', 'u1']);
});

test('跨会话认人：同一个人在群 A、群 B 代号一致，印象按所有群合计；群 A 的具体事不会在群 B 召回', async (t) => {
  const h = await setup(t);
  await h.handle(event({ group_id: 200, message_id: 1, message: '我在群A说的暗号是蓝色海豚' }));
  await h.handle(event({ group_id: 201, message_id: 1, message: '我来群B了' }));
  await h.handle(event({ group_id: 200, message_id: 2, message: '我又回群A了' }));
  const [a1, b, a2] = h.requests;
  assert.equal(userMessages(b).at(-1).sender.alias, userMessages(a1).at(-1).sender.alias);
  assert.match(promptSection(a1, '当前发言者'), /这是你们第一次在群里说话/);
  assert.match(promptSection(b, '当前发言者'), /你们在群里聊过 1 次/, '第一次来群 B，也认得出在群 A 聊过');
  assert.match(promptSection(a2, '当前发言者'), /你们在群里聊过 2 次/);
  assert.ok(!JSON.stringify(b).includes('蓝色海豚'), '群 A 的具体事不应出现在群 B');
});

test('私聊内容永远不进群：历史、记忆、印象里都没有，群里也看不出私聊过几次（重启后也一样）', async (t) => {
  const h = await setup(t);
  for (let i = 1; i <= 3; i += 1) {
    await h.handle(event({ message_type: 'private', sub_type: 'friend', message_id: i, message: `私聊秘密${i}：暗号是红色鲸鱼` }));
  }
  const restarted = h.another();
  await restarted(event({ message_id: 9, message: '大家好' }));
  const group = h.requests.at(-1);
  for (const secret of ['红色鲸鱼', '私聊秘密']) assert.ok(!JSON.stringify(group).includes(secret), secret);
  assert.match(promptSection(group, '当前发言者'), /这是你们第一次在群里说话/);
  // 回到私聊：印象按全部互动算（3 次私聊 + 1 次群聊）
  await restarted(event({ message_type: 'private', sub_type: 'friend', message_id: 10, message: '又来私聊了' }));
  assert.match(promptSection(h.requests.at(-1), '当前发言者'), /你们聊过 4 次/);
});

test('相同内容可以属于不同的人：两个人在同一个群说了一样的话，各存一条；同一个人重复仍去重', async (t) => {
  const h = await setup(t);
  const same = { sender: { nickname: '小明', card: '小明' }, message: '我想买一只猫' };
  await h.handle(event({ ...same, user_id: 101, message_id: 1 }));
  await h.handle(event({ ...same, user_id: 102, message_id: 2 }));
  const records = await h.fish.memory.export({ requester: OPERATOR });
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((r) => r.content)).size, 1, '两条内容完全相同');
  assert.deepEqual(records.map((r) => r.peers[0]).sort(), ['qq:user:101', 'qq:user:102']);
  await h.handle(event({ ...same, user_id: 101, message_id: 3 }));
  assert.equal((await h.fish.memory.export({ requester: OPERATOR })).length, 2);
});

test('重启后，有人引用奶蛙以前发的消息也算叫到它；消息记录能交出这些消息', async (t) => {
  const inbox = new MessageInbox({ db: await testDb(), tenantId: `test-${randomUUID()}` });
  const h = await setup(t, { inbox });
  await h.handle(event({ message_id: 1 })); // 奶蛙回复，发出的消息编号是 9001
  const sentMessageKeys = await inbox.recentSentMessages();
  assert.deepEqual(sentMessageKeys, ['qq:account:900:conversation:group:200:message:9001']);
  const restarted = h.another({ replyToAllGroupMessages: false, sentMessageKeys });
  await restarted(event({ message_id: 5, message: '[CQ:reply,id=9001]你说得对' }));
  assert.equal(h.requests.length, 2, '引用了奶蛙重启前发的消息，应该回复');
  await restarted(event({ message_id: 6, message: '[CQ:reply,id=9999]这条引用的不是奶蛙' }));
  assert.equal(h.requests.length, 2);
});

test('花费上限：每次被叫到都回固定提示；会话限速：每段受限时间只提示一次；都不记录，也不算错误', async (t) => {
  const h = await setup(t);
  h.brain.chat = async () => { throw new ModelError('BUDGET_EXCEEDED'); };
  await h.handle(event({ message_id: 1 }));
  await h.handle(event({ message_id: 2 }));
  h.brain.chat = async () => { throw new ModelError('CONVERSATION_RATE_LIMITED', { notify: true, retryAfterMs: 1000 }); };
  await h.handle(event({ message_id: 3 }));
  h.brain.chat = async () => { throw new ModelError('CONVERSATION_RATE_LIMITED', { notify: false, retryAfterMs: 500 }); };
  await h.handle(event({ message_id: 4 }));

  assert.deepEqual(sentTexts(h), [NOTICES.budget, NOTICES.budget, NOTICES.rateLimited]);
  assert.equal(NOTICES.budget, '今天的蛙力用完了，明天再聊');
  assert.deepEqual(h.logs.find('message.done').map((e) => [e.outcome, e.errorCode]), [
    ['budget_exceeded', 'BUDGET_EXCEEDED'], ['budget_exceeded', 'BUDGET_EXCEEDED'],
    ['rate_limited', 'CONVERSATION_RATE_LIMITED'], ['rate_limited_silent', 'CONVERSATION_RATE_LIMITED'],
  ]);
  assert.deepEqual(h.errors, []);
  assert.equal(h.logs.find('reply.limited').length, 4);
  assert.equal(await h.fish.memory.count(), 0);
});

test('模型按内容安全策略拒答时回婉拒提示；空回复按失败处理，不用“？”占位', async (t) => {
  const h = await setup(t);
  h.brain.chat = async () => { throw new ModelError('FILTERED'); };
  await h.handle(event({ message_id: 1 }));
  h.brain.chat = async () => '   ';
  await h.handle(event({ message_id: 2 }));
  assert.deepEqual(sentTexts(h), [NOTICES.filtered, NOTICES.fallback]);
  assert.deepEqual(h.logs.find('message.done').map((e) => [e.outcome, e.errorCode]), [['filtered', 'FILTERED'], ['fallback', 'EMPTY']]);
  assert.equal(h.logs.find('reply.filtered')[0].level, 'warn');
  assert.equal(h.logs.find('reply.failed')[0].error.code, 'EMPTY');
  assert.equal(await h.fish.memory.count(), 0);
});

test('调用模型时带上消息 key 和会话 key（日志关联、按会话限速、用量统计都靠它们）', async (t) => {
  const h = await setup(t);
  let opts;
  h.brain.chat = async (_messages, o) => { opts = o; return '好'; };
  await h.handle(event());
  assert.deepEqual(opts, {
    key: 'qq:account:900:conversation:group:200:message:1',
    conversationKey: 'qq:account:900:conversation:group:200',
  });
});

test('相同聊天内容在不同群、私聊和机器人账号下分别保存，同一范围仍去重', async (t) => {
  const h = await setup(t);
  const inputs = [
    event({ message_id: 10 }),
    event({ group_id: 201, message_id: 11 }),
    event({ message_type: 'private', sub_type: 'friend', message_id: 12 }),
    event({ self_id: 901, message_id: 13 }),
  ].map((input) => ({ ...input, sender: { nickname: '小甲' }, message: '我喜欢鲸鱼' }));
  for (const input of inputs) await h.handle(input);
  assert.equal(await h.fish.memory.count(), 4);
  assert.equal(new Set((await h.fish.memory.export({ requester: OPERATOR })).map((r) => r.content)).size, 1);

  // 同一可见范围内的相同内容仍应去重，不通过完全关闭去重掩盖问题。
  await h.handle({ ...inputs[0], message_id: 14 });
  assert.equal(await h.fish.memory.count(), 4);

  const reloaded = await Fish.open({ db: await testDb(), tenantId: h.fish.tenantId });
  for (const input of inputs) {
    const conversation = normalizeOneBotMessage(input).conversation.key;
    const records = await reloaded.recall({ requester: conversation, query: '鲸鱼' });
    assert.equal(records.length, 1);
    assert.equal(records[0].meta.conversationKey, conversation);
  }
});

test('@ 当前机器人账号标为 toYou，随账号变化；@ 另一个机器人账号只是普通成员', async (t) => {
  const h = await setup(t);
  for (const account of [900, 901]) {
    await h.handle(event({ self_id: account, message: `[CQ:at,qq=${account}][CQ:at,qq=${1801 - account}]你好` }));
    const [self, other] = userMessages(h.requests.at(-1)).at(-1).segments;
    assert.deepEqual(self, { type: 'mention', toYou: true });
    assert.equal(other.toYou, undefined);
    assert.match(other.alias, /^u\d+$/);
  }
});

test('模型请求中不出现原始 QQ 号或内部 key；代号在会话内稳定、因人而异', async (t) => {
  const h = await setup(t);
  const ids = { self_id: 77703, group_id: 66602 };
  await h.handle(event({ ...ids, user_id: 55501, message_id: 1, sender: { nickname: '甲' }, message: '鲸鱼好大' }));
  await h.handle(event({ ...ids, user_id: 55502, message_id: 2, sender: { nickname: '乙' },
    message: '[CQ:reply,id=1][CQ:at,qq=55501][CQ:at,qq=77703]真的' }));
  await h.handle(event({ ...ids, user_id: 55501, message_id: 3, sender: { nickname: '甲' }, message: '对吧' }));
  await h.handle(event({ ...ids, message_type: 'private', sub_type: 'friend', user_id: 55501, message_id: 4,
    sender: { nickname: '甲' }, message: '私聊一下' }));

  const all = JSON.stringify(h.requests);
  for (const raw of ['77703', '66602', '55501', '55502', 'qq:']) assert.ok(!all.includes(raw), `leaked ${raw}`);

  const turns = userMessages(h.requests[2]);
  assert.deepEqual(turns.map((m) => m.sender.alias), ['u1', 'u2', 'u1']);
  assert.deepEqual(turns[1].segments.slice(1, 3), [
    { type: 'mention', alias: 'u1' }, { type: 'mention', toYou: true },
  ]);
  // 记忆按会话内代号标注发言者；内部仍保存真实 key 供程序使用。
  assert.match(h.requests[2][0].content, /- \[episodic · u1\] 甲说「鲸鱼好大」/);
  assert.equal((await h.fish.memory.export({ requester: OPERATOR }))[0].meta.senderKey, 'qq:user:55501');
  assert.deepEqual(userMessages(h.requests[3]).map((m) => m.sender.alias), ['u1']);
});

test('会话记忆使用 conversation 范围：只对该会话可见，不对个人或其他会话可见', async (t) => {
  const h = await setup(t);
  await h.handle(event());
  const [record] = await h.fish.memory.export({ requester: OPERATOR });
  const conversation = 'qq:account:900:conversation:group:200';
  assert.equal(record.access, `conversation:${conversation}`);
  assert.equal(scope.conversation(conversation), record.access);
  assert.ok(visibleTo(record, conversation));
  assert.ok(!visibleTo(record, 'qq:user:101'));
  assert.ok(!visibleTo(record, 'qq:account:900:conversation:group:201'));
  assert.ok(!visibleTo(record, `private:${conversation}`));
});

test('自我记忆只注入 self 范围的记录，不借 self 身份读到其他会话的私有记录', async (t) => {
  const h = await setup(t);
  const dm = conversationKey('qq', 900, 'private', 101);
  await h.fish.remember({ type: 'self', content: '只属于私聊的自我记录', access: scope.conversation(dm) });
  await h.fish.remember({ type: 'self', content: '奶蛙今天学会了游泳', access: scope.SELF });
  await h.handle(event({ group_id: 555 }));
  const prompt = h.requests[0][0].content;
  assert.ok(!prompt.includes('只属于私聊的自我记录'));
  assert.ok(prompt.includes('奶蛙今天学会了游泳'));
});

test('回复已发出后保存失败：用户收到真实回复，错误只记日志', async (t) => {
  const h = await setup(t);
  h.fish.remember = async () => { throw new Error('ENOSPC'); };
  await h.handle(event());
  assert.deepEqual(h.sent.map((s) => s.message[0].data.text), ['收到']);
  assert.deepEqual(h.errors.map((e) => e.error.message), ['ENOSPC']);
});

test('发送失败不记录：历史、记忆和关系都不把未送达的回复当成已发生', async (t) => {
  const h = await setup(t);
  const client = { sendGroupMsg: async () => { throw new Error('未连接'); } };
  const handle = createQQHandler({
    fish: h.fish, brain: h.brain, getClient: () => client, persona: '测试角色',
    logger: h.logs.logger, replyToAllGroupMessages: true, clock: fixtureClock,
  });
  await handle(event({ message: '第一句' }));
  assert.deepEqual(h.logs.find('send.failed').map((e) => e.error.message), ['未连接']);
  assert.equal(await h.fish.memory.count(), 0);
  assert.equal((await h.fish.character.state()).relationships.length, 0);

  await h.handle(event({ message_id: 2, message: '第二句' }));
  const history = h.requests[1].filter((m) => m.role !== 'system');
  assert.equal(history.length, 1);
  assert.ok(!JSON.stringify(history).includes('第一句'));
});

test('群聊闸门：没叫到奶蛙的群消息不调模型、不回复、不记录；私聊照常回复', async (t) => {
  const h = await setup(t, { replyToAllGroupMessages: false });
  await h.handle(event({ message: '大家晚上好' }));
  await h.handle(event({ message_id: 2, message: '[CQ:at,qq=all]开会了' }));
  await h.handle(event({ message_id: 3, message: '[CQ:at,qq=102]你看这个' }));
  assert.equal(h.requests.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(await h.fish.memory.count(), 0);
  await h.handle(event({ message_type: 'private', sub_type: 'friend', message_id: 4, message: '在吗' }));
  assert.deepEqual(h.sent.map((s) => s.kind), ['private']);
});

test('群聊闸门：被 @ 时回复；引用奶蛙自己发出的消息时回复，引用别人的消息不回复', async (t) => {
  const h = await setup(t, { replyToAllGroupMessages: false });
  await h.handle(event({ message: '[CQ:at,qq=900]奶蛙你好' }));
  assert.equal(h.sent.length, 1); // 奶蛙这条回复的 message_id 是 9001
  await h.handle(event({ message_id: 2, message: '[CQ:reply,id=9001]哈哈真的吗' }));
  assert.equal(h.sent.length, 2);
  await h.handle(event({ message_id: 3, message: '[CQ:reply,id=1]我也觉得' }));
  assert.equal(h.sent.length, 2);
  // 另一个群里同样编号的消息不是奶蛙在这个群发的，不算引用奶蛙。
  await h.handle(event({ group_id: 201, message_id: 4, message: '[CQ:reply,id=9001]嗯' }));
  assert.equal(h.sent.length, 2);
});

test('日志：处理的每条消息按 messageKey 串起各阶段，不写正文、回复和昵称', async (t) => {
  const h = await setup(t);
  h.brain.chat = async () => '这是一条很私密的回复内容';
  await h.handle(event({ message: '我的银行卡密码是一二三', sender: { nickname: '真名小明', card: '群名片小明' } }));
  const key = 'qq:account:900:conversation:group:200:message:1';
  assert.deepEqual(h.logs.entries.filter((e) => e.messageKey === key).map((e) => e.event), ['message.accepted', 'message.done']);
  const [done] = h.logs.find('message.done');
  assert.equal(done.outcome, 'replied');
  assert.equal(done.recorded, true);
  assert.equal(done.sentMessageId, 9001);
  assert.ok(Number.isInteger(done.totalMs) && Number.isInteger(done.replyMs) && Number.isInteger(done.sendMs));
  const all = h.logs.lines.join('\n');
  for (const secret of ['银行卡密码', '私密的回复', '真名小明', '群名片小明']) assert.ok(!all.includes(secret), secret);
  // 发送时把消息 key 交给传输层，传输层的日志（排队、超时）也能按它关联。
  assert.deepEqual(h.sent[0].opts, { key });
});

test('日志：没叫到奶蛙或没有文字的消息，只在 debug 级别记下忽略原因', async (t) => {
  const h = await setup(t, { replyToAllGroupMessages: false });
  await h.handle(event({ message: '大家好' }));
  await h.handle(event({ message_id: 2, message: [{ type: 'image', data: { file: 'x.jpg' } }] }));
  assert.deepEqual(h.logs.entries.map((e) => [e.level, e.event, e.reason]), [
    ['debug', 'message.ignored', 'not_addressed'],
    ['debug', 'message.ignored', 'no_text'],
  ]);
});

test('发送结果未知（超时）：不记录，日志标明 delivery=unknown', async (t) => {
  const h = await setup(t);
  const client = {
    sendGroupMsg: async () => {
      throw new OneBotError('TIMEOUT', 'send_group_msg 超过 15000ms 没有响应，结果未知', { delivery: 'unknown', action: 'send_group_msg' });
    },
  };
  const handle = createQQHandler({
    fish: h.fish, brain: h.brain, getClient: () => client, persona: '测试角色', logger: h.logs.logger, replyToAllGroupMessages: true,
    clock: fixtureClock,
  });
  await handle(event());
  const [failed] = h.logs.find('send.failed');
  assert.equal(failed.delivery, 'unknown');
  assert.equal(failed.error.code, 'TIMEOUT');
  const [done] = h.logs.find('message.done');
  assert.equal(done.level, 'warn');
  assert.equal(done.outcome, 'send_failed');
  assert.equal(await h.fish.memory.count(), 0);
  assert.equal((await h.fish.character.state()).relationships.length, 0);
});
