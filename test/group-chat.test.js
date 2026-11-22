import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeOneBotMessage, MemoryInbox, ModelError, NOTICES, EMPTY_MENTION_REPLY, SILENT_MARK, RUNTIME_DEFAULTS,
  Participation, GroupContext, formatGroupContext, isEmptyMention, splitReplies, renderTurn, deletePersonData,
} from '../src/index.js';
import { createQQHandler } from '../src/qq-handler.js';
import { openFish, closeTestDb, captureLogger, waitFor } from './helpers.js';

// Module 7：群里什么时候说话（docs/module-07-group-chat-design.md 第 11 节）；
// 连着发的一起看、留意 30 秒（docs/module-07b-burst-merge-design.md 第 11 节）。
after(closeTestDb);

const EVENT_TIME = 1700000000;
const KEY = (id, group = 200) => `qq:account:900:conversation:group:${group}:message:${id}`;
const P = 'qq:user:101';
const AT = '[CQ:at,qq=900]';

function event(overrides = {}) {
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: 900, user_id: 101, group_id: 200, message_id: 1, time: EVENT_TIME,
    sender: { nickname: '小甲' },
    message: [{ type: 'text', data: { text: '你好' } }], ...overrides,
  };
}
const msg = (overrides) => normalizeOneBotMessage(event(overrides));

// 假的计时器，跟着 h.clock 走：advance(ms) 让时间往前走，到点的按先后触发；fireAll() 不管到没到点全部触发。
function fakeTimers(h) {
  const pending = new Map();
  let next = 0;
  return {
    setTimeout: (fn, ms = 0) => {
      next += 1;
      pending.set(next, { fn, due: h.clock + Math.max(0, ms) });
      return next;
    },
    clearTimeout: (id) => { pending.delete(id); },
    get size() { return pending.size; },
    async advance(ms) {
      const target = h.clock + ms;
      for (;;) {
        let first = null;
        for (const [id, t] of pending) if (t.due <= target && (!first || t.due < first.t.due)) first = { id, t };
        if (!first) break;
        pending.delete(first.id);
        h.clock = Math.max(h.clock, first.t.due);
        first.t.fn();
        await new Promise((resolve) => setImmediate(resolve)); // 让刚开始的处理走一走
      }
      h.clock = target;
    },
    fireAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) t.fn();
    },
  };
}

// 用真正的规则建一个处理器。h.say(...) 发一条消息（时间取当前假时钟、消息编号自动递增），返回的 Promise 在这条处理完时 resolve；
// h.advance(ms) 让时间往前走。options 也可以是 (h) => options，方便用 h.clock 建自己的规则。
async function setup(options = {}) {
  const fish = await openFish();
  const requests = [];
  const sent = [];
  const logs = captureLogger();
  const inbox = new MemoryInbox();
  const h = { fish, requests, sent, logs, inbox, clock: EVENT_TIME * 1000 + 5000, reply: () => '收到' };
  h.timers = fakeTimers(h);
  h.advance = (ms) => h.timers.advance(ms);
  const brain = { chat: async (messages, opts) => { requests.push(messages); h.lastOpts = opts; return h.reply(messages); } };
  const client = {
    sendGroupMsg: async (id, message, opts) => ({ message_id: 9000 + sent.push({ kind: 'group', id, message, opts }) }),
    sendPrivateMsg: async (id, message, opts) => ({ message_id: 9000 + sent.push({ kind: 'private', id, message, opts }) }),
  };
  // 等待时间用短一点的（停 3 秒、最多 10 秒），测试好写；机制和线上一样。线上默认值另有测试。
  h.handle = createQQHandler({
    fish, brain, getClient: () => client, persona: '测试角色', now: () => new Date(h.clock),
    logger: logs.logger, clock: () => h.clock, inbox, timers: h.timers, roundQuietMs: 3000, roundMaxWaitMs: 10_000,
    ...(typeof options === 'function' ? options(h) : options),
  });
  let n = 0;
  h.say = (overrides = {}) => {
    n += 1;
    return h.handle(event({ time: Math.floor(h.clock / 1000), message_id: n, ...overrides }));
  };
  // 说一句，等 3 秒（测试里的停顿），等这一轮看完。
  h.round = async (overrides) => {
    const done = h.say(overrides);
    await h.advance(3000);
    await done;
  };
  h.texts = () => sent.map((s) => s.message.find((x) => x.type === 'text').data.text);
  h.turns = async () => (await fish.db.query(
    'SELECT id, role, content, message_key, created_at FROM conversation_turns WHERE tenant_id = $1 ORDER BY id', [fish.tenantId],
  )).rows;
  h.status = async (id, group) => (await inbox.get(KEY(id, group)))?.status;
  h.outcome = async (id, group) => (await inbox.get(KEY(id, group)))?.outcome;
  h.warns = (event) => logs.find(event).filter((e) => e.level === 'warn');
  return h;
}

// 让模型调用卡住，直到测试放行：gates[i](回复) 放行第 i 次。
function gate(h) {
  const gates = [];
  h.reply = () => new Promise((resolve) => gates.push(resolve));
  return gates;
}

const system = (request) => request[0].content;
const section = (request, title) => system(request).split('\n\n').find((s) => s.startsWith(`## ${title}`));
// 这一轮的几句（最后一条用户消息，一行一句）。
const roundLines = (request) => request.at(-1).content.split('\n').map((line) => JSON.parse(line));
const replyQuote = (id) => ({ type: 'reply', data: { id: String(id) } });
const text = (t) => ({ type: 'text', data: { text: t } });

// —— 判断规则 ——

