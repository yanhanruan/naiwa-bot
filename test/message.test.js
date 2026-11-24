import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  entityKey, normalizeOneBotMessage, messageForModel, createAliasBook, OneBotError,
  ModelError, MessageInbox, MemoryInbox, RUNTIME_DEFAULTS, FactStore, writeFact, placeOf, Participation,
} from '../src/index.js';
import { createQQHandler, NOTICES } from '../src/qq-handler.js';
import { Mood } from '../src/mood/mood.js';
import { MOOD_TAG_RULE } from '../src/mood/prompt.js';
import { openFish, testDb, closeTestDb, captureLogger, waitFor, replyToEveryone, INSTANT_ROUNDS } from './helpers.js';

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

// 多数入口测试关注身份与记录，不关心群里什么时候说话，默认群里每条都按“明确叫它”处理，也不等别人说完；
// realRules: true 时用真正的规则（Module 7 的规则另有测试，见 test/group-chat.test.js）。
// runtime：传给 createQQHandler 的其他参数（inbox、clock、maxAgeMs……）。
async function setup(t, { realRules = false, ...runtime } = {}) {
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
    participation: realRules ? undefined : replyToEveryone(), ...INSTANT_ROUNDS, ...runtime,
  };
  const handle = createQQHandler(options);
  // 用同样的参数（可以替换其中几项）再建一个处理器，例如模拟重启、换一个 OneBot 客户端。
  const another = (overrides = {}) => createQQHandler({ ...options, ...overrides });
  return { fish, handle, stop: handle.stop, another, client, requests, sent, get errors() { return errors.list; }, brain, logs };
}

const userMessages = (request) => request.filter((m) => m.role === 'user').map((m) => JSON.parse(m.content));

// 这个租户写进原话表的条数（回复确实发出后才写）。
async function turnCount(h) {
  const { rows } = await h.fish.db.query('SELECT count(*)::int AS n FROM conversation_turns WHERE tenant_id = $1', [h.fish.tenantId]);
  return rows[0].n;
}

// 直接写一条事实（跳过提炼），测回复时取哪些事实。
async function addFact(h, { conversation, subject, item = 'profile', content, saidAt = new Date() }) {
  const place = placeOf(conversation);
  await h.fish.db.transaction((tx) => writeFact(tx, h.fish.tenantId, {
    subject: item === 'group_event' ? place.key : subject, item, content, place,
    sourceTurnIds: [], sourceQuote: content, sourceSpeakers: subject ? [subject] : [], saidAt,
  }));
}

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
});

test('真实入口函数：不同机器人账号、不同群的历史隔离', async (t) => {
  const h = await setup(t);
  await h.handle(event());
  await h.handle(event({ self_id: 901 }));
  await h.handle(event({ group_id: 201 }));
  assert.deepEqual(h.requests.map((r) => userMessages(r).length), [1, 1, 1]);
});

