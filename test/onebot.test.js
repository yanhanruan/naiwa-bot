import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { OneBotClient } from '../src/adapters/onebot.js';
import { captureLogger } from './helpers.js';

// 用真实的 WebSocket 服务端扮演 SnowLuma：记录收到的动作，按 respond 决定怎么回。
const servers = [];
const clients = [];
after(async () => {
  for (const c of clients) c.stop();
  for (const s of servers) await s.close();
});

let nextMessageId = 1000;
function defaultRespond(req) {
  if (req.action.startsWith('send_')) return { status: 'ok', retcode: 0, data: { message_id: nextMessageId++ } };
  if (req.action === 'get_status') return { status: 'ok', retcode: 0, data: { online: true, good: true } };
  return { status: 'ok', retcode: 0, data: {} };
}

async function fakeOneBot({ port = 0, token = null, respond = defaultRespond, onConnection = null } = {}) {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: token === null ? undefined
      : (info) => new URL(info.req.url, 'http://localhost').searchParams.get('access_token') === token,
  });
  await once(wss, 'listening');
  const server = {
    port: wss.address().port,
    connections: 0,
    actions: [],
    sockets: [],
    respond,
    get url() { return `ws://127.0.0.1:${this.port}`; },
    push(data) {
      this.sockets.at(-1).send(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    },
    dropAll() {
      for (const socket of wss.clients) socket.terminate();
    },
    close() {
      return new Promise((resolve) => {
        for (const socket of wss.clients) socket.terminate();
        wss.close(() => resolve());
      });
    },
  };
  wss.on('connection', (socket) => {
    server.connections += 1;
    server.sockets.push(socket);
    socket.on('message', (data) => {
      const req = JSON.parse(String(data));
      server.actions.push({ ...req, at: Date.now() });
      const res = server.respond(req);
      if (res) socket.send(JSON.stringify({ ...res, echo: req.echo }));
    });
    socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 900, time: 1 }));
    onConnection?.(socket);
  });
  servers.push(server);
  return server;
}

// 测试用的时间参数都很小；random 固定为 1，让重连等待时间可预期。
function makeClient(target, overrides = {}) {
  const logs = captureLogger();
  const events = [];
  const client = new OneBotClient({
    url: typeof target === 'string' ? target : target.url,
    logger: logs.logger,
    onEvent: (ev) => { events.push(ev); },
    reconnectMinMs: 20,
    reconnectMaxMs: 160,
    requestTimeoutMs: 300,
    connectTimeoutMs: 1000,
    idleTimeoutMs: 60_000,
    probeTimeoutMs: 300,
    stableAfterMs: 10_000,
    random: () => 1,
    throttle: { minIntervalMs: 0, jitterMs: 0 },
    ...overrides,
  });
  clients.push(client);
  return { client, logs, events };
}