test('判断：私聊、@、引用是明确叫它；只 @ 不说话先等；开头叫名字交给模型；名字在中间、@全体、群友聊天不看', () => {
  const p = new Participation();
  const cases = [
    [{ message_type: 'private', sub_type: 'friend' }, 'explicit', 'private'],
    [{ message: `${AT}推荐个奶茶` }, 'explicit', 'mention'],
    [{ message: `[CQ:reply,id=5]${AT}你觉得他说得对吗` }, 'explicit', 'mention'], // 引用了别人，但 @ 了它
    [{ message: AT }, 'wait', 'empty_mention'],
    [{ message: `${AT} [CQ:at,qq=102]` }, 'wait', 'empty_mention'],
    [{ message: `${AT}[CQ:image,file=a.jpg]` }, 'explicit', 'mention'],
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
    const got = p.classify(msg(overrides));
    assert.deepEqual({ action: got.action, reason: got.reason }, { action, reason }, JSON.stringify(overrides));
  }
  assert.equal(p.classify(msg({ message: '奶蛙，你在干嘛' })).name, '奶蛙', '带上叫到的名字');
  assert.deepEqual(p.classify(msg({ message: '[CQ:reply,id=5]哈哈' }), { quotesSelf: true }), { action: 'explicit', reason: 'quote' });
  assert.equal(isEmptyMention(msg({ message: `${AT}  ` })), true);
  assert.equal(isEmptyMention(msg({ message: `[CQ:reply,id=5]${AT}` })), false);
  // 不理的人：@ 也不理
  const ignoring = new Participation({ ignoreUsers: [P] });
  assert.deepEqual(ignoring.classify(msg({ message: `${AT}你好` })), { action: 'ignore', reason: 'ignored_user' });
  // 能叫它的名字可以配置
  const renamed = new Participation({ botNames: ['蛙蛙'] });
  assert.equal(renamed.classify(msg({ message: '蛙蛙你好' })).action, 'judge');
  assert.equal(renamed.classify(msg({ message: '奶蛙你好' })).action, 'ignore');
});

test('判断：留意 30 秒，期间说几句都看；奶蛙回了再续 30 秒；看了没回就不再留意；同一个人 10 分钟最多回 20 条', () => {
  let now = 0;
  const p = new Participation({ now: () => now });
  const conv = msg().conversation.key;
  const next = () => p.classify(msg({ message: '要少糖的' }));
  assert.equal(next().action, 'ignore', '没叫过奶蛙');
  p.noteCalled(conv, P);
  now += 20_000;
  assert.deepEqual([next().action, next().reason], ['judge', 'follow_up']);
  assert.equal(next().action, 'judge', '不是只看下一句：30 秒内都看');
  assert.equal(p.classify(msg({ message: '奶蛙，还有呢' })).reason, 'name', '开头叫名字的，按叫名字算');
  now += 10_001;
  assert.equal(next().action, 'ignore', '超过 30 秒');
  p.noteSent(conv, P);
  now += 30_000;
  assert.equal(next().action, 'judge', '奶蛙回了，再留意 30 秒');
  p.dismiss(conv, P);
  assert.equal(next().action, 'ignore', '看了没回：马上不再留意');
  p.noteSent(conv, P, { reopen: false });
  assert.equal(next().action, 'ignore', '固定提示不续留意');
  // 别的群、别的人不受影响
  p.noteCalled(conv, P);
  assert.equal(p.classify(msg({ user_id: 102, message: '要少糖的' })).action, 'ignore');
  assert.equal(p.classify(msg({ group_id: 201, message: '要少糖的' })).action, 'ignore');

  const capped = new Participation({ now: () => now });
  for (let i = 0; i < 20; i += 1) capped.noteSent(conv, P, { reopen: false });
  assert.deepEqual(capped.classify(msg({ message: `${AT}你好` })), { action: 'ignore', reason: 'person_cap', notify: true });
  assert.deepEqual(capped.classify(msg({ message: `${AT}你好` })), { action: 'ignore', reason: 'person_cap', notify: false });
  assert.equal(capped.classify(msg({ user_id: 102, message: `${AT}你好` })).action, 'explicit', '别人不受影响');
  assert.equal(capped.classify(msg({ message_type: 'private', sub_type: 'friend' })).action, 'explicit', '私聊不受影响');
  now += 10 * 60_000;
  assert.equal(capped.classify(msg({ message: `${AT}你好` })).action, 'explicit', '过了 10 分钟');
});

test('读懂回复：[回 u3] 分条，【回U3】、[回u3] 也认；没写回谁的单独一条；单独一行的 [不回复] 去掉，夹着 [不回复] 的那条不发', () => {
  assert.deepEqual(splitReplies('[回 u3]\n试试\n杨枝甘露\n【回U5】会呀'), [{ alias: 'u3', text: '试试\n杨枝甘露' }, { alias: 'u5', text: '会呀' }]);
  assert.deepEqual(splitReplies('[回u3] 好的'), [{ alias: 'u3', text: '好的' }]);
  assert.deepEqual(splitReplies('好的'), [{ alias: null, text: '好的' }]);
  assert.deepEqual(splitReplies('先说一句\n[回 u3]\n再说一句'), [{ alias: null, text: '先说一句' }, { alias: 'u3', text: '再说一句' }]);
  assert.deepEqual(splitReplies(SILENT_MARK), []);
  assert.deepEqual(splitReplies(`[回 u3]\n收到\n${SILENT_MARK}`), [{ alias: 'u3', text: '收到' }]);
  assert.deepEqual(splitReplies(`[回 u3]\n嗯${SILENT_MARK}\n[回 u5]\n好`), [{ alias: 'u5', text: '好' }]);
  assert.deepEqual(splitReplies('[回 某人]\n你好'), [{ alias: '?', text: '你好' }], '写了认不出的人：标成 ?，之后会被丢掉');
  assert.deepEqual(splitReplies('[回 u3]\n  '), []);
});

// —— 群里最近的聊天 ——