test('真实入口函数：同一人先私聊后群聊，私聊里记得的事不进群', async (t) => {
  const h = await setup(t);
  await addFact(h, { conversation: 'qq:account:900:conversation:private:101', subject: 'qq:user:101', content: '私聊专属内容' });
  await h.handle(event({ message_type: 'private', message: '在吗' }));
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

test('归一化保留纯图片和纯@（群里怎么处理见 test/group-chat.test.js）', () => {
  const image = normalizeOneBotMessage(event({ message: [{ type: 'image', data: { file: 'x.jpg' } }] }));
  assert.deepEqual(image.segments.map((s) => [s.type, s.sourceType]), [['opaque', 'image']]);
  const mention = normalizeOneBotMessage(event({ message: '[CQ:at,qq=900]' }));
  assert.deepEqual([mention.mentionsSelf, mention.text], [true, '']);
});

test('入口发送保留上游目标 ID 类型，数值和字符串输入使用同一会话', async (t) => {
  const h = await setup(t);
  await h.handle(event());
  await h.handle(event({ self_id: '900', group_id: '200', user_id: '101', message_id: '2' }));
  assert.equal(userMessages(h.requests[1]).length, 2);
  assert.deepEqual(h.sent.map((s) => s.id), [200, '200']);
});

test('真实入口函数：记得的事按地方取：群 A 的个人情况和群事不进群 B，群里说的称呼各群通用，私聊的不进群', async (t) => {
  const h = await setup(t);
  const groupA = 'qq:account:900:conversation:group:200';
  const dm = 'qq:account:900:conversation:private:101';
  await addFact(h, { conversation: groupA, subject: 'qq:user:101', item: 'call_name', content: '希望被叫“甲哥”' });
  await addFact(h, { conversation: groupA, subject: 'qq:user:101', content: '喜欢钓鱼' });
  await addFact(h, { conversation: groupA, item: 'group_event', content: '大家约了周六开黑' });
  await addFact(h, { conversation: dm, subject: 'qq:user:101', content: '不吃辣' });
  await h.handle(event({ message_id: 1 })); // 群 A
  await h.handle(event({ group_id: 201, message_id: 2 })); // 群 B
  await h.handle(event({ message_type: 'private', message_id: 3 })); // 私聊
  const [a, b, p] = h.requests.map((r) => promptSection(r, '你记得的事') ?? '');
  assert.match(a, /关于 u1（当前发言者）：\n- 希望被叫“甲哥”（今天）\n- 喜欢钓鱼（今天）\n这个群里的事：\n- 大家约了周六开黑（今天）/);
  assert.ok(!a.includes('不吃辣'));
  assert.equal(b.split('\n').slice(1).join('\n'), '关于 u1（当前发言者）：\n- 希望被叫“甲哥”（今天）');
  assert.ok(p.includes('不吃辣') && p.includes('甲哥') && !p.includes('钓鱼') && !p.includes('开黑'), p);
  assert.deepEqual(h.logs.find('memory.injected').map((e) => e.factIds.length), [3, 1, 2]);
});

test('入口模型失败记录内部错误，聊天对象只收到通用提示', async (t) => {
  const h = await setup(t);
  h.brain.chat = async () => { throw new Error('internal-provider-details'); };
  await h.handle(event());
  assert.equal(h.errors[0].event, 'reply.failed');
  assert.equal(h.errors[0].error.message, 'internal-provider-details');
  assert.equal(h.sent.length, 1);
  assert.ok(!JSON.stringify(h.sent).includes('internal-provider-details'));
  assert.equal(await turnCount(h), 0);
});

const sentTexts = (h) => h.sent.map((s) => s.message.find((x) => x.type === 'text').data.text);

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

test('同一会话同时只有一轮在看：看的时候来的几句攒成下一轮，一起看；后一轮看得到前一轮的对话', async (t) => {
  const h = await setup(t);
  const gates = gatedBrain(h);
  const first = h.handle(event({ message_id: 1, message: '第1条' }));
  await waitFor(() => gates.length === 1, { what: '第一轮在调用模型' });
  const rest = [2, 3].map((id) => h.handle(event({ message_id: id, message: `第${id}条` })));
  await waitFor(() => h.logs.find('message.accepted').length === 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gates.length, 1, '同一会话同时只应有一次模型调用');
  gates[0]();
  await first;
  await waitFor(() => gates.length === 2, { what: '第二轮在调用模型' });
  gates[1]();
  await Promise.all(rest);
  const history = h.requests[1].filter((m) => m.role !== 'system');
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(history[1].content, '[回 u1]\n回复1', '奶蛙以前的回复标着回谁');
  assert.deepEqual(history[2].content.split('\n').map((line) => JSON.parse(line).messageId), ['2', '3'], '第 2、3 条一起看，一行一句');
  assert.deepEqual(sentTexts(h), ['回复1', '回复2']);
  // 记录时每句还是单独一行，回复挂在他这一轮最后一句上。
  const { rows } = await h.fish.db.query(
    'SELECT role, message_key FROM conversation_turns WHERE tenant_id = $1 ORDER BY id', [h.fish.tenantId],
  );
  const key = (id) => `qq:account:900:conversation:group:200:message:${id}`;
  assert.deepEqual(rows.map((r) => [r.role, r.message_key]), [
    ['user', key(1)], ['assistant', key(1)], ['user', key(2)], ['user', key(3)], ['assistant', key(3)],
  ]);
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

test('同一会话排队太多：下一轮攒满了还没开始看，再来的不处理，记为 dropped', async (t) => {
  const inbox = new MemoryInbox();
  const h = await setup(t, { roundMaxMessages: 2, inbox });
  const gates = gatedBrain(h);
  const first = h.handle(event({ message_id: 1 }));
  await waitFor(() => gates.length === 1);
  const next = [2, 3].map((id) => h.handle(event({ message_id: id })));
  await waitFor(() => h.logs.find('message.accepted').length === 3);
  await h.handle(event({ message_id: 4 })); // 下一轮已经攒满，立即返回
  assert.equal(h.logs.find('message.dropped')[0].reason, 'queue_full');
  assert.equal((await inbox.get('qq:account:900:conversation:group:200:message:4')).status, 'dropped');
  gates[0]();
  await waitFor(() => gates.length === 2);
  gates[1]();
  await Promise.all([first, ...next]);
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
  assert.equal(await turnCount(h), 2);
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
    assert.equal(await turnCount(h), 0, c.error.code);
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

test('心情：模型写的心情那一行不发出去、不进原话表，心情往那边挪；只写了那一行就当不回复', async (t) => {
  const outputs = ['[回 u1]\n呜……好吧\n[心情 变差 u1]', '[心情 变差 u1]'];
  const prompts = [];
  const brain = { chat: async (messages) => { prompts.push(messages[0].content); return outputs[prompts.length - 1]; } };
  const h = await setup(t, { brain });
  const mood = new Mood({ db: h.fish.db, tenantId: h.fish.tenantId });
  await mood.set('平常');
  const handle = h.another({ mood, moodTexts: { 有点低落: '今天你有点低落。' } });
  await handle(event({ message_id: 1, message: '你真笨' }));
  assert.deepEqual(h.sent.map((s) => s.message), [[{ type: 'text', data: { text: '呜……好吧' } }]]);
  const { rows } = await h.fish.db.query("SELECT content FROM conversation_turns WHERE tenant_id = $1 AND role = 'assistant'", [h.fish.tenantId]);
  assert.deepEqual(rows.map((r) => r.content), ['呜……好吧']);
  assert.equal((await mood.current()).ripple.toFixed(2), '-0.25');
  assert.ok(prompts[0].includes(MOOD_TAG_RULE));
  assert.ok(!prompts[0].includes('## 现在的心情'), '平常不加心情那一段');
  const shift = h.logs.entries.find((e) => e.event === 'mood.shift');
  assert.deepEqual([shift.direction, shift.counted, shift.personKey], [-1, true, undefined], '日志不记是谁');

  await handle(event({ user_id: 102, message_id: 2, sender: { nickname: '小乙' }, message: '笨蛙' }));
  assert.equal(h.sent.length, 1, '只写了心情那一行：不发、不报错');
  assert.equal((await mood.current()).level, -1, '两个人说了它，挪到有点低落');
  assert.ok(h.errors.every((e) => e.event !== 'model.failed'));
});

test('心情：不是平常时，说明书里人设后面放这一档的说法；不用心情时说明书里没有心情的规则', async (t) => {
  const h = await setup(t);
  const mood = new Mood({ db: h.fish.db, tenantId: h.fish.tenantId });
  await mood.set('开心');
  await h.another({ mood, moodTexts: { 开心: '今天你心情不错。' } })(event({ message_id: 1 }));
  assert.ok(h.requests[0][0].content.startsWith('测试角色\n\n## 现在的心情\n今天你心情不错。'));
  await h.handle(event({ message_id: 2, group_id: 201 }));
  assert.ok(!h.requests[1][0].content.includes(MOOD_TAG_RULE));
  assert.ok(!h.requests[1][0].content.includes('## 现在的心情'));
});

test('重启后记得之前的对话：短期历史和代号都存在数据库里', async (t) => {
  const h = await setup(t);
  await h.handle(event({ message_id: 1, message: '我叫小甲' }));
  const restarted = h.another(); // 新的处理器：内存里什么都没有，只有同一个数据库
  await restarted(event({ message_id: 2, message: '我叫什么' }));
  const turns = h.requests[1].filter((m) => m.role !== 'system');
  assert.deepEqual(turns.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(JSON.parse(turns[0].content).segments[0].text, '我叫小甲');
  assert.equal(turns[1].content, '[回 u1]\n收到');
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
  assert.equal(promptSection(group, '你记得的事'), undefined);
  // 回到私聊：印象按全部互动算（3 次私聊 + 1 次群聊）
  await restarted(event({ message_type: 'private', sub_type: 'friend', message_id: 10, message: '又来私聊了' }));
  assert.match(promptSection(h.requests.at(-1), '当前发言者'), /你们聊过 4 次/);
});

test('重启后，有人引用奶蛙以前发的消息也算叫到它；消息记录能交出这些消息', async (t) => {
  const inbox = new MessageInbox({ db: await testDb(), tenantId: `test-${randomUUID()}` });
  const h = await setup(t, { inbox });
  await h.handle(event({ message_id: 1 })); // 奶蛙回复，发出的消息编号是 9001
  const sentMessageKeys = await inbox.recentSentMessages();
  assert.deepEqual(sentMessageKeys, ['qq:account:900:conversation:group:200:message:9001']);
  const restarted = h.another({ participation: new Participation(), sentMessageKeys });
  await restarted(event({ message_id: 5, message: '[CQ:reply,id=9001]你说得对' }));
  assert.equal(h.requests.length, 2, '引用了奶蛙重启前发的消息，应该回复');
  await restarted(event({ user_id: 103, message_id: 6, message: '[CQ:reply,id=9999]这条引用的不是奶蛙' }));
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
  assert.equal(await turnCount(h), 0);
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
  assert.equal(await turnCount(h), 0);
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
  assert.deepEqual(userMessages(h.requests[3]).map((m) => m.sender.alias), ['u1']);
});

test('回复已发出后保存失败：用户收到真实回复，错误只记日志', async (t) => {
  const h = await setup(t);
  h.fish.touch = async () => { throw new Error('ENOSPC'); };
  await h.handle(event());
  assert.deepEqual(sentTexts(h), ['收到']);
  assert.deepEqual(h.errors.map((e) => e.error.message), ['ENOSPC']);
});

test('发送失败不记录：历史和关系都不把未送达的回复当成已发生', async (t) => {
  const h = await setup(t);
  const client = { sendGroupMsg: async () => { throw new Error('未连接'); } };
  const handle = createQQHandler({
    fish: h.fish, brain: h.brain, getClient: () => client, persona: '测试角色',
    logger: h.logs.logger, participation: replyToEveryone(), clock: fixtureClock, ...INSTANT_ROUNDS,
  });
  await handle(event({ message: '第一句' }));
  assert.deepEqual(h.logs.find('send.failed').map((e) => e.error.message), ['未连接']);
  assert.equal(await turnCount(h), 0);
  assert.equal((await h.fish.character.state()).relationships.length, 0);

  await h.handle(event({ message_id: 2, message: '第二句' }));
  const history = h.requests[1].filter((m) => m.role !== 'system');
  assert.equal(history.length, 1);
  assert.ok(!JSON.stringify(history).includes('第一句'));
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

test('日志：没叫到奶蛙的消息（包括只有图片的），只在 debug 级别记下忽略原因', async (t) => {
  const h = await setup(t, { realRules: true });
  await h.handle(event({ message: '大家好' }));
  await h.handle(event({ message_id: 2, message: [{ type: 'image', data: { file: 'x.jpg' } }] }));
  assert.deepEqual(h.logs.entries.map((e) => [e.level, e.event, e.reason]), [
    ['debug', 'message.ignored', 'not_addressed'],
    ['debug', 'message.ignored', 'not_addressed'],
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
    fish: h.fish, brain: h.brain, getClient: () => client, persona: '测试角色', logger: h.logs.logger, participation: replyToEveryone(),
    clock: fixtureClock, ...INSTANT_ROUNDS,
  });
  await handle(event());
  const [failed] = h.logs.find('send.failed');
  assert.equal(failed.delivery, 'unknown');
  assert.equal(failed.error.code, 'TIMEOUT');
  const [done] = h.logs.find('message.done');
  assert.equal(done.level, 'warn');
  assert.equal(done.outcome, 'send_failed');
  assert.equal(await turnCount(h), 0);
  assert.equal((await h.fish.character.state()).relationships.length, 0);
});
