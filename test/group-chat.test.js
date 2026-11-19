import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeOneBotMessage, MemoryInbox, ModelError, NOTICES, EMPTY_MENTION_REPLY, SILENT_MARK,
  Participation, GroupContext, formatGroupContext, isEmptyMention,
} from '../src/index.js';
import { createQQHandler } from '../src/qq-handler.js';
import { openFish, closeTestDb, captureLogger, waitFor } from './helpers.js';

// Module 7：群里什么时候说话（docs/module-07-group-chat-design.md 第 11 节）。
after(closeTestDb);

const EVENT_TIME = 1700000000;
const KEY = (id, group = 200) => `qq:account:900:conversation:group:${group}:message:${id}`;
const P = 'qq:user:101';

function event(overrides = {}) {
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: 900, user_id: 101, group_id: 200, message_id: 1, time: EVENT_TIME,
    sender: { nickname: '小甲' },
    message: [{ type: 'text', data: { text: '你好' } }], ...overrides,
  };
}
const msg = (overrides) => normalizeOneBotMessage(event(overrides));

// 手动触发的计时器：fire() 一次触发所有到期前设置的计时。
function fakeTimers() {
  const pending = new Map();
  let next = 0;
  return {
    setTimeout: (fn) => { next += 1; pending.set(next, fn); return next; },
    clearTimeout: (id) => { pending.delete(id); },
    get size() { return pending.size; },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

// 用真正的规则建一个处理器。h.say(...) 发一条消息（时间取当前假时钟、消息编号自动递增）。
async function setup(options = {}) {
  const fish = await openFish();
  const requests = [];
  const sent = [];
  const logs = captureLogger();
  const timers = fakeTimers();
  const inbox = new MemoryInbox();
  const h = { fish, requests, sent, logs, timers, inbox, clock: EVENT_TIME * 1000 + 5000, reply: () => '收到' };
  const brain = { chat: async (messages) => { requests.push(messages); return h.reply(messages); } };
  const client = {
    sendGroupMsg: async (id, message, opts) => ({ message_id: 9000 + sent.push({ kind: 'group', id, message, opts }) }),
    sendPrivateMsg: async (id, message, opts) => ({ message_id: 9000 + sent.push({ kind: 'private', id, message, opts }) }),
  };
  h.handle = createQQHandler({
    fish, brain, getClient: () => client, persona: '测试角色', now: () => new Date(h.clock),
    logger: logs.logger, clock: () => h.clock, inbox, timers, ...options,
  });
  let n = 0;
  h.say = (overrides = {}) => {
    n += 1;
    return h.handle(event({ time: Math.floor(h.clock / 1000), message_id: n, ...overrides }));
  };
  h.texts = () => sent.map((s) => s.message.find((x) => x.type === 'text').data.text);
  h.turns = async () => (await fish.db.query(
    'SELECT role, content FROM conversation_turns WHERE tenant_id = $1 ORDER BY id', [fish.tenantId],
  )).rows;
  h.status = async (id, group) => (await inbox.get(KEY(id, group)))?.status;
  h.outcome = async (id, group) => (await inbox.get(KEY(id, group)))?.outcome;
  return h;
}

// 让模型调用卡住，直到测试放行：gates[i](回复) 放行第 i 次。
function gate(h) {
  const gates = [];
  h.reply = () => new Promise((resolve) => gates.push(resolve));
  return gates;
}

const system = (request) => request[0].content;

// —— 判断规则 ——

test('判断：私聊、@、引用一定回；只 @ 不说话先等；开头叫它交给模型；名字在中间、@全体、群友聊天不说话', () => {
  const p = new Participation();
  const cases = [
    [{ message_type: 'private', sub_type: 'friend' }, 'reply', 'private'],
    [{ message: '[CQ:at,qq=900]推荐个奶茶' }, 'reply', 'mention'],
    [{ message: '[CQ:at,qq=900]' }, 'wait', 'empty_mention'],
    [{ message: '[CQ:at,qq=900] [CQ:at,qq=102]' }, 'wait', 'empty_mention'],
    [{ message: '[CQ:at,qq=900][CQ:image,file=a.jpg]' }, 'reply', 'mention'],
    [{ message: '奶蛙，你在干嘛' }, 'judge', 'name'],
    [{ message: '奶蛙你吃了吗' }, 'judge', 'name'],
    [{ message: '  奶蛙？' }, 'judge', 'name'],
    [{ message: '奶蛙' }, 'judge', 'name'],
    [{ message: '奶蛙表情包笑死' }, 'ignore', 'not_addressed'],
    [{ message: '这个奶蛙表情包笑死' }, 'ignore', 'not_addressed'],
    [{ message: '[CQ:at,qq=all]开会了' }, 'ignore', 'not_addressed'],
    [{ message: '大家晚上好' }, 'ignore', 'not_addressed'],
    [{ message: [{ type: 'image', data: { file: 'x.jpg' } }] }, 'ignore', 'not_addressed'],
  ];
  for (const [overrides, action, reason] of cases) {
    assert.deepEqual(p.classify(msg(overrides)), { action, reason }, JSON.stringify(overrides));
  }
  assert.deepEqual(p.classify(msg({ message: '[CQ:reply,id=5]哈哈' }), { quotesSelf: true }), { action: 'reply', reason: 'quote' });
  assert.equal(isEmptyMention(msg({ message: '[CQ:at,qq=900]  ' })), true);
  assert.equal(isEmptyMention(msg({ message: '[CQ:reply,id=5][CQ:at,qq=900]' })), false);
  // 不理的人：@ 也不理
  const ignoring = new Participation({ ignoreUsers: [P] });
  assert.deepEqual(ignoring.classify(msg({ message: '[CQ:at,qq=900]你好' })), { action: 'ignore', reason: 'ignored_user' });
  // 能叫它的名字可以配置
  const renamed = new Participation({ botNames: ['蛙蛙'] });
  assert.equal(renamed.classify(msg({ message: '蛙蛙你好' })).action, 'judge');
  assert.equal(renamed.classify(msg({ message: '奶蛙你好' })).action, 'ignore');
});

test('判断：接着说只看下一条，1 分钟内；奶蛙回了再给 1 分钟；同一个人 10 分钟最多回 20 次', () => {
  let now = 0;
  const p = new Participation({ now: () => now });
  const conv = msg().conversation.key;
  const next = () => p.classify(msg({ message: '要少糖的' }));
  assert.equal(next().action, 'ignore', '没叫过奶蛙');
  p.noteCalled(conv, P);
  now += 30_000;
  assert.deepEqual(next(), { action: 'judge', reason: 'follow_up' });
  assert.equal(next().action, 'ignore', '只看下一条');
  p.noteSent(conv, P);
  now += 60_000;
  assert.equal(next().action, 'judge', '奶蛙回了，再给 1 分钟');
  p.noteSent(conv, P);
  now += 60_001;
  assert.equal(next().action, 'ignore', '超过 1 分钟');
  // 别的群、别的人不受影响
  p.noteCalled(conv, P);
  assert.equal(p.classify(msg({ user_id: 102, message: '要少糖的' })).action, 'ignore');
  assert.equal(p.classify(msg({ group_id: 201, message: '要少糖的' })).action, 'ignore');

  const capped = new Participation({ now: () => now });
  for (let i = 0; i < 20; i += 1) capped.noteSent(conv, P, { reopen: false });
  assert.deepEqual(capped.classify(msg({ message: '[CQ:at,qq=900]你好' })), { action: 'ignore', reason: 'person_cap', notify: true });
  assert.deepEqual(capped.classify(msg({ message: '[CQ:at,qq=900]你好' })), { action: 'ignore', reason: 'person_cap', notify: false });
  assert.equal(capped.classify(msg({ user_id: 102, message: '[CQ:at,qq=900]你好' })).action, 'reply', '别人不受影响');
  assert.equal(capped.classify(msg({ message_type: 'private', sub_type: 'friend' })).action, 'reply', '私聊不受影响');
  now += 10 * 60_000;
  assert.equal(capped.classify(msg({ message: '[CQ:at,qq=900]你好' })).action, 'reply', '过了 10 分钟');
});

// —— 群里最近的聊天 ——

test('群里最近的聊天：最多 20 条、10 分钟内；每条超过 100 字截短，整段超过 1000 字先丢最早的；回复过的移走', () => {
  let now = 0;
  const ctx = new GroupContext({ now: () => now });
  const conv = msg().conversation.key;
  for (let i = 1; i <= 25; i += 1) ctx.add(msg({ message_id: i, user_id: 100 + (i % 3), message: `第${i}条` }));
  ctx.add(msg({ message_id: 25, message: '重复收到' }));
  let entries = ctx.recent(conv);
  assert.equal(entries.length, 20);
  assert.equal(entries[0].parts[0].text, '第6条');
  assert.equal(ctx.recent(conv, { excludeKey: KEY(25) }).length, 19);
  ctx.remove(conv, KEY(24));
  assert.equal(ctx.recent(conv).length, 19);
  assert.equal(ctx.countAfter(conv, KEY(20), 'qq:user:102'), 3, '第 21、22、23、25 条里不是 102 说的');
  now += 10 * 60_000 + 1;
  assert.deepEqual(ctx.recent(conv), [], '10 分钟以前的不要');

  ctx.add(msg({ message_id: 30, user_id: 102, message: '[CQ:at,qq=900][CQ:at,qq=103]看[CQ:image,file=a.jpg][CQ:reply,id=1]' }));
  ctx.add(msg({ message_id: 31, user_id: 103, message: '长'.repeat(150) }));
  now += 2 * 60_000;
  ctx.add(msg({ message_id: 32, user_id: 102, message: '[CQ:at,qq=all]  开会了 ' }));
  entries = ctx.recent(conv);
  const aliasOf = (key) => ({ 'qq:user:102': 'u2', 'qq:user:103': 'u3' })[key];
  const text = formatGroupContext(entries, { aliasOf, now });
  assert.equal(text, [
    '## 群里刚才在聊（只供理解，这些不是在跟你说话；从早到晚）',
    'u2（2 分钟前）：@奶蛙@u3看[图片][引用了一条消息]',
    `u3（2 分钟前）：${'长'.repeat(99)}…`,
    'u2（刚才）：@全体成员 开会了',
  ].join('\n'));
  // 整段超过上限：先丢最早的
  assert.equal(formatGroupContext(entries, { aliasOf, now, maxTotalChars: 130 }).split('\n').length, 3);
  assert.equal(formatGroupContext([], { aliasOf, now }), '');
});

// —— 只 @ 不说话 ——

test('只 @ 不说话：等待期间接着说了，只回接着说的那句，不发“干嘛蛙”', async () => {
  const h = await setup();
  await h.say({ message: '[CQ:at,qq=900]' });
  assert.equal(h.timers.size, 1);
  assert.equal(h.requests.length, 0);
  await h.say({ message: '帮我看看这个' });
  assert.equal(h.timers.size, 0, '计时已取消');
  assert.deepEqual(h.texts(), ['收到']);
  assert.match(system(h.requests[0]), /这个人刚才单独 @ 了你一下，这是他接着说的话/);
  assert.deepEqual([await h.status(1), await h.outcome(1)], ['skipped', 'merged']);
  assert.equal(await h.status(2), 'replied');
});

test('只 @ 不说话：一直没说，回固定的“干嘛蛙”，不调用模型，照常写进原话表', async () => {
  const h = await setup();
  await h.say({ message: '[CQ:at,qq=900]' });
  h.timers.fire();
  await waitFor(() => h.sent.length === 1, { what: '发出干嘛蛙' });
  await waitFor(async () => (await h.status(1)) === 'replied');
  assert.deepEqual(h.texts(), [EMPTY_MENTION_REPLY]);
  assert.equal(h.requests.length, 0);
  assert.equal(await h.outcome(1), 'fixed_reply');
  const turns = await h.turns();
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant']);
  assert.equal(turns[1].content, '干嘛蛙');
  assert.deepEqual(JSON.parse(turns[0].content).segments, [{ type: 'mention', toYou: true }]);

  // “干嘛蛙”发出以后才接着说：算新的一来一回，交给模型判断
  h.reply = () => SILENT_MARK;
  await h.say({ message: '没事了' });
  assert.equal(h.requests.length, 1);
  assert.match(system(h.requests[0]), /刚才和你说过话/);
  assert.equal(h.sent.length, 1, '模型说不用回，就不发');
});

test('只 @ 不说话：补充正好在第 8 秒到，只回一次', async () => {
  const h = await setup();
  await h.say({ message: '[CQ:at,qq=900]' });
  h.timers.fire(); // “干嘛蛙”排进队列……
  await h.say({ message: '在吗在吗' }); // ……还没发出去，补充就到了
  await waitFor(async () => (await h.status(1)) === 'skipped');
  assert.deepEqual(h.texts(), ['收到']);
  assert.equal(h.requests.length, 1);
  assert.equal(await h.outcome(1), 'merged');
});

test('只 @ 不说话：“干嘛蛙”排在别人后面还没发时补充到了，撤掉“干嘛蛙”，只回补充', async () => {
  const h = await setup();
  const gates = gate(h);
  const other = h.say({ user_id: 102, message: '[CQ:at,qq=900]先问一个' }); // 占着这个群的队列
  await waitFor(() => gates.length === 1);
  await h.say({ message: '[CQ:at,qq=900]' });
  h.timers.fire();
  const followUp = h.say({ message: '我想问个事' });
  gates[0]('先回答你');
  await other;
  await waitFor(() => gates.length === 2);
  gates[1]('好的你说');
  await followUp;
  await waitFor(async () => (await h.status(2)) === 'skipped');
  assert.deepEqual(h.texts(), ['先回答你', '好的你说']);
});

test('只 @ 不说话：等待期间群里别人的消息照常处理，不用等', async () => {
  const h = await setup();
  await h.say({ message: '[CQ:at,qq=900]' });
  await h.say({ user_id: 102, message: '[CQ:at,qq=900]我先说' });
  assert.deepEqual(h.texts(), ['收到']);
  h.timers.fire();
  await waitFor(() => h.sent.length === 2);
  assert.deepEqual(h.texts(), ['收到', EMPTY_MENTION_REPLY]);
});

test('只 @ 不说话：退出时还在等的就不发了', async () => {
  const h = await setup();
  await h.say({ message: '[CQ:at,qq=900]' });
  assert.equal(await h.handle.stop(1000), 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.sent.length, 0);
});

// —— 交给模型判断 ——

test('开头叫它：交给模型判断；模型说不用回就一个字都不发，不写原话表；名字在中间、@全体不理', async () => {
  const h = await setup();
  h.reply = () => SILENT_MARK;
  await h.say({ message: '奶蛙，永远的神' });
  assert.equal(h.requests.length, 1);
  assert.match(system(h.requests[0]), /以你的名字开头，但没有 @ 你/);
  assert.match(system(h.requests[0]), /只输出 \[不回复\]，不要用“？”“哦”之类的话凑一句/);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(await h.turns(), []);
  assert.deepEqual([await h.status(1), await h.outcome(1)], ['silent', 'model_silent']);

  h.reply = () => '在呢';
  await h.say({ message: '奶蛙你在干嘛' });
  assert.deepEqual(h.texts(), ['在呢']);
  await h.say({ user_id: 102, message: '这个奶蛙表情包笑死' });
  await h.say({ user_id: 102, message: '[CQ:at,qq=all]开会了' });
  assert.equal(h.requests.length, 2);
});

test('接着说：出错、限速、花费到上限都不出声；一定回的照常发提示', async () => {
  const h = await setup();
  h.reply = () => { throw new ModelError('SERVER_ERROR'); };
  await h.say({ message: '奶蛙你在吗' });
  await h.say({ user_id: 102, message: '奶蛙？' });
  h.reply = () => { throw new ModelError('BUDGET_EXCEEDED'); };
  await h.say({ user_id: 103, message: '奶蛙，在不在' });
  assert.equal(h.sent.length, 0);
  assert.deepEqual([await h.outcome(1), await h.outcome(2), await h.outcome(3)], ['judge_failed', 'judge_failed', 'budget_exceeded']);
  await h.say({ user_id: 104, message: '[CQ:at,qq=900]你好' });
  assert.deepEqual(h.texts(), [NOTICES.budget]);
});

test('接着说：@ 完 1 分钟内的下一条交给模型；回了再给 1 分钟；过了时间或者模型没回，就不再理', async () => {
  const h = await setup();
  await h.say({ message: '[CQ:at,qq=900]推荐个奶茶' });
  h.clock += 30_000;
  await h.say({ message: '要少糖的' });
  assert.equal(h.requests.length, 2);
  assert.match(system(h.requests[1]), /这个人刚才和你说过话/);
  h.reply = () => SILENT_MARK;
  h.clock += 30_000;
  await h.say({ message: '@小乙 你看这个' });
  assert.equal(h.requests.length, 3, '回了以后又给了 1 分钟');
  await h.say({ message: '哈哈' });
  assert.equal(h.requests.length, 3, '模型没回，这段对话结束');
  h.reply = () => '收到';
  await h.say({ message: '[CQ:at,qq=900]再问一个' });
  h.clock += 61_000;
  await h.say({ message: '还在吗' });
  assert.equal(h.requests.length, 4, '超过 1 分钟不再理');
});

// —— 防刷屏 ——

test('防刷屏：同一个人回得太多暂时不理（只提醒一次）；IGNORE_QQ 的人不理，他的话也不进群里最近的聊天', async () => {
  const h = await setup({ participation: new Participation({ personCapMax: 2, ignoreUsers: ['qq:user:666'] }) });
  for (let i = 0; i < 4; i += 1) await h.say({ message: `[CQ:at,qq=900]第${i}次` });
  assert.equal(h.sent.length, 2);
  assert.equal(h.logs.find('message.ignored').filter((e) => e.level === 'warn').length, 1);

  await h.say({ user_id: 666, message: '[CQ:at,qq=900]我是别的机器人' });
  await h.say({ user_id: 666, message: '机器人的悄悄话' });
  await h.say({ user_id: 102, message: '[CQ:at,qq=900]你好' });
  assert.equal(h.sent.length, 3);
  assert.ok(!JSON.stringify(h.requests).includes('机器人'), '不理的人的话不进提示');
});

test('回谁说清楚：奶蛙想回复时群里又有别人说了 2 条以上，引用原消息', async () => {
  const h = await setup();
  const gates = gate(h);
  const first = h.say({ message: '[CQ:at,qq=900]推荐个奶茶' });
  await waitFor(() => gates.length === 1);
  await h.say({ user_id: 102, message: '我要喝咖啡' });
  await h.say({ user_id: 103, message: '我也是' });
  gates[0]('杨枝甘露');
  await first;
  assert.deepEqual(h.sent[0].message, [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '杨枝甘露' } }]);

  const second = h.say({ message: '[CQ:at,qq=900]再推荐一个' });
  await waitFor(() => gates.length === 2);
  await h.say({ user_id: 102, message: '只插一句' });
  gates[1]('芋泥波波');
  await second;
  assert.deepEqual(h.sent[1].message, [{ type: 'text', data: { text: '芋泥波波' } }], '只插了 1 条，不引用');
});