test('群里最近的聊天：最多 20 条、10 分钟内；每条超过 100 字截短，整段超过 1000 字先丢最早的；回复过的移走；可以去掉这一轮自己的几句', () => {
  let now = 0;
  const ctx = new GroupContext({ now: () => now });
  const conv = msg().conversation.key;
  for (let i = 1; i <= 25; i += 1) ctx.add(msg({ message_id: i, user_id: 100 + (i % 3), message: `第${i}条` }));
  ctx.add(msg({ message_id: 25, message: '重复收到' }));
  let entries = ctx.recent(conv);
  assert.equal(entries.length, 20);
  assert.equal(entries[0].parts[0].text, '第6条');
  assert.equal(ctx.recent(conv, { beforeKey: KEY(25) }).length, 19);
  assert.deepEqual(ctx.recent(conv, { beforeKey: KEY(10) }).map((e) => e.parts[0].text), ['第6条', '第7条', '第8条', '第9条'], '只取这条之前的');
  assert.deepEqual(ctx.recent(conv, { beforeKey: KEY(10), exclude: [KEY(7), KEY(9)] }).map((e) => e.parts[0].text), ['第6条', '第8条'], '这一轮自己的几句不放');
  assert.deepEqual(ctx.recent(conv, { beforeKey: KEY(3) }), [], '这条已经被挤出去：剩下的都比它晚');
  ctx.remove(conv, KEY(24));
  assert.equal(ctx.recent(conv).length, 19);
  assert.equal(ctx.countAfter(conv, KEY(20), 'qq:user:102'), 3, '第 21、22、23、25 条里不是 102 说的');
  assert.equal(ctx.countAfter(conv, KEY(3), 'qq:user:102'), Infinity, '被挤出去了：后面又来了很多条');
  const textless = new GroupContext({ keepText: false, now: () => now });
  textless.add(msg({ message: '不记内容' }));
  assert.deepEqual(textless.recent(conv)[0].parts, [], 'GROUP_CONTEXT=off：只记谁说了话，不记内容');
  now += 10 * 60_000 + 1;
  assert.deepEqual(ctx.recent(conv), [], '10 分钟以前的不要');

  ctx.add(msg({ message_id: 30, user_id: 102, message: `${AT}[CQ:at,qq=103]看[CQ:image,file=a.jpg][CQ:reply,id=1]` }));
  ctx.add(msg({ message_id: 31, user_id: 103, message: '长'.repeat(150) }));
  now += 2 * 60_000;
  ctx.add(msg({ message_id: 32, user_id: 102, message: '[CQ:at,qq=all]  开会了 ' }));
  entries = ctx.recent(conv);
  const aliasOf = (key) => ({ 'qq:user:102': 'u2', 'qq:user:103': 'u3' })[key];
  assert.equal(formatGroupContext(entries, { aliasOf, now }), [
    '## 群里刚才在聊（只供理解，这些不是在跟你说话；从早到晚）',
    'u2（2 分钟前）：@奶蛙@u3看[图片][引用了一条消息]',
    `u3（2 分钟前）：${'长'.repeat(99)}…`,
    'u2（刚才）：@全体成员 开会了',
  ].join('\n'));
  // 整段超过上限：先丢最早的
  assert.equal(formatGroupContext(entries, { aliasOf, now, maxTotalChars: 130 }).split('\n').length, 3);
  assert.equal(formatGroupContext([], { aliasOf, now }), '');
  // 还没有代号的人（只在旁边说话）：这一段里临时叫 x1、x2
  const partial = formatGroupContext(entries, { aliasOf: (key) => (key === 'qq:user:102' ? 'u2' : undefined), now });
  assert.equal(partial.split('\n')[1], '（x1、x2 这样的是还没有代号的人，只在这一段里用）');
  assert.match(partial, /\nu2（2 分钟前）：@奶蛙@x1看/);
  assert.match(partial, /\nx1（2 分钟前）：长/);
});

// —— 一轮：连着发的一起看 ——

test('一轮：@ 奶蛙连发三句，别人插话不拖长等待，他停 3 秒一起看，只调一次模型；每句单独记，回复挂在最后一句上', async () => {
  const h = await setup();
  const done = [h.say({ message: `${AT}推荐个奶茶` })];
  await h.advance(2000);
  done.push(h.say({ message: '不要太甜' }));
  await h.advance(1000);
  await h.say({ user_id: 102, message: '今天好热' }); // 别人说话：不进这一轮，也不拖长等待
  await h.advance(1000);
  done.push(h.say({ message: '要大杯' }));
  await h.advance(2999);
  assert.equal(h.requests.length, 0, '小甲还没停满 3 秒');
  await h.advance(1);
  await Promise.all(done);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(roundLines(h.requests[0]).map((m) => m.messageId), ['1', '2', '4'], '一行一句，每句带着自己的编号');
  assert.deepEqual(roundLines(h.requests[0]).map((m) => m.sender.alias), ['u1', 'u1', 'u1']);
  assert.equal(section(h.requests[0], '这一轮'), [
    '## 这一轮', '最后一条用户消息是这一轮的几句话（一行一句，从早到晚）。这一轮里：', 'u1 @ 了你：要回他。',
  ].join('\n'), '只有明确叫它的人：不说“可以不回”');
  assert.match(section(h.requests[0], '群里刚才在聊'), /x1（刚才）：今天好热$/, '别人的话在“群里刚才在聊”里');
  assert.match(section(h.requests[0], '消息格式'), /每条回复前单独一行写 \[回 u3\]/);
  assert.equal(h.lastOpts.key, KEY(4), '日志关联用这一轮最后一句');
  assert.deepEqual(h.texts(), ['收到']);
  const turns = await h.turns();
  assert.deepEqual(turns.map((t) => [t.role, t.message_key]), [
    ['user', KEY(1)], ['user', KEY(2)], ['user', KEY(4)], ['assistant', KEY(4)],
  ]);
  assert.deepEqual(await Promise.all([1, 2, 4].map((id) => h.status(id))), ['replied', 'replied', 'replied']);
  assert.equal((await h.inbox.get(KEY(4))).sentMessageId, '9001', '发出的消息编号存在挂回复的那句上');
  assert.equal((await h.inbox.get(KEY(1))).sentMessageId, undefined);
});