async function waitFor(check, { timeoutMs = 3000, what = '条件满足' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时：${what}`);
    await sleep(5);
  }
}

const text = (t) => [{ type: 'text', data: { text: t } }];
const groupMessage = (id) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 900, user_id: 101, group_id: 200,
  message_id: id, time: 1700000000, message: text('你好'),
});

test('正常收发：带 token 连接，收到事件，发送消息拿到 message_id', async () => {
  const token = 's3cret/+token'; // 含 / 和 +，验证 token 经过编码
  const server = await fakeOneBot({ token });
  const { client, events, logs } = makeClient(server, { token });
  assert.equal(await client.start(), true);
  await waitFor(() => events.length >= 1, { what: 'lifecycle 事件' });
  assert.equal(client.selfId, 900);

  server.push(groupMessage(-5));
  await waitFor(() => events.length >= 2, { what: '消息事件' });
  assert.equal(events[1].message_id, -5);

  const result = await client.sendGroupMsg(200, text('收到'), { key: 'k1' });
  assert.ok(Number.isInteger(result.message_id));
  const sent = server.actions.find((a) => a.action === 'send_group_msg');
  assert.deepEqual(sent.params, { group_id: 200, message: text('收到') });
  const status = client.status();
  assert.equal(status.state, 'open');
  assert.equal(status.pendingRequests, 0);
  assert.equal(status.queuedSends, 0);
  assert.equal(logs.find('onebot.connected').length, 1);
  assert.ok(!logs.lines.join('\n').includes('s3cret'));
});

test('OneBot 返回失败 → ACTION_FAILED（未发出）；无响应 → TIMEOUT（结果未知）；迟到的响应被忽略', async () => {
  let lateEcho = null;
  const server = await fakeOneBot({
    respond: (req) => {
      if (req.action === 'send_private_msg') return { status: 'failed', retcode: 1200, wording: '账号被风控', data: null };
      if (req.action === 'get_group_list') { lateEcho = req.echo; return null; }
      return defaultRespond(req);
    },
  });
  const { client, logs } = makeClient(server, { requestTimeoutMs: 100 });
  await client.start();

  await assert.rejects(client.sendPrivateMsg(101, text('hi')), {
    code: 'ACTION_FAILED', delivery: 'not_sent', retcode: 1200, message: /账号被风控/,
  });
  const startedAt = Date.now();
  await assert.rejects(client.getGroupList(), { code: 'TIMEOUT', delivery: 'unknown', action: 'get_group_list' });
  assert.ok(Date.now() - startedAt >= 95);
  assert.equal(client.status().pendingRequests, 0);

  server.push({ status: 'ok', retcode: 0, data: [], echo: lateEcho });
  await waitFor(() => logs.find('onebot.unmatched_response').length === 1, { what: '迟到响应被记录' });
  assert.equal(logs.find('onebot.request_timeout').length, 1);
  assert.equal(client.connected, true);
});

test('断线恢复：服务端断开后自动重连；等待中的请求以 CONNECTION_LOST（结果未知）结束', async () => {
  const server = await fakeOneBot({ respond: (req) => (req.action === 'get_group_list' ? null : defaultRespond(req)) });
  const statuses = [];
  const { client, logs } = makeClient(server, { requestTimeoutMs: 5000, onStatus: (s) => statuses.push(s.connected) });
  await client.start();

  const pending = client.getGroupList();
  await waitFor(() => server.actions.some((a) => a.action === 'get_group_list'), { what: '请求到达' });
  server.dropAll();
  await assert.rejects(pending, { code: 'CONNECTION_LOST', delivery: 'unknown', action: 'get_group_list' });

  await waitFor(() => server.connections === 2 && client.connected, { what: '重连成功' });
  assert.deepEqual(statuses, [true, false, true]);
  assert.ok(Number.isInteger((await client.sendGroupMsg(200, text('又连上了'))).message_id));
  assert.equal(logs.find('onebot.disconnected').length, 1);
  assert.equal(client.status().reconnects, 1);
});

test('OneBot 没启动时按指数退避重试，启动后自动连上；连接稳定后退避重置', async () => {
  const placeholder = await fakeOneBot();
  const { port } = placeholder;
  await placeholder.close();

  const { client, logs } = makeClient(`ws://127.0.0.1:${port}`, { stableAfterMs: 50 });
  const started = client.start();
  await waitFor(() => logs.find('onebot.reconnect_scheduled').length >= 3, { what: '三次重试' });
  assert.deepEqual(logs.find('onebot.reconnect_scheduled').slice(0, 3).map((e) => e.delayMs), [20, 40, 80]);
  assert.equal(client.connected, false);
  // 断线期间发送直接失败，不排队等待。
  await assert.rejects(client.sendGroupMsg(200, text('x')), { code: 'NOT_CONNECTED', delivery: 'not_sent' });

  const server = await fakeOneBot({ port });
  assert.equal(await started, true);
  assert.equal(server.connections, 1);

  await sleep(80); // 超过 stableAfterMs，算作稳定连接
  const before = logs.find('onebot.reconnect_scheduled').length;
  server.dropAll();
  await waitFor(() => logs.find('onebot.reconnect_scheduled').length > before, { what: '断线后安排重连' });
  assert.equal(logs.find('onebot.reconnect_scheduled').at(-1).delayMs, 20);
});

test('连上就被断开时，退避继续增长，不会每次都立即重连', async () => {
  const server = await fakeOneBot({ onConnection: (socket) => setTimeout(() => socket.terminate(), 5) });
  const { client, logs } = makeClient(server);
  void client.start();
  await waitFor(() => logs.find('onebot.reconnect_scheduled').length >= 3, { what: '三次重连' });
  assert.deepEqual(logs.find('onebot.reconnect_scheduled').slice(0, 3).map((e) => e.delayMs), [20, 40, 80]);
  assert.ok(logs.find('onebot.disconnected').length >= 2);
});