// —— 群里最近的聊天放进提示 ——

test('群里最近的聊天：被叫到时放进提示，用代号；回复过的不重复；不写数据库；GROUP_CONTEXT=off 时没有这一段', async () => {
  const h = await setup();
  await h.say({ user_id: 102, message: '周末去哪玩' });
  await h.say({ user_id: 103, message: [{ type: 'text', data: { text: '这里' } }, { type: 'image', data: { file: 'x.jpg' } }] });
  await h.say({ message: '[CQ:at,qq=900]我们刚才在聊什么' });
  const section = system(h.requests[0]).split('\n\n').find((s) => s.startsWith('## 群里刚才在聊'));
  assert.match(section, /\nu\d+（刚才）：周末去哪玩\nu\d+（刚才）：这里\[图片\]$/);
  assert.ok(!section.includes('我们刚才在聊什么'), '这条本身不放');
  await h.say({ message: '[CQ:at,qq=900]还有呢' });
  assert.ok(!system(h.requests[1]).includes('我们刚才在聊什么'), '回复过的已经在对话历史里');
  const stored = JSON.stringify(await h.turns());
  assert.ok(!stored.includes('周末去哪玩'), '没叫奶蛙的话不写进原话表');

  const off = await setup({ groupContext: null });
  await off.say({ user_id: 102, message: '周末去哪玩' });
  await off.say({ message: '[CQ:at,qq=900]我们刚才在聊什么' });
  assert.ok(!system(off.requests[0]).includes('群里刚才在聊'));
});

test('私聊不受影响：只发图片也回，没有群里的聊天；提示里写明看不到图片内容，准则不再要求识别图片含义', async () => {
  const h = await setup();
  await h.say({ user_id: 102, message: '群里的悄悄话' });
  await h.say({ message_type: 'private', sub_type: 'friend', message: [{ type: 'image', data: { file: 'x.jpg' } }] });
  assert.equal(h.sent[0].kind, 'private');
  assert.ok(!system(h.requests[0]).includes('群里的悄悄话'));
  assert.match(system(h.requests[0]), /uninterpreted 表示尚未解析的非文本内容（例如图片、表情），你看不到它的内容，不要猜/);
  const rules = readFileSync(fileURLToPath(new URL('../persona/social-rules.md', import.meta.url)), 'utf8');
  assert.ok(!rules.includes('识别图片含义'));
  assert.match(rules, /只看到\[图片\]或未解析的图片时，你不知道图里是什么，不要猜/);
});