test('一轮（线上默认）：停 7 秒没说话才看，隔 4 秒一句一句打的并成一次；一直在打，从第一句算起满 15 秒就不等了', async () => {
  assert.deepEqual([RUNTIME_DEFAULTS.roundQuietMs, RUNTIME_DEFAULTS.roundMaxWaitMs], [7000, 15_000]);
  const h = await setup({ roundQuietMs: undefined, roundMaxWaitMs: undefined });
  const done = [h.say({ message: `${AT}推荐个奶茶` })];
  await h.advance(4000);
  done.push(h.say({ message: '不要太甜' }));
  await h.advance(4000);
  done.push(h.say({ message: '要大杯' }));
  await h.advance(6999);
  assert.equal(h.requests.length, 0, '他还没停满 7 秒');
  await h.advance(1);
  await Promise.all(done);
  assert.deepEqual(roundLines(h.requests[0]).map((m) => m.messageId), ['1', '2', '3']);
  assert.deepEqual(h.texts(), ['收到'], '只回一次');

  await h.advance(60_000);
  const typing = [h.say({ user_id: 102, message: `${AT}第1句` })];
  for (let i = 2; i <= 4; i += 1) {
    await h.advance(4500);
    typing.push(h.say({ user_id: 102, message: `第${i}句` }));
  }
  await h.advance(1499); // 第 4 句在 13.5 秒；还没停满 7 秒，但到 15 秒就不等了
  assert.equal(h.requests.length, 1);
  await h.advance(1);
  await Promise.all(typing);
  assert.equal(roundLines(h.requests[1]).length, 4);
});

test('一轮：从第一句算起最多等 10 秒；攒到 5 句马上看', async () => {
  const h = await setup();
  const done = [h.say({ message: `${AT}第1句` })];
  for (let i = 2; i <= 4; i += 1) {
    await h.advance(2500);
    done.push(h.say({ message: `第${i}句` }));
  }
  await h.advance(2499); // 第 4 句在 7.5 秒；没停满 3 秒，但到 10 秒就不等了
  assert.equal(h.requests.length, 0);
  await h.advance(1);
  await Promise.all(done);
  assert.equal(h.requests.length, 1);
  assert.equal(roundLines(h.requests[0]).length, 4);

  await h.advance(60_000);
  const five = [1, 2, 3, 4, 5].map((i) => h.say({ user_id: 102, message: `${AT}问${i}` }));
  await Promise.all(five); // 不用等计时：第 5 句一到就开始看
  assert.equal(h.requests.length, 2);
  assert.equal(roundLines(h.requests[1]).length, 5);
});

test('一轮：先说一句没叫奶蛙的，再 @ 奶蛙连说两句：后两句一起看，前一句只在“群里刚才在聊”里', async () => {
  const h = await setup();
  await h.say({ message: '哈哈' });
  await h.advance(5000);
  const done = [h.say({ message: `${AT}喝什么奶茶` })];
  await h.advance(1000);
  done.push(h.say({ message: '不要太甜' }));
  await h.advance(3000);
  await Promise.all(done);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(roundLines(h.requests[0]).map((m) => m.messageId), ['2', '3']);
  const nearby = section(h.requests[0], '群里刚才在聊');
  assert.match(nearby, /哈哈/);
  assert.ok(!nearby.includes('不要太甜') && !nearby.includes('喝什么奶茶'), '这一轮自己的几句不重复放');
  assert.ok(!JSON.stringify(await h.turns()).includes('哈哈'), '没叫奶蛙的话不写进原话表');
});

test('一轮：两个人一起问，一次看完，分别回两条；回了两个人，每条都引用对应那个人的话', async () => {
  const h = await setup();
  h.reply = () => '[回 u1]\n试试少糖的杨枝甘露\n[回 u2]\n会呀，就是跑调';
  const done = [h.say({ message: `${AT}推荐个奶茶` })];
  await h.advance(1000);
  done.push(h.say({ user_id: 102, message: `${AT}你会唱歌吗` }));
  await h.advance(3000);
  await Promise.all(done);
  assert.equal(h.requests.length, 1);
  assert.match(section(h.requests[0], '这一轮'), /\nu1 @ 了你：要回他。\nu2 @ 了你：要回他。$/);
  assert.match(section(h.requests[0], '当前发言者'), /代号 u1，QQ 昵称「小甲」。[\s\S]*\n代号 u2，QQ 昵称「小甲」。/);
  assert.deepEqual(h.sent.map((s) => s.message), [
    [replyQuote(1), text('试试少糖的杨枝甘露')],
    [replyQuote(2), text('会呀，就是跑调')],
  ]);
  const turns = await h.turns();
  assert.deepEqual(turns.map((t) => [t.role, t.message_key]), [
    ['user', KEY(1)], ['assistant', KEY(1)], ['user', KEY(2)], ['assistant', KEY(2)],
  ]);
  assert.deepEqual([await h.status(1), await h.status(2)], ['replied', 'replied']);
});

test('一轮：模型的回复最多发 3 条；写了不在这一轮的人丢掉；没写回谁的，一个人就是回他，几个人当回最后说话的；都记警告', async () => {
  const h = await setup();
  h.reply = () => '[回 u1]\n一\n[回 u9]\n不在这一轮\n[回 u1]\n二\n[回 u1]\n三\n[回 u1]\n四';
  await h.round({ message: `${AT}数数` });
  assert.deepEqual(h.texts(), ['一', '二', '三']);
  assert.equal(h.warns('reply.unknown_target').length, 1);
  assert.equal(h.warns('reply.too_many').length, 1);
  assert.deepEqual((await h.turns()).map((t) => t.content).slice(1), ['一', '二', '三'], '发出的每条各记一行');

  h.reply = () => '好的';
  await h.advance(60_000);
  await h.round({ message: `${AT}没写回谁` });
  assert.equal(h.texts().at(-1), '好的', '一个人：就是回他');
  assert.equal(h.warns('reply.unlabeled').length, 0);

  await h.advance(60_000);
  const done = [h.say({ user_id: 102, message: `${AT}我先问` })];
  done.push(h.say({ user_id: 103, message: `${AT}我后问` }));
  await h.advance(3000);
  await Promise.all(done);
  assert.equal(h.warns('reply.unlabeled').length, 1);
  assert.equal(h.warns('reply.model_silent').length, 1, '明确叫它的 u2 没被回：记警告');
  assert.deepEqual(h.sent.at(-1).message, [text('好的')], '当成回最后说话的人；只回了一个人、他后面没人说话，不用引用');
  assert.deepEqual([await h.status(3), await h.status(4)], ['silent', 'replied']);
});