test('token 错误：连不上但持续重试，日志里不出现 token', async () => {
  const server = await fakeOneBot({ token: 'right-token' });
  const { client, logs } = makeClient(server, { token: 'wrong-token-xyz' });
  void client.start();
  await waitFor(() => logs.find('onebot.connect_failed').length >= 2, { what: '两次连接失败' });
  assert.equal(server.connections, 0);
  assert.equal(client.connected, false);
  assert.ok(!logs.lines.join('\n').includes('wrong-token-xyz'));
});

test('日志里看不到地址里的账号密码和 token，即使报错信息带着完整地址', async () => {
  // 假的 WebSocket：一创建就报错，报错信息里带着原样的地址、规范化后的地址和解码后的 token。
  class LeakyWebSocket {
    constructor(target) {
      const parsed = new URL(target);
      throw new Error(`连不上 ${target} | ${parsed.href} | ${parsed.searchParams.getAll('access_token').join(' ')}`);
    }
  }
  const cases = [
    // 有路径；encodeURIComponent 不编码 '，URL 规范化后才变成 %27
    { url: 'ws://bob:pa%40ss@127.0.0.1:9/onebot?access_token=urlTokA%27x', token: "optTokB'y", endpoint: 'ws://127.0.0.1:9/onebot' },
    // 没有路径；密码和 token 里有未编码的 @、空格、&
    { url: 'ws://bob:pw@ssC@127.0.0.1:9?access_token=urlTok@D', token: 'optTok E&F', endpoint: 'ws://127.0.0.1:9' },
  ];
  // token 和密码的每一截都不能出现，免得只藏住了开头
  const pieces = ['bob', 'pa@ss', 'pa%40ss', 'urlTokA', '27x', 'optTokB', "'y", '27y',
    'pw@ssC', 'ssC', 'urlTok@D', 'Tok@D', 'optTok', 'E&F', '%26F'];
  for (const { url, token, endpoint } of cases) {
    const { client, logs } = makeClient(url, { token, WebSocketImpl: LeakyWebSocket });
    void client.start();
    await waitFor(() => logs.find('onebot.connect_failed').length >= 1, { what: '连接失败日志' });
    client.stop();
    assert.equal(logs.find('onebot.connect_failed')[0].endpoint, endpoint);
    const output = logs.lines.join('\n');
    assert.match(output, /access_token=\*\*\*/);
    for (const piece of pieces) assert.ok(!output.includes(piece), `${url} 的日志里出现了 ${piece}`);
  }
});

test('连接建立超时：握手一直没完成时放弃并重试', async () => {
  const sockets = [];
  const tcp = createServer((socket) => sockets.push(socket)); // 接受 TCP 连接，但从不回应握手
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  try {
    const { client, logs } = makeClient(`ws://127.0.0.1:${tcp.address().port}`, { connectTimeoutMs: 100 });
    void client.start();
    await waitFor(() => logs.find('onebot.connect_failed').length >= 2, { what: '两次连接超时' });
    assert.match(logs.find('onebot.connect_failed')[0].error.message, /100ms/);
    client.stop();
  } finally {
    for (const socket of sockets) socket.destroy();
    tcp.close();
  }
});

test('假活连接：长时间没有数据、探测也无响应时，主动断开并重连', async () => {
  const server = await fakeOneBot({ respond: () => null }); // 什么都不回
  const { client, logs } = makeClient(server, { idleTimeoutMs: 80, probeTimeoutMs: 80 });
  await client.start();
  await waitFor(() => server.connections >= 2, { what: '假活后重连' });
  const [unresponsive] = logs.find('onebot.unresponsive');
  assert.ok(unresponsive.idleMs >= 80);
  assert.ok(server.actions.some((a) => a.action === 'get_status'));
});

test('探测有回应（即使返回失败）就不断开', async () => {
  const server = await fakeOneBot({ respond: () => ({ status: 'failed', retcode: 1404, data: null }) });
  const { client, logs } = makeClient(server, { idleTimeoutMs: 50, probeTimeoutMs: 1000 });
  await client.start();
  await waitFor(() => server.actions.filter((a) => a.action === 'get_status').length >= 3, { what: '三次探测' });
  assert.equal(server.connections, 1);
  assert.equal(logs.find('onebot.unresponsive').length, 0);
  assert.equal(client.connected, true);
});

