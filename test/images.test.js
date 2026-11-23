import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  normalizeOneBotMessage, messageForModel, createAliasBook, faceLabel, contentLabel, quotedText, renderTurn,
  QuoteReader, belongsTo, RoundLooker, LOOK_PROMPT, downloadImage, imageType, allowedUrl, DownloadError,
  GroupContext, formatGroupContext, faceName, ModelError, MemoryInbox,
} from '../src/index.js';
import { createQQHandler } from '../src/qq-handler.js';
import { openFish, closeTestDb, captureLogger, replyToEveryone, INSTANT_ROUNDS, waitFor } from './helpers.js';

// 看懂图片、小黄脸、引用带原文（docs/image-understanding-design.md 第 11 节）。
const servers = [];
after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await closeTestDb();
});

const EVENT_TIME = 1700000000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const IMG = (file = 'A1.jpg', extra = {}) => ({ type: 'image', data: { file, url: `https://multimedia.nt.qq.com.cn/download?f=${file}`, sub_type: 0, summary: '[图片]', ...extra } });
const text = (t) => ({ type: 'text', data: { text: t } });
const at = (qq) => ({ type: 'at', data: { qq: String(qq) } });
const reply = (id) => ({ type: 'reply', data: { id: String(id) } });

function event(overrides = {}) {
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: 900, user_id: 101, group_id: 200, message_id: 1, time: EVENT_TIME,
    sender: { nickname: '小甲' }, message: [text('你好')], ...overrides,
  };
}
const msg = (overrides) => normalizeOneBotMessage(event(overrides));

// —— 下载 ——