test('一轮：开头叫名字（没 @）也开始一轮，交给模型；模型说不用回就一个字都不发，不写原话表；名字在中间、@全体不看', async () => {
  const h = await setup();
  h.reply = () => SILENT_MARK;
  await h.round({ message: '奶蛙，永远的神' });
  assert.equal(h.requests.length, 1);
  const round = section(h.requests[0], '这一轮');
  assert.match(round, /u1 用你的名字开头，但没有 @ 你：可能是在叫你，也可能只是在聊“奶蛙”这个梗。/);
  assert.match(round, /不是在跟你说话，或者没什么可说，就不回他，不要用“？”“哦”之类的话凑一句。谁都不用回时，只输出 \[不回复\]。/);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(await h.turns(), []);
  assert.deepEqual([await h.status(1), await h.outcome(1)], ['silent', 'model_silent']);
  assert.equal(h.warns('reply.model_silent').length, 0, '没明确叫它：不回不算问题');

  h.reply = () => '在呢';
  await h.round({ message: '奶蛙你在干嘛' });
  assert.deepEqual(h.texts(), ['在呢']);
  await h.round({ user_id: 102, message: '这个奶蛙表情包笑死' });
  await h.round({ user_id: 102, message: '[CQ:at,qq=all]开会了' });
  assert.equal(h.requests.length, 2);
});

test('一轮：提示里写的是叫到的那个名字（名字可以配置）', async () => {
  const h = await setup({ botNames: ['小蛙', '蛙蛙'] });
  h.reply = () => SILENT_MARK;
  await h.round({ message: '蛙蛙，在吗' });
  assert.match(section(h.requests[0], '这一轮'), /也可能只是在聊“蛙蛙”这个梗/);
  await h.round({ user_id: 102, message: '奶蛙，在吗' });
  assert.equal(h.requests.length, 1, '不是它的名字');
});

// —— 留意 ——

test('留意：叫过或回过的人 30 秒内没 @ 也交给模型；回了再续 30 秒；模型看了没回就不再留意，他之后不叫奶蛙的话不看', async () => {
  const h = await setup();
  await h.round({ message: `${AT}推荐个奶茶` }); // 3 秒时回了：留意到 33 秒
  await h.advance(10_000);
  await h.round({ message: '大杯的有吗' }); // 16 秒时回了：留意到 46 秒
  assert.equal(h.requests.length, 2);
  assert.match(section(h.requests[1], '这一轮'), /u1 刚才和你聊过，这几句没有叫你：可能是接着跟你说，也可能是在跟别人说。/);
  h.reply = () => SILENT_MARK;
  await h.advance(14_000);
  await h.round({ message: '[CQ:at,qq=102] 你喝过没' });
  assert.equal(h.requests.length, 3, '还在留意，请模型看');
  await h.advance(5000);
  await h.round({ message: '那家店在哪' });
  assert.equal(h.requests.length, 3, '模型没回他：不再留意');

  h.reply = () => '收到';
  await h.round({ message: `${AT}再问一个` });
  await h.advance(31_000);
  await h.round({ message: '还在吗' });
  assert.equal(h.requests.length, 4, '超过 30 秒不再看');
});

test('留意：模型在想的时候他又补了一句，进下一轮；上一轮回了他，下一轮照常看，能看到刚才的一问一答', async () => {
  const h = await setup();
  const gates = gate(h);
  const first = h.say({ message: `${AT}推荐个奶茶` });
  await h.advance(3000);
  await waitFor(() => gates.length === 1, { what: '第一轮在调用模型' });
  const second = h.say({ message: '要少糖的' });
  await h.advance(3000);
  assert.equal(gates.length, 1, '同一个群同时只有一轮在看');
  gates[0]('试试杨枝甘露');
  await first;
  await waitFor(() => gates.length === 2, { what: '下一轮在调用模型' });
  const history = h.requests[1].filter((m) => m.role !== 'system');
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(history[1].content, '[回 u1]\n试试杨枝甘露');
  assert.deepEqual(roundLines(h.requests[1]).map((m) => m.messageId), ['2']);
  gates[1](SILENT_MARK);
  await second;
  assert.deepEqual(h.texts(), ['试试杨枝甘露']);
});

test('留意：下一轮开始前，模型刚看过、没回的人，他只因为留意才进下一轮的几句作废；一句不剩就不调用模型', async () => {
  const h = await setup();
  await h.round({ message: `${AT}推荐个奶茶` }); // 回了：留意他
  const gates = gate(h);
  const second = h.say({ message: '哈哈' });
  await h.advance(3000);
  await waitFor(() => gates.length === 1);
  const third = h.say({ message: '你们看这个' }); // 还在留意：攒进下一轮
  await h.advance(3000);
  gates[0](SILENT_MARK); // 模型看了“哈哈”，不回他：不再留意，下一轮里他的话作废
  await Promise.all([second, third]);
  assert.equal(h.requests.length, 2, '作废的那一轮不调用模型');
  assert.deepEqual([await h.status(3), await h.outcome(3)], ['skipped', 'voided']);
  assert.deepEqual([await h.status(2), await h.outcome(2)], ['silent', 'model_silent']);
});

test('留意：下一轮里他又明确叫了奶蛙，就不作废', async () => {
  const h = await setup();
  await h.round({ message: `${AT}推荐个奶茶` });
  const gates = gate(h);
  const second = h.say({ message: '哈哈' });
  await h.advance(3000);
  await waitFor(() => gates.length === 1);
  const third = h.say({ message: `${AT}你怎么不理我` });
  await h.advance(3000);
  gates[0](SILENT_MARK);
  await waitFor(() => gates.length === 2, { what: '他明确叫了：下一轮照常看' });
  gates[1]('理你理你');
  await Promise.all([second, third]);
  assert.deepEqual(h.texts(), ['收到', '理你理你']);
});