test('持续收到心跳时不探测；心跳里的在线状态会被记下', async () => {
  const server = await fakeOneBot();
  const { client } = makeClient(server, { idleTimeoutMs: 500 });
  await client.start();
  const heartbeat = { post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 900, time: 1, interval: 20, status: { online: true, good: true } };
  const timer = setInterval(() => server.push(heartbeat), 20);
  try {
    await sleep(800);
  } finally {
    clearInterval(timer);
  }
  assert.equal(server.actions.filter((a) => a.action === 'get_status').length, 0);
  assert.equal(client.botOnline, true);
});

test('心跳间隔比探测阈值长时，按心跳间隔的 1.5 倍放宽，不误探测', async () => {
  // 心跳声明 interval=200ms（SnowLuma 实测是 30000ms）；配置的阈值只有 50ms。
  const heartbeat = { post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 900, time: 1, interval: 200, status: { online: true, good: true } };
  let timer = null;
  const server = await fakeOneBot({
    onConnection: (socket) => {
      socket.send(JSON.stringify(heartbeat));
      timer = setInterval(() => socket.send(JSON.stringify(heartbeat)), 100);
    },
  });
  const { client } = makeClient(server, { idleTimeoutMs: 50 });
  await client.start();
  try {
    await sleep(700);
  } finally {
    clearInterval(timer);
  }
  assert.equal(client.heartbeatIntervalMs, 200);
  assert.equal(server.actions.filter((a) => a.action === 'get_status').length, 0);
});

test('异常数据不会让进程崩溃：坏 JSON、二进制、非对象、处理函数出错都只记日志', async () => {
  const problems = [];
  const onProblem = (error) => problems.push(error);
  process.on('unhandledRejection', onProblem);
  process.on('uncaughtException', onProblem);
  try {
    const server = await fakeOneBot();
    const seen = [];
    const { client, logs } = makeClient(server, {
      onEvent: (ev) => {
        if (ev.message_id === 1) throw new Error('同步出错');
        if (ev.message_id === 2) return Promise.reject(new Error('异步出错'));
        seen.push(ev);
        return undefined;
      },
    });
    await client.start();
    for (const bad of ['这不是 JSON', 'null', '[]', '42', '"字符串"', '{}', Buffer.from([1, 2, 3])]) server.push(bad);
    server.push({ echo: 'nobody-asked', status: 'ok', retcode: 0, data: null });
    for (const id of [1, 2, 3]) server.push(groupMessage(id));

    await waitFor(() => seen.some((e) => e.message_id === 3), { what: '后续正常消息' });
    await waitFor(() => logs.find('onebot.event_handler_failed').length === 2, { what: '处理出错被记录' });
    assert.equal(client.connected, true);
    assert.equal(client.badFrames, 7);
    // 坏数据成批出现时只记一条，带累计数；不记录内容。
    assert.equal(logs.find('onebot.bad_frame').length, 1);
    assert.ok(!logs.lines.join('\n').includes('这不是 JSON'));
    await sleep(20);
    assert.deepEqual(problems, []);
  } finally {
    process.off('unhandledRejection', onProblem);
    process.off('uncaughtException', onProblem);
  }
});

test('发送节流：并发发送按顺序排队并保持间隔；查询类动作不排队', async () => {
  // 在客户端记录每一帧真正写出的时间；服务端的接收时间会受网络抖动影响。
  const written = [];
  class RecordingWebSocket extends WebSocket {
    send(data) {
      written.push({ ...JSON.parse(data), at: Date.now() });
      return super.send(data);
    }
  }
  const server = await fakeOneBot();
  const { client } = makeClient(server, { WebSocketImpl: RecordingWebSocket, throttle: { minIntervalMs: 80, jitterMs: 0 } });
  await client.start();
  const sends = ['1', '2', '3'].map((t) => client.sendGroupMsg(200, text(t)));
  await client.getStatus();
  await Promise.all(sends);

  const got = written.filter((a) => a.action === 'send_group_msg');
  assert.deepEqual(got.map((a) => a.params.message[0].data.text), ['1', '2', '3']);
  for (let i = 1; i < got.length; i += 1) assert.ok(got[i].at - got[i - 1].at >= 75, `第 ${i + 1} 条间隔不足`);
  const order = written.map((a) => a.action);
  assert.ok(order.indexOf('get_status') < order.lastIndexOf('send_group_msg'), '查询不应排在所有发送后面');
  assert.equal(order.indexOf('get_status'), 1, '查询应紧跟第一条发送，不等节流');
});