async function imageServer(routes) {
  const server = createServer((req, res) => {
    const route = routes[req.url] ?? { status: 404 };
    if (route.hang) return;
    res.writeHead(route.status ?? 200, route.headers ?? {});
    if (route.chunks) {
      for (const chunk of route.chunks) res.write(chunk);
      res.end();
    } else {
      res.end(route.body ?? '');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test('下载：只认 QQ 的图片服务器，按开头几个字节认格式', () => {
  assert.equal(allowedUrl('https://multimedia.nt.qq.com.cn/download?x=1'), true);
  assert.equal(allowedUrl('https://gchat.qpic.cn/gchatpic_new/x'), true);
  assert.equal(allowedUrl('https://gxh.vip.qq.com/club/item/parcel/item/ab/x/raw300.gif'), true);
  assert.equal(allowedUrl('https://evilqq.com/x.jpg'), false);
  assert.equal(allowedUrl('https://qq.com.evil.cn/x.jpg'), false);
  assert.equal(allowedUrl('http://127.0.0.1:5432/'), false);
  assert.equal(allowedUrl('file:///etc/passwd'), false);
  assert.equal(allowedUrl('https://user:pw@gchat.qpic.cn/x'), false);
  assert.equal(allowedUrl('不是地址'), false);
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(imageType(Buffer.from('<html>')), null);
});

test('下载：成功、跳转到别的域名、太大、不是图片、出错、被取消', async () => {
  const base = await imageServer({
    '/ok': { body: PNG },
    '/away': { status: 302, headers: { location: 'https://example.com/x.png' } },
    '/hop': { status: 302, headers: { location: '/ok' } },
    '/big': { headers: { 'content-length': '20' }, body: Buffer.alloc(20) },
    '/stream': { chunks: [PNG, Buffer.alloc(30)] },
    '/html': { body: '<html>不是图</html>' },
    '/hang': { hang: true },
  });
  const opts = { hosts: ['127.0.0.1'], maxBytes: 16 };
  const ok = await downloadImage(`${base}/ok`, opts);
  assert.equal(ok.mime, 'image/png');
  assert.deepEqual([...ok.bytes], [...PNG]);
  assert.equal((await downloadImage(`${base}/hop`, opts)).mime, 'image/png'); // 同一个域名里跳转可以
  const code = async (path, extra = {}) => {
    try {
      await downloadImage(`${base}${path}`, { ...opts, ...extra });
      return 'ok';
    } catch (error) {
      assert.ok(error instanceof DownloadError);
      assert.doesNotMatch(error.message, /127\.0\.0\.1/); // 错误信息里没有地址
      return error.code;
    }
  };
  assert.equal(await code('/away'), 'BAD_HOST');
  assert.equal(await code('/big'), 'TOO_LARGE');
  assert.equal(await code('/stream'), 'TOO_LARGE');
  assert.equal(await code('/html', { maxBytes: 1000 }), 'BAD_FORMAT');
  assert.equal(await code('/missing'), 'HTTP');
  assert.equal(await code('/ok', { hosts: ['qq.com'] }), 'BAD_HOST');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  assert.equal(await code('/hang', { signal: controller.signal }), 'ABORTED');
});

// —— 小黄脸 ——

test('小黄脸：表里有的写名字，没有的写“[QQ表情]”', () => {
  assert.equal(faceName('5'), '流泪');
  assert.equal(faceName(5), '流泪');
  assert.equal(faceName('99999999'), null);
  assert.equal(faceName('constructor'), null);
  const m = msg({ message: [text('我又挂科了'), { type: 'face', data: { id: '5' } }, { type: 'face', data: { id: '99999999' } }] });
  const envelope = JSON.parse(messageForModel(m, createAliasBook()));
  assert.deepEqual(envelope.segments.slice(1), [{ type: 'face', name: '流泪' }, { type: 'face' }]);
  assert.equal(faceLabel(m.segments[1]), '[QQ表情：流泪]');
  assert.equal(faceLabel(m.segments[2]), '[QQ表情]');
  // 群里刚才在聊、记忆提炼里也是名字
  const ctx = new GroupContext({ now: () => 0 });
  ctx.add(m);
  const lines = formatGroupContext(ctx.recent(m.conversation.key), { aliasOf: () => 'u1', now: 0 });
  assert.match(lines, /我又挂科了\[QQ表情：流泪\]\[QQ表情\]/);
  const turn = renderTurn({ id: 1, role: 'user', content: JSON.stringify(envelope), created_at: new Date() });
  assert.equal(turn.text, '我又挂科了[QQ表情：流泪][QQ表情]');
});

// —— 信封 ——

test('信封：看过的图写描述，引用带原文和谁说的，回看的图在最外层；提炼只看到“[图片]”“[引用了一条消息]”', () => {
  const m = msg({ message_id: 7, message: [reply(3), at(900), text(' 这是啥'), IMG('A.jpg'), IMG('B.jpg')] });
  const aliasOf = (key) => ({ 'qq:user:101': 'u1', 'qq:user:102': 'u2' })[key];
  const quote = {
    status: 'ok', fromSelf: false, authorKey: 'qq:user:102',
    segments: normalizeOneBotMessage(event({ user_id: 102, message: [at(900), at(103), text(' 明天几点  集合'), IMG(), { type: 'face', data: { id: '14' } }, reply(1)] })).segments,
    images: ['截图：一张时间表'],
  };
  const extra = { images: new Map([[3, '照片：一只橘猫']]), quote, recentImages: ['表情包：竖大拇指'] };
  const envelope = JSON.parse(messageForModel(m, aliasOf, extra));
  assert.deepEqual(envelope, {
    sender: { alias: 'u1', name: '小甲' }, messageId: '7',
    segments: [
      { type: 'reply', messageId: '3', from: 'u2', text: '@你@某人 明天几点 集合[图片][QQ表情：微笑][引用了一条消息]', images: ['截图：一张时间表'] },
      { type: 'mention', toYou: true },
      { type: 'text', text: ' 这是啥' },
      { type: 'image', description: '照片：一只橘猫' },
      { type: 'uninterpreted', sourceType: 'image' }, // 没看成的仍是“未解析”
    ],
    recentImages: ['表情包：竖大拇指'],
  });
  const turn = renderTurn({ id: 1, role: 'user', content: JSON.stringify(envelope), created_at: new Date() });
  assert.equal(turn.text, '[引用了一条消息]@奶蛙 这是啥[图片][图片]');

  // 奶蛙自己的话：fromYou；取不到原文时只写 fromYou；查不到的群友的话只留编号；没有代号的写“某人”
  const own = (q) => JSON.parse(messageForModel(m, aliasOf, { quote: q })).segments[0];
  assert.deepEqual(own({ status: 'ok', fromSelf: true, text: '试试\n少糖的' }), { type: 'reply', messageId: '3', fromYou: true, text: '试试 少糖的' });
  assert.deepEqual(own({ status: 'failed', fromSelf: true }), { type: 'reply', messageId: '3', fromYou: true });
  assert.deepEqual(own({ status: 'mismatch', fromSelf: false }), { type: 'reply', messageId: '3' });
  assert.equal(own({ status: 'ok', fromSelf: false, authorKey: 'qq:user:555', segments: [] }).from, '某人');
  // 原文最多 200 字
  const long = own({ status: 'ok', fromSelf: true, text: '长'.repeat(300) }).text;
  assert.equal([...long].length, 200);
  assert.ok(long.endsWith('…'));
  assert.equal([...quotedText([{ type: 'text', text: '字'.repeat(250) }], { aliasOf, accountId: '900' })].length, 200);
});

// —— 取被引用的那条 ——

function quoteClient(handler) {
  const calls = [];
  return { calls, call: async (action, params, opts) => { calls.push({ action, params, opts }); return handler(params, opts); } };
}

test('引用：核对是不是当前这个聊天的', () => {
  const group = msg({});
  assert.equal(belongsTo({ message_type: 'group', group_id: 200, user_id: 102, message_id: 3 }, group, '3'), true);
  assert.equal(belongsTo({ message_type: 'group', group_id: 201, user_id: 102, message_id: 3 }, group, '3'), false); // 别的群
  assert.equal(belongsTo({ message_type: 'group', user_id: 102, message_id: 3 }, group, '3'), false); // 没有群号
  assert.equal(belongsTo({ message_type: 'private', user_id: 102, message_id: 3 }, group, '3'), false);
  assert.equal(belongsTo({ message_type: 'group', group_id: 200, user_id: 102, message_id: 4 }, group, '3'), false); // 编号对不上
  assert.equal(belongsTo(null, group, '3'), false);
  const priv = msg({ message_type: 'private', sub_type: 'friend', group_id: undefined });
  assert.equal(belongsTo({ message_type: 'private', user_id: 101, message_id: 3 }, priv, '3'), true); // 对方发的
  assert.equal(belongsTo({ message_type: 'private', user_id: 900, target_id: 101, message_id: 3 }, priv, '3'), true); // 奶蛙发给他的
  assert.equal(belongsTo({ message_type: 'private', user_id: 900, target_id: 102, message_id: 3 }, priv, '3'), false); // 奶蛙发给别人的
  assert.equal(belongsTo({ message_type: 'private', user_id: 102, message_id: 3 }, priv, '3'), false); // 别人的私聊
});

test('引用：奶蛙自己的话先用内存里记的；其余用 get_msg，对不上、查不到、出错都只留编号', async () => {
  const reader = new QuoteReader({ keepSent: 2 });
  const m = msg({ message_id: 10, message: [reply(3), text('真的吗')] });
  const r = m.segments[0];
  const client = quoteClient(({ message_id: id }) => ({
    3: { message_type: 'group', group_id: 200, user_id: 102, message_id: 3, message: [text('明天几点集合'), IMG()] },
    4: { message_type: 'group', group_id: 999, user_id: 102, message_id: 4, message: [text('别的群')] },
    5: null,
    6: { message_type: 'group', group_id: 200, user_id: 900, message_id: 6, message: [text('奶蛙以前说的')] },
    7: { message_type: 'group', group_id: 200, message_id: 7, message: [text('不知道谁说的')] },
  })[id]);
  const read = (id, opts = {}) => reader.read(m, { messageId: String(id), messageKey: `${m.conversation.key}:message:${id}` }, { client, ...opts });

  const found = await read(3);
  assert.equal(found.status, 'ok');
  assert.equal(found.authorKey, 'qq:user:102');
  assert.deepEqual(found.segments.map((s) => s.type), ['text', 'opaque']);
  assert.deepEqual(client.calls[0].params, { message_id: 3 });
  assert.equal((await read(4)).status, 'mismatch');
  assert.equal((await read(5)).status, 'missing');
  assert.deepEqual(await read(6), { status: 'ok', fromSelf: true, segments: [{ type: 'text', text: '奶蛙以前说的' }], source: 'get_msg' });
  assert.equal((await read(7)).status, 'mismatch'); // 不知道是谁说的
  assert.deepEqual(await reader.read(m, r, { client: { call: async () => { throw new Error('超时'); } }, fromSelf: true }), { status: 'failed', fromSelf: true });
  assert.deepEqual(await reader.read(m, r, {}), { status: 'failed', fromSelf: false }); // 没有 get_msg

  // 内存里记的：不调 get_msg
  reader.rememberSent(r.messageKey, '试试少糖的');
  const before = client.calls.length;
  assert.deepEqual(await reader.read(m, r, { client }), { status: 'ok', fromSelf: true, text: '试试少糖的', source: 'memory' });
  assert.equal(client.calls.length, before);
  reader.rememberSent('k2', 'b');
  reader.rememberSent('k3', 'c'); // 只留最近 2 条
  assert.equal(reader.sent.has(r.messageKey), false);

  // 被取消：不再等
  const controller = new AbortController();
  const pending = reader.read(m, r, { client: { call: () => new Promise(() => {}) }, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).status, 'failed');
});

// —— 看这一轮的图 ——

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; },
    clearTimeout: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    fire: () => { for (const t of pending.splice(0)) t.fn(); },
  };
}

function looker({ describe = async () => '照片：一只橘猫', download, ...options } = {}) {
  const calls = { chat: [], download: [] };
  const brain = {
    chat: async (messages, opts) => {
      calls.chat.push({ messages, opts });
      return describe(messages, opts);
    },
  };
  const timers = fakeTimers();
  const l = new RoundLooker({
    brain, timers,
    download: async (url, opts) => {
      calls.download.push({ url, opts });
      return download ? download(url, opts) : { mime: 'image/png', bytes: PNG };
    },
    ...options,
  });
  return { looker: l, calls, timers };
}

const itemOf = (m) => ({ message: m, personKey: m.sender.key });
const explicit = (key = 'qq:user:101') => new Map([[key, { level: 'explicit', reason: 'mention' }]]);

test('看图：这一轮里的图交给 flash，开图片审核；商城表情用标签；同一张只看一次；一轮最多 3 张', async () => {
  const { looker: l, calls } = looker();
  const items = [
    itemOf(msg({ message_id: 1, message: [at(900), IMG('A.jpg'), IMG('B.jpg')] })),
    itemOf(msg({ message_id: 2, message: [IMG('A.jpg'), { type: 'image', data: { file: 'ab-x.gif', url: 'https://gxh.vip.qq.com/x.gif', sub_type: 0, summary: '[抱抱]', emoji_id: 'x' } }] })),
    itemOf(msg({ message_id: 3, message: [IMG('C.jpg'), IMG('D.jpg')] })),
  ];
  const extras = await l.prepare({ conversationKey: items[0].message.conversation.key, items, members: explicit() });
  assert.equal(calls.chat.length, 3); // A、B、C；A 出现两次只看一次；D 超过 3 张
  const [first] = calls.chat;
  assert.equal(first.messages[0].content, LOOK_PROMPT);
  assert.deepEqual(first.messages[1].content[1].type, 'input_image');
  assert.match(first.messages[1].content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(first.opts.safetyCheck, 'high');
  assert.equal(first.opts.conversationKey, `image:${items[0].message.conversation.key}`);
  assert.ok(first.opts.signal instanceof AbortSignal);
  const at1 = extras.get(items[0].message.key).images;
  assert.deepEqual([...at1.keys()], [1, 2]);
  assert.equal(extras.get(items[1].message.key).images.get(0), '照片：一只橘猫'); // 同一张图，描述放回两处
  assert.equal(extras.get(items[1].message.key).images.get(1), '商城表情：抱抱'); // 不下载、不调模型
  assert.equal(extras.get(items[2].message.key).images.has(0), true);
  assert.equal(extras.get(items[2].message.key).images.has(1), false); // 第 4 张还写“[图片]”
  assert.equal(calls.download.length, 3);
});

test('看图：引用的图看；叫奶蛙之前 1 分钟内自己发的图看（叫名字也算），别人的、更早的、只是留意的不看', async () => {
  let now = 0;
  const ctx = new GroupContext({ now: () => now });
  const say = (overrides, t) => { now = t; const m = msg(overrides); ctx.add(m); return m; };
  say({ message_id: 1, message: [IMG('OLD.jpg')] }, 0); // 叫之前 61 秒：不看
  say({ message_id: 2, user_id: 102, message: [IMG('OTHER.jpg')] }, 30_000); // 别人的：不看
  say({ message_id: 3, message: [IMG('MINE.jpg')] }, 40_000); // 叫之前 21 秒：看
  const call = say({ message_id: 4, message: [text('奶蛙，你看这个'), reply(9)] }, 61_000);
  const client = quoteClient(() => ({ message_type: 'group', group_id: 200, user_id: 103, message_id: 9, message: [IMG('QUOTED.jpg')] }));
  const { looker: l, calls } = looker({ describe: (messages) => `看到了第 ${calls.chat.length} 张` });
  const members = new Map([['qq:user:101', { level: 'name', reason: 'name' }]]);
  const extras = await l.prepare({ conversationKey: call.conversation.key, items: [itemOf(call)], members, client, groupContext: ctx });
  const mine = extras.get(call.key);
  assert.deepEqual(calls.download.map((d) => d.url.split('=')[1]), ['QUOTED.jpg', 'MINE.jpg']);
  assert.equal(mine.quote.status, 'ok');
  assert.equal(mine.quote.images.length, 1);
  assert.equal(mine.recentImages.length, 1);

  // 只是留意的人（没叫奶蛙）：不回看
  const { looker: l2, calls: calls2 } = looker();
  await l2.prepare({ conversationKey: call.conversation.key, items: [itemOf(call)], members: new Map([['qq:user:101', { level: 'follow_up', reason: 'follow_up' }]]), groupContext: ctx });
  assert.equal(calls2.download.length, 0);
});

test('看图：不看图时（brain 为空）只查引用；看不了的图留成“[图片]”', async () => {
  const m = msg({ message_id: 1, message: [reply(3), IMG('A.jpg')] });
  const client = quoteClient(() => ({ message_type: 'group', group_id: 200, user_id: 102, message_id: 3, message: [text('原文')] }));
  const off = new RoundLooker({ brain: null });
  const extras = await off.prepare({ conversationKey: m.conversation.key, items: [itemOf(m)], members: explicit(), client });
  assert.equal(extras.get(m.key).quote.status, 'ok');
  assert.equal(extras.get(m.key).images.size, 0);

  const logs = captureLogger();
  for (const failure of [
    { download: async () => { throw new DownloadError('TOO_LARGE'); }, reason: 'download_too_large' },
    { describe: async () => { throw new ModelError('FILTERED'); }, reason: 'model_filtered' },
    { describe: async () => { throw new ModelError('BAD_REQUEST', { httpStatus: 400 }); }, reason: 'model_bad_request' },
    { describe: async () => '   ', reason: 'empty' },
  ]) {
    const { looker: l } = looker({ ...failure, logger: logs.logger });
    const result = await l.prepare({ conversationKey: m.conversation.key, items: [itemOf(m)], members: explicit() });
    assert.equal(result.get(m.key).images.size, 0, failure.reason);
    assert.equal(logs.find('image.looked').at(-1).failed[failure.reason], 1);
  }
  // 日志里没有地址、文件名和描述
  assert.doesNotMatch(logs.lines.join('\n'), /A\.jpg|multimedia|橘猫/);
});

test('看图：查引用、下载、看图共用 20 秒，到点取消，迟到的结果不用', async () => {
  const m = msg({ message_id: 1, message: [reply(3), IMG('A.jpg')] });
  // 卡在 get_msg：到点后不再下载、不再看图
  {
    let answer;
    const client = { call: () => new Promise((resolve) => { answer = resolve; }) };
    const { looker: l, calls, timers } = looker();
    const pending = l.prepare({ conversationKey: m.conversation.key, items: [itemOf(m)], members: explicit(), client });
    await waitFor(() => timers.pending.length && answer);
    assert.equal(timers.pending[0].ms, 20_000);
    timers.fire();
    const extras = await pending;
    assert.equal(extras.get(m.key).quote, null);
    answer({ message_type: 'group', group_id: 200, user_id: 102, message_id: 3, message: [text('迟到的')] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(extras.get(m.key).quote, null); // 迟到的不用
    assert.equal(calls.download.length + calls.chat.length, 0);
  }
  // 卡在看图：到点取消模型请求，迟到的描述不用
  {
    let late;
    const { looker: l, calls, timers } = looker({ describe: (_, opts) => new Promise((resolve) => { late = resolve; opts.signal.addEventListener('abort', () => calls.aborted = true); }) });
    const image = msg({ message_id: 2, message: [IMG('A.jpg')] });
    const pending = l.prepare({ conversationKey: image.conversation.key, items: [itemOf(image)], members: explicit() });
    await waitFor(() => late);
    assert.ok(calls.chat[0].opts.deadline <= Date.now() + 20_000);
    timers.fire();
    const extras = await pending;
    assert.equal(calls.aborted, true);
    late('照片：迟到的描述');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(extras.get(image.key).images.size, 0);
  }
  // 卡在下载：到点取消下载
  {
    const { looker: l, calls, timers } = looker({ download: (_, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DownloadError('ABORTED')))) });
    const image = msg({ message_id: 3, message: [IMG('A.jpg')] });
    const pending = l.prepare({ conversationKey: image.conversation.key, items: [itemOf(image)], members: explicit() });
    await waitFor(() => calls.download.length);
    timers.fire();
    assert.equal((await pending).get(image.key).images.size, 0);
    assert.equal(calls.chat.length, 0);
  }
});

// —— 接进处理器 ——

async function setup(options = {}) {
  const fish = await openFish();
  const requests = [];
  const sent = [];
  const calls = [];
  const h = { fish, requests, sent, calls, clock: EVENT_TIME * 1000 + 1000, getMsg: () => null };
  const logs = captureLogger();
  const brain = { chat: async (messages) => { requests.push(messages); return '收到'; } };
  const client = {
    sendGroupMsg: async (id, message) => ({ message_id: 9000 + sent.push({ kind: 'group', id, message }) }),
    sendPrivateMsg: async (id, message) => ({ message_id: 9000 + sent.push({ kind: 'private', id, message }) }),
    call: async (action, params) => { calls.push({ action, params }); return h.getMsg(params); },
  };
  const groupContext = new GroupContext({ now: () => h.clock });
  const imageBrain = { chat: async (messages, opts) => { h.imageCalls = (h.imageCalls ?? 0) + 1; h.imageOpts = opts; return '照片：一只橘猫'; } };
  h.looker = new RoundLooker({ brain: imageBrain, download: async () => ({ mime: 'image/png', bytes: PNG }) });
  h.handle = createQQHandler({
    fish, brain, getClient: () => client, persona: '测试角色', now: () => new Date(h.clock), logger: logs.logger,
    clock: () => h.clock, inbox: new MemoryInbox(), participation: replyToEveryone(), groupContext,
    looker: h.looker, ...INSTANT_ROUNDS, ...options,
  });
  h.say = (overrides) => h.handle(event({ time: Math.floor(h.clock / 1000), ...overrides }));
  // 最后一条用户消息：前面可能先有“群里刚才在聊”，[这一轮] 下面是这一轮的几句（一行一句）。
  h.lines = (n = -1) => {
    const content = h.requests.at(n).at(-1).content;
    const at = content.indexOf('\n[这一轮]\n');
    return (at === -1 ? content : content.slice(at + '\n[这一轮]\n'.length)).split('\n').map((line) => JSON.parse(line));
  };
  h.nearby = (n = -1) => {
    const content = h.requests.at(n).at(-1).content;
    const at = content.indexOf('\n[这一轮]\n');
    return at === -1 ? '' : content.slice(0, at);
  };
  h.turns = async () => (await fish.db.query(
    'SELECT role, content FROM conversation_turns WHERE tenant_id = $1 ORDER BY id', [fish.tenantId],
  )).rows;
  return h;
}

test('处理器：@ 加图，模型看到描述，原话表里存的也是带描述的信封', async () => {
  const h = await setup();
  await h.say({ message_id: 1, message: [at(900), text(' 这是啥'), IMG('A.jpg')] });
  assert.deepEqual(h.lines()[0].segments.at(-1), { type: 'image', description: '照片：一只橘猫' });
  assert.equal(h.imageOpts.safetyCheck, 'high');
  const [user] = await h.turns();
  assert.deepEqual(JSON.parse(user.content).segments.at(-1), { type: 'image', description: '照片：一只橘猫' });
  const system = h.requests[0][0].content;
  assert.match(system, /image 的 description 写的是图里有什么，就当是你自己看到的/);
  // QQ 冒烟检查发现的：前面看过的图连不上、说漏了“描述”“占位”
  assert.match(system, /前面对话里看过的图也算你看过；这一轮没带图却问“图里……”，说的是前面最近那张/);
  assert.match(system, /没有就说没有；只有看不出来的细节（颜色、小字之类）才说没看清/);
  assert.match(system, /别提“描述”“占位”这类说法，也别说图是别人替你看的/);
  assert.match(system, /聊天记录、视频、语音、文件、卡片你打不开（原文里写成 \[聊天记录\] 这样），被问到就直说打不开/);
});

test('引用和群里刚才在聊：打不开的按种类写（聊天记录、视频、语音、文件……），认不出的才是“[其他内容]”', async () => {
  const segs = normalizeOneBotMessage(event({ user_id: 102, message: [
    { type: 'forward', data: { id: 'f1' } }, { type: 'video', data: { file: 'v.mp4' } }, { type: 'record', data: { file: 'r.amr' } },
    { type: 'file', data: { file: 'a.pdf' } }, { type: 'json', data: { data: '{}' } }, { type: 'newthing', data: {} },
  ] })).segments;
  assert.equal(quotedText(segs, { aliasOf: () => undefined, accountId: '900' }), '[聊天记录][视频][语音][文件][卡片][其他内容]');
  assert.equal(contentLabel('forward'), '[聊天记录]');
  assert.equal(contentLabel('constructor'), '[其他内容]');
  const ctx = new GroupContext({ now: () => 0 });
  const m = msg({ message_id: 3, message: [{ type: 'forward', data: { id: 'f1' } }] });
  ctx.add(m);
  assert.match(formatGroupContext(ctx.recent(m.conversation.key), { aliasOf: () => 'u1', now: 0 }), /u1（刚才）：\[聊天记录\]$/);

  // 引用一条合并转发：信封的引用原文是“[聊天记录]”
  const h = await setup();
  h.getMsg = ({ message_id: id }) => ({ message_type: 'group', group_id: 200, user_id: 102, message_id: id, message: [{ type: 'forward', data: { id: 'f1' } }] });
  await h.say({ message_id: 9, message: [reply(3), at(900), text(' 这是啥')] });
  assert.equal(h.lines()[0].segments[0].text, '[聊天记录]');
});

test('处理器：引用奶蛙刚说的话，原文从内存来；引用群友的话用 get_msg，带原文和代号', async () => {
  const h = await setup();
  await h.say({ message_id: 1, message: [at(900), text(' 推荐个奶茶')] });
  const botReplyId = 9001; // 第一条回复的消息编号（见 setup 的 sendGroupMsg）
  h.clock += 5000;
  await h.say({ message_id: 2, message: [reply(botReplyId), text('这句不是你说的吗')] });
  assert.deepEqual(h.lines()[0].segments[0], { type: 'reply', messageId: String(botReplyId), fromYou: true, text: '收到' });
  assert.equal(h.calls.length, 0); // 内存里有，没查 get_msg

  // 群友的话：u1 是小甲自己；被引用的 102 已经有代号（先让他说一句）
  await h.say({ message_id: 3, user_id: 102, sender: { nickname: '小乙' }, message: [at(900), text(' 在吗')] });
  h.getMsg = ({ message_id: id }) => ({ message_type: 'group', group_id: 200, user_id: 102, message_id: id, message: [text('明天几点集合')] });
  await h.say({ message_id: 4, message: [reply(3), at(900), text(' 他说得对吗')] });
  const quoted = h.lines()[0].segments[0];
  assert.equal(quoted.text, '明天几点集合');
  assert.match(quoted.from, /^u\d+$/);
  assert.deepEqual(h.calls.at(-1), { action: 'get_msg', params: { message_id: 3 } });

  // 来源对不上：只留编号
  h.getMsg = ({ message_id: id }) => ({ message_type: 'group', group_id: 999, user_id: 102, message_id: id, message: [text('别的群的话')] });
  await h.say({ message_id: 5, message: [reply(3), at(900), text(' 嗯？')] });
  assert.deepEqual(h.lines()[0].segments[0], { type: 'reply', messageId: '3' });
  // 提炼时引用仍是“[引用了一条消息]”
  const rows = await h.turns();
  const quotedTurn = rows.find((row) => row.role === 'user' && row.content.includes('明天几点集合'));
  assert.equal(renderTurn({ id: 1, role: 'user', content: quotedTurn.content, created_at: new Date() }).text, '[引用了一条消息]@奶蛙 他说得对吗');
});

test('处理器：先发图再叫奶蛙，描述放在他这一轮第一句的 recentImages 里', async () => {
  const h = await setup({ participation: undefined }); // 用真正的规则：只发图不叫它，不看
  await h.say({ message_id: 1, message: [IMG('MINE.jpg')] });
  assert.equal(h.requests.length, 0);
  h.clock += 20_000;
  await h.say({ message_id: 2, message: [at(900), text(' 你看这个')] });
  assert.deepEqual(h.lines()[0].recentImages, ['照片：一只橘猫']);
  // “群里刚才在聊”那一段里，那张图还是“[图片]”：描述只放在他这一轮的信封里，不重复
  assert.match(h.nearby(), /u\d+（刚才）：\[图片\]$/);
  // 原话表里只存信封（带着 recentImages），不存“群里刚才在聊”
  const [user] = await h.turns();
  assert.deepEqual(JSON.parse(user.content).recentImages, ['照片：一只橘猫']);
});

// —— 模型调用：审核参数、外面给的截止时间和取消 ——

async function fakeResponses(script) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const n = requests.push(JSON.parse(raw));
    const step = script(n);
    if (step.hang) return;
    res.writeHead(step.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(step.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const okBody = (text) => ({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 400, output_tokens: 50, output_tokens_details: { safety_tokens: 5 } },
});

test('模型调用：传了审核参数才带 safety_check；内容块数组原样放进请求', async () => {
  const { DeepSeekBrain } = await import('../src/model/brain.js');
  const server = await fakeResponses(() => ({ body: okBody('照片：一只橘猫') }));
  const brain = new DeepSeekBrain({ apiKey: 'sk-test', baseUrl: server.url, model: 'deepseek-flash', webSearch: false, reasoningEffort: 'none' });
  const content = [{ type: 'input_text', text: '看这张图' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }];
  assert.equal(await brain.chat([{ role: 'system', content: LOOK_PROMPT }, { role: 'user', content }], { safetyCheck: 'high' }), '照片：一只橘猫');
  assert.deepEqual(server.requests[0].safety_check, { level: 'high' });
  assert.deepEqual(server.requests[0].input, [{ role: 'user', content }]);
  await brain.chat([{ role: 'user', content: '你好' }]);
  assert.equal('safety_check' in server.requests[1], false); // 回复、提炼不带
});

test('模型调用：外面取消时停下正在等的请求、不重试、按估算记账；截止时间已过就一次都不调', async () => {
  const { DeepSeekBrain } = await import('../src/model/brain.js');
  const server = await fakeResponses(() => ({ hang: true }));
  const records = [];
  const ledger = { day: async () => ({ costCny: 0, calls: 0, unknownCalls: 0 }), record: async (r) => { records.push(r); } };
  const brain = new DeepSeekBrain({
    apiKey: 'sk-test', baseUrl: server.url, model: 'deepseek-flash', webSearch: false, ledger,
    deadlineMs: 5000, firstAttemptMs: 4000, minAttemptMs: 10, retryDelayMs: 1,
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const startedAt = Date.now();
  await assert.rejects(brain.chat([{ role: 'user', content: '看图' }], { signal: controller.signal }), (error) => error.code === 'TIMEOUT');
  assert.ok(Date.now() - startedAt < 2000);
  assert.equal(server.requests.length, 1); // 不重试
  assert.equal(records.length, 1); // 请求可能已经计费：按估算记一笔
  assert.equal(records[0].usage, null);

  await assert.rejects(brain.chat([{ role: 'user', content: '看图' }], { deadline: Date.now() - 1 }), (error) => error.code === 'TIMEOUT');
  await assert.rejects(brain.chat([{ role: 'user', content: '看图' }], { signal: AbortSignal.abort() }), (error) => error.code === 'TIMEOUT');
  assert.equal(server.requests.length, 1);
  assert.equal(records.length, 1);
});

test('模型调用：图片没通过审核（400 或 content_filter）不重试，拿不到描述', async () => {
  const { DeepSeekBrain } = await import('../src/model/brain.js');
  for (const step of [
    { status: 400, body: { error: { message: 'Content Exists Risk', type: 'invalid_request_error' } } },
    { body: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [{ type: 'message', content: [{ type: 'output_text', text: '写了一半的描述' }, { type: 'refusal', refusal: 'The following images were blocked by content moderation: messages.1.content.0' }] }] } },
  ]) {
    const server = await fakeResponses(() => step);
    const brain = new DeepSeekBrain({ apiKey: 'sk-test', baseUrl: server.url, model: 'deepseek-flash', webSearch: false, retryDelayMs: 1 });
    await assert.rejects(brain.chat([{ role: 'user', content: '看图' }], { safetyCheck: 'high' }), (error) => ['BAD_REQUEST', 'FILTERED'].includes(error.code));
    assert.equal(server.requests.length, 1);
  }
});