// —— 只 @ 不说话 ——

test('只 @ 不说话：8 秒内补了话，连同那个 @ 一起放进一轮，只回补的话，不发“干嘛蛙”', async () => {
  const h = await setup();
  await h.say({ message: AT });
  assert.equal(h.timers.size, 1);
  await h.advance(2000);
  const done = h.say({ message: '帮我看看这个' });
  await h.advance(3000);
  await done;
  assert.equal(h.timers.size, 0, '计时都已取消或到点');
  assert.deepEqual(h.texts(), ['收到']);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(roundLines(h.requests[0]).map((m) => m.messageId), ['1', '2']);
  assert.match(section(h.requests[0], '这一轮'), /u1 刚才单独 @ 了你一下，又接着说了话：要回他。/);
  assert.deepEqual([await h.status(1), await h.status(2)], ['replied', 'replied']);
  assert.deepEqual((await h.turns()).map((t) => [t.role, t.message_key]), [['user', KEY(1)], ['user', KEY(2)], ['assistant', KEY(2)]]);
  await h.advance(10_000);
  assert.equal(h.sent.length, 1, '之后也不会再发“干嘛蛙”');
});

test('只 @ 不说话：8 秒没说，回固定的“干嘛蛙”，不调用模型，照常写进原话表；发出以后才补话，按留意交给模型', async () => {
  const h = await setup();
  await h.say({ message: AT });
  await h.advance(8000);
  await waitFor(async () => (await h.status(1)) === 'replied', { what: '发出干嘛蛙' });
  assert.deepEqual(h.texts(), [EMPTY_MENTION_REPLY]);
  assert.equal(h.requests.length, 0);
  assert.equal(await h.outcome(1), 'fixed_reply');
  const turns = await h.turns();
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant']);
  assert.equal(turns[1].content, '干嘛蛙');
  assert.deepEqual(JSON.parse(turns[0].content).segments, [{ type: 'mention', toYou: true }]);

  h.reply = () => SILENT_MARK;
  await h.round({ message: '没事了' });
  assert.equal(h.requests.length, 1);
  assert.match(section(h.requests[0], '这一轮'), /刚才和你聊过/);
  assert.equal(h.requests[0].filter((m) => m.role === 'assistant')[0].content, `[回 u1]\n${EMPTY_MENTION_REPLY}`);
  assert.equal(h.sent.length, 1, '模型说不用回，就不发');
});

test('只 @ 不说话：等他的 8 秒里，别人的话照常攒、照常看；“干嘛蛙”排在别人那一轮后面、还没发时他补了话，撤掉“干嘛蛙”，只答补的话', async () => {
  const h = await setup();
  const gates = gate(h);
  await h.say({ message: AT }); // 00 小甲只 @
  await h.advance(1000);
  const joke = h.say({ user_id: 102, message: `${AT}讲个笑话` }); // 01 小乙
  await h.advance(3000); // 04 小乙停了 3 秒，开始看，不等小甲
  await waitFor(() => gates.length === 1, { what: '小乙这一轮在看' });
  await h.advance(4000); // 08 小甲 8 秒没说话：“干嘛蛙”排进队列，等小乙这轮发完
  await h.advance(1000);
  const tea = h.say({ message: '推荐个奶茶' }); // 09 “干嘛蛙”还没发：撤掉
  await h.advance(1000);
  gates[0]('（笑话）'); // 10 回小乙
  await joke;
  await h.advance(2000); // 12 小甲停了 3 秒，看下一轮
  await waitFor(() => gates.length === 2, { what: '小甲这一轮在看' });
  gates[1]('杨枝甘露');
  await tea;
  assert.deepEqual(h.texts(), ['（笑话）', '杨枝甘露']);
  assert.deepEqual(roundLines(h.requests[1]).map((m) => m.messageId), ['1', '3'], '那个 @ 和补的话一起看');
  assert.deepEqual([await h.status(1), await h.status(3)], ['replied', 'replied']);
});

test('只 @ 不说话：“干嘛蛙”排进队列、正要发的时候补话到了，只回补的话', async () => {
  const h = await setup();
  const claim = h.inbox.claim.bind(h.inbox);
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  h.inbox.claim = async (message) => {
    if (message.key === KEY(1)) await slow; // 空 @ 的记录建得很慢：“干嘛蛙”卡在发出之前
    return claim(message);
  };
  await h.say({ message: AT });
  await h.advance(8000); // “干嘛蛙”排进队列……
  const done = h.say({ message: '在吗在吗' }); // ……还没发出去，补充就到了
  release();
  await h.advance(3000);
  await done;
  assert.deepEqual(h.texts(), ['收到']);
  assert.equal(h.requests.length, 1);
  assert.deepEqual([await h.status(1), await h.status(2)], ['replied', 'replied']);
});

test('只 @ 不说话：又只 @ 了一下，重新等；前一个并到后一个', async () => {
  const h = await setup();
  await h.say({ message: AT });
  await h.advance(5000);
  await h.say({ message: AT });
  await h.advance(5000);
  assert.equal(h.sent.length, 0, '第二个 @ 重新开始等');
  await waitFor(async () => (await h.outcome(1)) === 'merged');
  await h.advance(3000);
  await waitFor(() => h.sent.length === 1);
  assert.deepEqual(h.texts(), [EMPTY_MENTION_REPLY]);
});

test('只 @ 不说话：他在正在攒的一轮里，就直接算进这一轮，不另外等', async () => {
  const h = await setup();
  const done = [h.say({ message: `${AT}推荐个奶茶` })];
  await h.advance(1000);
  done.push(h.say({ message: AT }));
  await h.advance(3000);
  await Promise.all(done);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(roundLines(h.requests[0]).map((m) => m.messageId), ['1', '2']);
  await h.advance(10_000);
  assert.deepEqual(h.texts(), ['收到'], '不发“干嘛蛙”');
});

test('只 @ 不说话：退出时还在等的就不发了', async () => {
  const h = await setup();
  await h.say({ message: AT });
  assert.equal(await h.handle.stop(1000), 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.sent.length, 0);
});