test('节流队列满时直接失败（肯定没发出），日志带上消息 key', async () => {
  const server = await fakeOneBot();
  const { client, logs } = makeClient(server, { throttle: { minIntervalMs: 200, jitterMs: 0, maxQueue: 1 } });
  await client.start();
  const first = client.sendGroupMsg(200, text('a'));
  const second = client.sendGroupMsg(200, text('b'));
  await assert.rejects(client.sendGroupMsg(200, text('c'), { key: 'k3' }), { code: 'QUEUE_FULL', delivery: 'not_sent' });
  assert.equal(logs.find('onebot.send_dropped')[0].messageKey, 'k3');
  await Promise.all([first, second]);
});

test('stop：等待中的请求结果未知、排队中的未发送，都立即结束；之后不再重连', async () => {
  const server = await fakeOneBot({ respond: (req) => (req.action === 'send_group_msg' ? null : defaultRespond(req)) });
  const { client } = makeClient(server, { throttle: { minIntervalMs: 1000, jitterMs: 0 }, requestTimeoutMs: 5000 });
  await client.start();
  const inflight = client.sendGroupMsg(200, text('已发出、没回应'));
  const queued = client.sendGroupMsg(200, text('还在排队'));
  await waitFor(() => server.actions.some((a) => a.action === 'send_group_msg'), { what: '第一条发出' });
  client.stop();
  await assert.rejects(inflight, { code: 'STOPPED', delivery: 'unknown' });
  await assert.rejects(queued, { code: 'STOPPED', delivery: 'not_sent' });
  await assert.rejects(client.sendGroupMsg(200, text('停止后')), { code: 'STOPPED' });
  await sleep(100);
  assert.equal(server.connections, 1);
  assert.equal(client.status().state, 'stopped');
});

test('waitForConnection：已连着立即返回 true；断线后等到重连返回 true；超时或停止返回 false', async () => {
  const server = await fakeOneBot();
  const { client } = makeClient(server);
  await client.start();
  assert.equal(await client.waitForConnection(10), true);

  server.dropAll();
  await waitFor(() => !client.connected, { what: '断线' });
  assert.equal(await client.waitForConnection(2000), true, '重连后应返回 true');
  assert.equal(client.connected, true);

  await server.close(); // 之后一直连不上
  await waitFor(() => !client.connected, { what: '服务端关闭后断线' });
  assert.equal(await client.waitForConnection(50), false, '超时返回 false');

  const pending = client.waitForConnection(5000);
  client.stop();
  assert.equal(await pending, false, '停止时返回 false');
  assert.equal(await client.waitForConnection(5000), false, '停止后立即返回 false');
});

test('QQ 账号离线、恢复在线：状态和日志都反映出来', async () => {
  const server = await fakeOneBot();
  const { client, logs } = makeClient(server);
  await client.start();
  const botStatus = (subType) => ({ post_type: 'notice', notice_type: 'bot_status', sub_type: subType, self_id: 900, user_id: 900, time: 1 });
  server.push(botStatus('offline'));
  await waitFor(() => client.botOnline === false, { what: '离线' });
  server.push(botStatus('online'));
  await waitFor(() => client.botOnline === true, { what: '恢复在线' });
  assert.equal(logs.find('onebot.bot_offline').length, 1);
  assert.equal(logs.find('onebot.bot_online').length, 1);
  assert.equal(client.status().botOnline, true);
});

test('地址无效时创建客户端直接报错（配置错误不该无限重试），报错不回显地址', () => {
  assert.throws(() => new OneBotClient({ url: '127.0.0.1:3001' }), /ws:\/\/.*无法解析/);
  assert.throws(() => new OneBotClient({ url: 'http://127.0.0.1:3001' }), /ws:\/\/.*当前是 http:/);
  // 包括解析不了、没法可靠找出密码的地址：密码里有未编码的 /，或者忘了写 ws://
  for (const url of ['localhost:3001?access_token=leak', 'http://bob:leak@127.0.0.1:3001',
    'ws://bob:le/ak@127.0.0.1:3001', 'bob:leak@127.0.0.1:3001']) {
    assert.throws(() => new OneBotClient({ url }), (error) => !/leak|le\/ak/.test(error.message), url);
  }
  assert.doesNotThrow(() => new OneBotClient({ url: 'wss://example.invalid/onebot' }));
});