test('只 @ 不说话：“干嘛蛙”没发出去（排太久），之后这个人随便说一句，不会被当成补的话', async () => {
  const h = await setup();
  await h.say({ message: AT });
  h.clock += 4 * 60_000; // 轮到时已经超过 3 分钟
  h.timers.fireAll();
  await waitFor(async () => (await h.status(1)) === 'dropped', { what: '“干嘛蛙”太旧，不发了' });
  await h.round({ message: '今天好热' });
  assert.equal(h.sent.length, 0);
  assert.equal(h.requests.length, 0, '不是在跟奶蛙说话，不调用模型');
});

// —— 出错 ——

test('出错：这一轮有人 @ 它，发一条提示，引用最后一个 @ 它的人；只有开头叫名字、留意的人，出错、限速、花费到上限都不出声', async () => {
  const h = await setup();
  h.reply = () => { throw new ModelError('SERVER_ERROR'); };
  await h.round({ message: '奶蛙你在吗' });
  assert.deepEqual([await h.status(1), await h.outcome(1)], ['silent', 'judge_failed']);
  const done = [h.say({ user_id: 102, message: `${AT}在吗` })];
  done.push(h.say({ user_id: 103, message: `${AT}你好` }));
  await h.advance(3000);
  await Promise.all(done);
  assert.deepEqual(h.sent.map((s) => s.message), [[replyQuote(3), text(NOTICES.fallback)]], '只发一条，回最后一个 @ 它的人');
  assert.deepEqual([await h.status(2), await h.outcome(2)], ['silent', 'fallback']);
  assert.deepEqual([await h.status(3), await h.outcome(3)], ['notice', 'fallback']);
  h.reply = () => { throw new ModelError('BUDGET_EXCEEDED'); };
  await h.round({ user_id: 104, message: '奶蛙，在不在' });
  assert.equal(await h.outcome(4), 'budget_exceeded');
  await h.round({ user_id: 105, message: `${AT}你好` });
  assert.deepEqual(h.texts(), [NOTICES.fallback, NOTICES.budget]);
  assert.equal(h.sent.at(-1).message.length, 1, '只有一个人：不用引用');
});

// —— 防刷屏 ——

test('防刷屏：同一个人回得太多暂时不理（只提醒一次）；IGNORE_QQ 的人不理，他的话也不进群里最近的聊天', async () => {
  const h = await setup((hh) => ({ participation: new Participation({ personCapMax: 2, ignoreUsers: ['qq:user:666'], now: () => hh.clock }) }));
  for (let i = 0; i < 4; i += 1) await h.round({ message: `${AT}第${i}次` });
  assert.equal(h.sent.length, 2);
  assert.equal(h.warns('message.ignored').length, 1);

  await h.say({ user_id: 666, message: `${AT}我是别的机器人` });
  await h.say({ user_id: 666, message: '机器人的悄悄话' });
  await h.round({ user_id: 102, message: `${AT}你好` });
  assert.equal(h.sent.length, 3);
  assert.ok(!JSON.stringify(h.requests).includes('机器人'), '不理的人的话不进提示');
});

test('防刷屏：一轮回同一个人两条，算两次', async () => {
  const h = await setup((hh) => ({ participation: new Participation({ personCapMax: 3, now: () => hh.clock }) }));
  h.reply = () => '[回 u1]\n一\n[回 u1]\n二';
  await h.round({ message: `${AT}说两句` });
  await h.round({ message: `${AT}再说两句` });
  assert.deepEqual(h.texts(), ['一', '二', '一', '二']);
  await h.round({ message: `${AT}还说吗` });
  assert.equal(h.sent.length, 4, '已经回了 4 条，超过 3 条：暂时不理');
});

// —— 回谁说清楚 ——

test('回谁说清楚：奶蛙想回复时群里又有别人说了 2 条以上，引用原消息', async () => {
  const h = await setup();
  const gates = gate(h);
  const first = h.say({ message: `${AT}推荐个奶茶` });
  await h.advance(3000);
  await waitFor(() => gates.length === 1);
  await h.say({ user_id: 102, message: '我要喝咖啡' });
  await h.say({ user_id: 103, message: '我也是' });
  gates[0]('杨枝甘露');
  await first;
  assert.deepEqual(h.sent[0].message, [replyQuote(1), text('杨枝甘露')]);

  const second = h.say({ message: `${AT}再推荐一个` });
  await h.advance(3000);
  await waitFor(() => gates.length === 2);
  await h.say({ user_id: 102, message: '只插一句' });
  gates[1]('芋泥波波');
  await second;
  assert.deepEqual(h.sent[1].message, [text('芋泥波波')], '只插了 1 条，不引用');
});

test('回谁说清楚：原消息已经被挤出群里最近的聊天，照样引用；GROUP_CONTEXT=off 也照样判断', async () => {
  for (const keepText of [true, false]) {
    const h = await setup((hh) => ({ groupContext: new GroupContext({ maxEntries: 3, keepText, now: () => hh.clock }) }));
    const gates = gate(h);
    await h.say({ user_id: 104, message: '先聊一句' });
    const first = h.say({ message: `${AT}推荐个奶茶` });
    await h.advance(3000);
    await waitFor(() => gates.length === 1);
    for (let i = 0; i < 4; i += 1) await h.say({ user_id: 102 + (i % 2), message: `插话${i}` });
    gates[0]('杨枝甘露');
    await first;
    assert.deepEqual(h.sent[0].message[0], replyQuote(2), `keepText=${keepText}`);
    if (keepText) assert.match(section(h.requests[0], '群里刚才在聊'), /先聊一句/);
    else assert.equal(section(h.requests[0], '群里刚才在聊'), undefined, 'off 时不放进提示');
  }
});

test('退出时：正在攒的一轮不再等，马上开始看，看完再退出；之后来的不处理', async () => {
  const h = await setup();
  const done = h.say({ message: `${AT}推荐个奶茶` });
  assert.equal(await h.handle.stop(2000), 0);
  await done;
  assert.deepEqual(h.texts(), ['收到']);
  await h.round({ message: `${AT}还在吗` });
  assert.equal(h.requests.length, 1);
  assert.equal(h.logs.find('message.ignored').filter((e) => e.reason === 'shutting_down').length, 1);
});

// —— 群里最近的聊天放进提示 ——

test('群里最近的聊天：被叫到时放进提示；回复过的不重复；不写数据库，旁边说话的人也不分配代号；GROUP_CONTEXT=off 时没有这一段', async () => {
  const h = await setup();
  await h.say({ user_id: 102, message: '周末去哪玩' });
  await h.say({ user_id: 103, message: [{ type: 'text', data: { text: '这里' } }, { type: 'image', data: { file: 'x.jpg' } }] });
  await h.round({ message: `${AT}我们刚才在聊什么` });
  const nearby = section(h.requests[0], '群里刚才在聊');
  assert.match(nearby, /\nx1（刚才）：周末去哪玩\nx2（刚才）：这里\[图片\]$/);
  assert.match(nearby, /x1、x2 这样的是还没有代号的人/);
  assert.ok(!nearby.includes('我们刚才在聊什么'), '这一轮自己的话不放');
  const { rows: aliasRows } = await h.fish.db.query(
    'SELECT person_key FROM person_aliases WHERE tenant_id = $1', [h.fish.tenantId],
  );
  assert.deepEqual(aliasRows.map((r) => r.person_key), [P], '只在旁边说话的人不写进代号表');
  await h.round({ message: `${AT}还有呢` });
  assert.ok(!system(h.requests[1]).includes('我们刚才在聊什么'), '回复过的已经在对话历史里');
  assert.ok(!JSON.stringify(await h.turns()).includes('周末去哪玩'), '没叫奶蛙的话不写进原话表');

  const off = await setup({ groupContext: null });
  await off.say({ user_id: 102, message: '周末去哪玩' });
  await off.round({ message: `${AT}我们刚才在聊什么` });
  assert.ok(!system(off.requests[0]).includes('群里刚才在聊'));
});

test('群里最近的聊天：只放这一轮最后一句之前的，排队期间别人后来说的不放', async () => {
  const h = await setup();
  const gates = gate(h);
  await h.say({ user_id: 104, message: '明天集合吗' });
  const first = h.say({ user_id: 102, message: `${AT}先问一个` });
  await h.advance(3000);
  await waitFor(() => gates.length === 1);
  const second = h.say({ message: `${AT}明天几点集合` });
  await h.advance(3000); // 下一轮到点了，等上一轮看完
  await h.say({ user_id: 103, message: '8 点，我刚说过' }); // 比下一轮最后一句晚到
  gates[0]('好');
  await first;
  await waitFor(() => gates.length === 2);
  assert.match(system(h.requests[1]), /明天集合吗/);
  assert.ok(!system(h.requests[1]).includes('我刚说过'), '后来才说的不当成“刚才在聊”');
  gates[1]('8 点');
  await second;
});

// —— 私聊 ——

test('私聊也走一轮：连发几句等 3 秒一起看；只发图片也回；没有群里的聊天；提示里写明看不到图片内容', async () => {
  const h = await setup();
  await h.say({ user_id: 102, message: '群里的悄悄话' });
  const done = [h.say({ message_type: 'private', sub_type: 'friend', message: [{ type: 'image', data: { file: 'x.jpg' } }] })];
  await h.advance(2000);
  done.push(h.say({ message_type: 'private', sub_type: 'friend', message: '你看这张' }));
  await h.advance(3000);
  await Promise.all(done);
  assert.equal(h.requests.length, 1);
  assert.equal(roundLines(h.requests[0]).length, 2);
  assert.equal(h.sent[0].kind, 'private');
  assert.equal(h.sent[0].message.length, 1, '私聊不引用');
  assert.match(section(h.requests[0], '这一轮'), /u1 在私聊里跟你说话：要回他。/);
  assert.ok(!system(h.requests[0]).includes('群里的悄悄话'));
  assert.match(system(h.requests[0]), /uninterpreted 表示尚未解析的非文本内容（例如图片、表情），你看不到它的内容，不要猜/);
  const rules = readFileSync(fileURLToPath(new URL('../persona/social-rules.md', import.meta.url)), 'utf8');
  assert.ok(!rules.includes('识别图片含义'));
  assert.match(rules, /只看到\[图片\]或未解析的图片时，你不知道图里是什么，不要猜/);
});

// —— 合并以后记忆照样对 ——

test('合并以后记忆照样对：一轮里两个人、奶蛙分别回；提炼时每句对得上说话的人；按人删除小甲，他的话和回他的话删干净，小乙的不动', async () => {
  const h = await setup();
  h.reply = () => '[回 u1]\n记住啦，不放辣\n[回 u2]\n上海好呀';
  const done = [h.say({ message: `${AT}我不吃辣` })];
  await h.advance(1000);
  done.push(h.say({ user_id: 102, message: `${AT}我在上海` }));
  await h.advance(1000);
  done.push(h.say({ message: '也不吃香菜' }));
  await h.advance(3000);
  await Promise.all(done);
  const turns = await h.turns();
  assert.deepEqual(turns.map(renderTurn).map((t) => [t.speaker, t.text]), [
    ['u1', '@奶蛙我不吃辣'], ['u1', '也不吃香菜'], ['奶蛙', '记住啦，不放辣'],
    ['u2', '@奶蛙我在上海'], ['奶蛙', '上海好呀'],
  ]);
  assert.deepEqual(turns.map((t) => t.message_key), [KEY(1), KEY(3), KEY(3), KEY(2), KEY(2)]);

  await h.fish.db.transaction((tx) => deletePersonData(tx, { tenantId: h.fish.tenantId, personKey: P }));
  const left = await h.turns();
  assert.deepEqual(left.map(renderTurn).map((t) => [t.speaker, t.text]), [['u2', '@奶蛙我在上海'], ['奶蛙', '上海好呀']]);
});
