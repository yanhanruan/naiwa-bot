import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DeepSeekBrain } from '../src/model/brain.js';
import { ModelUsageLedger } from '../src/model/usage-ledger.js';
import { ConversationRateLimiter } from '../src/model/rate-limiter.js';
import { captureLogger, testDb, closeTestDb } from './helpers.js';

// 用一个真实的本地 HTTP 服务扮演 DeepSeek Responses API，按收到的第几个请求决定怎么回。
const servers = [];
after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await closeTestDb();
});

const API_KEY = 'sk-test-secret-key';
// 北京时间 2026-11-17（周二）18:00，属于空闲时段，按空闲价格计费。
const OFF_PEAK = new Date('2026-11-17T10:00:00Z');

// 2026-11-17 实测的一次带联网搜索的调用返回的 usage（deepseek-v4-pro）。
const USAGE = {
  input_tokens: 6400,
  input_tokens_details: { cached_tokens: 2944 },
  output_tokens: 326,
  output_tokens_details: { reasoning_tokens: 152 },
  total_tokens: 6726,
  server_tool_use: { tool_search: 2, tool_fetch: 1, tool_image_search: 0 },
};
// 按空闲价格：(6400-2944)×4.5 + 2944×0.15 + 326×13.5 元/百万 token，加 3 次搜索/读网页 × 0.005 元
const USAGE_COST = 0.0353946;

function response(text, { status = 'completed', reason = null, usage = USAGE, error = null } = {}) {
  return {
    id: 'resp_1', object: 'response', status, error, model: 'deepseek-v4-pro',
    incomplete_details: reason ? { reason } : null,
    output: [
      { type: 'reasoning', id: 'r1', status: 'completed', content: [{ type: 'reasoning_text', text: '思考过程' }], summary: [] },
      { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'search', queries: ['q'] } },
      {
        type: 'message', role: 'assistant', status: 'completed',
        content: text === null ? [] : [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage,
  };
}

// script：数组（第 n 个请求用第 n 项，超出后一直用最后一项）或函数 (n) => step。
// step：{ status, body, headers, preamble（先发的内容）, delayMs（晚点发完）, hang（一直不回应） }
async function fakeDeepSeek(script) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const n = requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw), at: Date.now() });
    const step = (typeof script === 'function' ? script(n) : script[Math.min(n, script.length) - 1]) ?? {};
    if (step.hang) return;
    res.writeHead(step.status ?? 200, { 'content-type': 'application/json', 'x-ds-trace-id': `trace-${n}`, ...step.headers });
    if (step.preamble) res.write(step.preamble);
    const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? response('好的'));
    if (step.delayMs) setTimeout(() => res.end(body), step.delayMs);
    else res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// 测试用的时限都很小。
function makeBrain(server, overrides = {}) {
  const logs = captureLogger();
  const brain = new DeepSeekBrain({
    apiKey: API_KEY, baseUrl: server.url, logger: logs.logger, now: () => OFF_PEAK,
    deadlineMs: 3000, firstAttemptMs: 2000, minAttemptMs: 50, retryDelayMs: 10, rateLimitDelayMs: 30,
    ...overrides,
  });
  return { brain, logs };
}

async function makeLedger() {
  return new ModelUsageLedger({ db: await testDb(), tenantId: `test-${randomUUID()}` });
}

const messages = [
  { role: 'system', content: '你是奶蛙' },
  { role: 'user', content: '用户的秘密问题' },
];

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('正常：请求格式正确，返回文字；用量按官方价格估算后入账；日志不含正文和 key', async () => {
  const server = await fakeDeepSeek([{ body: response('今天天气不错呱') }]);
  const ledger = await makeLedger();
  const { brain, logs } = makeBrain(server, { ledger });
  assert.equal(await brain.chat(messages, { key: 'k1', conversationKey: 'conv-1' }), '今天天气不错呱');

  const [req] = server.requests;
  assert.equal(req.url, '/v1/responses');
  assert.equal(req.headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(req.body, {
    model: 'deepseek-v4-pro',
    input: [{ role: 'user', content: '用户的秘密问题' }],
    max_output_tokens: 2500,
    instructions: '你是奶蛙',
    tools: [{ type: 'web_search' }],
  });

  const day = await ledger.day(OFF_PEAK);
  assert.equal(day.calls, 1);
  assert.ok(close(day.costCny, USAGE_COST), String(day.costCny));
  const [done] = logs.find('model.done');
  assert.equal(done.messageKey, 'k1');
  assert.equal(done.attempts, 1);
  assert.deepEqual(
    [done.inputTokens, done.cachedTokens, done.outputTokens, done.reasoningTokens, done.searches, done.fetches],
    [6400, 2944, 326, 152, 2, 1],
  );
  assert.equal(done.costCny, 0.0354);
  assert.equal(done.traceId, 'trace-1');
  const all = logs.lines.join('\n');
  for (const secret of [API_KEY, '秘密问题', '天气不错', '你是奶蛙', '思考过程']) assert.ok(!all.includes(secret), secret);
});

test('排队时对方先发空行、过一会儿才发 JSON：照常解析', async () => {
  const server = await fakeDeepSeek([{ preamble: '\n\n\n', delayMs: 30, body: response('来啦') }]);
  const { brain } = makeBrain(server);
  assert.equal(await brain.chat(messages), '来啦');
});

test('空回复：第二次不搜索、不思考，重试成功；两次都空就报 EMPTY', async () => {
  const server = await fakeDeepSeek([{ body: response('   ') }, { body: response('第二次答上了') }]);
  const { brain, logs } = makeBrain(server);
  assert.equal(await brain.chat(messages), '第二次答上了');
  assert.deepEqual(server.requests[0].body.tools, [{ type: 'web_search' }]);
  assert.equal(server.requests[0].body.reasoning, undefined);
  assert.equal(server.requests[1].body.tools, undefined);
  assert.deepEqual(server.requests[1].body.reasoning, { effort: 'none' });
  assert.equal(logs.find('model.attempt_failed')[0].code, 'EMPTY');
  assert.equal(logs.find('model.done')[0].attempts, 2);

  const empty = await fakeDeepSeek([{ body: response(null) }]);
  await assert.rejects(makeBrain(empty).brain.chat(messages), { name: 'ModelError', code: 'EMPTY' });
  assert.equal(empty.requests.length, 2);
});

test('被长度上限截断：保留到最后一个完整句子并记警告；截断后什么都没有就当空回复重试', async () => {
  const cut = response('第一句说完了。第二句也说完了！第三句还没说', { status: 'incomplete', reason: 'max_output_tokens' });
  const server = await fakeDeepSeek([{ body: cut }]);
  const { brain, logs } = makeBrain(server);
  assert.equal(await brain.chat(messages), '第一句说完了。第二句也说完了！');
  assert.equal(logs.find('model.truncated').length, 1);
  assert.equal(logs.find('model.done')[0].truncated, true);

  // 例如长度上限全被思考用掉了
  const nothing = await fakeDeepSeek([
    { body: response(null, { status: 'incomplete', reason: 'max_output_tokens' }) },
    { body: response('这次答完了') },
  ]);
  assert.equal(await makeBrain(nothing).brain.chat(messages), '这次答完了');
});

test('内容过滤：报 FILTERED，不重试', async () => {
  const server = await fakeDeepSeek([{ body: response(null, { status: 'incomplete', reason: 'content_filter' }) }]);
  await assert.rejects(makeBrain(server).brain.chat(messages), { code: 'FILTERED', retryable: false });
  assert.equal(server.requests.length, 1);
});

test('HTTP 200 但 status 为 failed：按服务端错误重试，只记对方的错误码', async () => {
  const failed = response(null, { status: 'failed', error: { code: 'server_error', message: '对方的内部细节' } });
  const server = await fakeDeepSeek([{ body: failed }, { body: response('好了') }]);
  const { brain, logs } = makeBrain(server);
  assert.equal(await brain.chat(messages), '好了');
  const [attempt] = logs.find('model.attempt_failed');
  assert.equal(attempt.code, 'SERVER_ERROR');
  assert.equal(attempt.providerCode, 'server_error');
  assert.ok(!logs.lines.join('\n').includes('内部细节'));
});

test('被限流（429）：等一会儿再试；两次都被限流就报 RATE_LIMITED', async () => {
  const limited = { status: 429, body: { error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } } };
  const server = await fakeDeepSeek([limited, { body: response('排上了') }]);
  const { brain } = makeBrain(server, { rateLimitDelayMs: 80 });
  assert.equal(await brain.chat(messages), '排上了');
  assert.ok(server.requests[1].at - server.requests[0].at >= 75, '429 之后应该先等一会儿');

  const always = await fakeDeepSeek([limited]);
  await assert.rejects(makeBrain(always).brain.chat(messages), {
    code: 'RATE_LIMITED', httpStatus: 429, providerCode: 'rate_limit_exceeded', traceId: 'trace-2',
  });
});

test('服务端 5xx、返回内容无法识别：各重试一次', async () => {
  const server = await fakeDeepSeek([
    { status: 502, body: '<html>bad gateway</html>', headers: { 'content-type': 'text/html' } },
    { body: 'not json at all' },
  ]);
  const { brain, logs } = makeBrain(server);
  await assert.rejects(brain.chat(messages), { code: 'BAD_RESPONSE' });
  assert.deepEqual(logs.find('model.attempt_failed').map((e) => e.code), ['SERVER_ERROR', 'BAD_RESPONSE']);
});

test('status 不是已知的值：按无法识别处理（重试一次），调试日志里也不出现原文', async () => {
  const weird = { ...response('有文字'), status: '对方的奇怪状态 用户的秘密问题' };
  const server = await fakeDeepSeek([{ body: weird }]);
  const { brain, logs } = makeBrain(server); // captureLogger 默认收集 debug 级别
  await assert.rejects(brain.chat(messages), { code: 'BAD_RESPONSE' });
  assert.equal(server.requests.length, 2);
  assert.equal(logs.find('model.attempt').length, 2);
  assert.ok(!logs.lines.join('\n').includes('奇怪状态'));
});

test('鉴权、余额、参数错误不重试；对方返回的原文不进错误信息和日志', async () => {
  const cases = [[401, 'AUTH'], [403, 'AUTH'], [402, 'INSUFFICIENT_BALANCE'], [400, 'BAD_REQUEST'], [422, 'BAD_REQUEST']];
  for (const [status, code] of cases) {
    // 错误码里有空格，不是安全的短标识，只保留 type
    const body = { error: { message: `echo：用户的秘密问题 ${API_KEY}`, type: 'invalid_request_error', code: 'bad code with spaces' } };
    const server = await fakeDeepSeek([{ status, body }]);
    const { brain, logs } = makeBrain(server);
    const error = await brain.chat(messages, { key: 'k' }).then(() => null, (e) => e);
    assert.equal(error?.code, code, `HTTP ${status}`);
    assert.equal(error.httpStatus, status);
    assert.equal(error.retryable, false);
    assert.equal(error.providerCode, 'invalid_request_error');
    assert.equal(server.requests.length, 1, `HTTP ${status} 不应重试`);
    const text = `${error.message}\n${logs.lines.join('\n')}`;
    for (const secret of ['秘密问题', API_KEY, 'echo']) assert.ok(!text.includes(secret), `HTTP ${status}: ${secret}`);
  }
});

test('第一次超时：放弃并换不搜索、不思考的方式再试；超时那次拿不到用量，按估算入账', async () => {
  const server = await fakeDeepSeek([{ hang: true }, { body: response('第二次很快') }]);
  const ledger = await makeLedger();
  const { brain, logs } = makeBrain(server, { ledger, firstAttemptMs: 200, unknownCallCostCny: 0.05 });
  const startedAt = Date.now();
  assert.equal(await brain.chat(messages, { conversationKey: 'c' }), '第二次很快');
  assert.ok(Date.now() - startedAt >= 195);
  assert.equal(logs.find('model.attempt_failed')[0].code, 'TIMEOUT');
  assert.equal(server.requests[1].body.tools, undefined);
  const day = await ledger.day(OFF_PEAK);
  assert.deepEqual([day.calls, day.unknownCalls], [1, 1]);
  assert.ok(close(day.costCny, 0.05 + USAGE_COST), String(day.costCny));
  assert.ok(close(logs.find('model.done')[0].costCny, 0.0854));
});

test('一直没有响应：在总时限内放弃，报 TIMEOUT', async () => {
  const server = await fakeDeepSeek([{ hang: true }]);
  const { brain } = makeBrain(server, { firstAttemptMs: 150, deadlineMs: 400 });
  const startedAt = Date.now();
  await assert.rejects(brain.chat(messages), { code: 'TIMEOUT' });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 380 && elapsed < 2000, `用时 ${elapsed}ms`);
  assert.equal(server.requests.length, 2);
});

test('剩余时间不够再试一次时，直接报第一次的错误', async () => {
  const server = await fakeDeepSeek([{ hang: true }]);
  const { brain } = makeBrain(server, { firstAttemptMs: 200, deadlineMs: 250, minAttemptMs: 100 });
  await assert.rejects(brain.chat(messages), { code: 'TIMEOUT' });
  assert.equal(server.requests.length, 1);
});

test('连不上模型服务：报 NETWORK（重试过一次）', async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve)); // 端口已关闭，保证连不上
  const { brain, logs } = makeBrain({ url: `http://127.0.0.1:${port}` });
  await assert.rejects(brain.chat(messages), { code: 'NETWORK' });
  assert.equal(logs.find('model.attempt_failed').length, 2);
});

test('每日花费上限：超过 80% 先记警告；达到上限后不再请求模型，错误日志每天只记一次；第二天自动恢复', async () => {
  const server = await fakeDeepSeek([{ body: response('好') }]);
  const ledger = await makeLedger();
  const { brain, logs } = makeBrain(server, { ledger, dailyBudgetCny: 0.1 });
  await ledger.record({ at: OFF_PEAK, conversationKey: 'c', model: 'deepseek-v4-pro', usage: null, costCny: 0.085 });

  assert.equal(await brain.chat(messages), '好'); // 0.085 还没到上限，照常调用
  assert.equal(logs.find('model.budget_warning').length, 1);
  // 这次又花了约 0.035，超过 0.1
  await assert.rejects(brain.chat(messages), { code: 'BUDGET_EXCEEDED' });
  await assert.rejects(brain.chat(messages), { code: 'BUDGET_EXCEEDED' });
  assert.equal(server.requests.length, 1);
  assert.equal(logs.find('model.budget_exceeded').length, 1);
  assert.equal(logs.find('model.budget_warning').length, 1);

  const nextDay = new Date('2026-11-17T16:00:00Z'); // 北京时间 11-18 00:00
  const tomorrow = makeBrain(server, { ledger, dailyBudgetCny: 0.1, now: () => nextDay }).brain;
  assert.equal(await tomorrow.chat(messages), '好');
});

test('按会话限速：超过次数就不请求模型；同一段受限时间只有第一次带提示标记；不同会话互不影响', async () => {
  const server = await fakeDeepSeek([{ body: response('好') }]);
  let now = 1_000_000;
  const limiter = new ConversationRateLimiter({ perMinute: 2, perHour: 0, now: () => now });
  const { brain, logs } = makeBrain(server, { limiter });
  await brain.chat(messages, { conversationKey: 'a' });
  await brain.chat(messages, { conversationKey: 'a' });
  const first = await brain.chat(messages, { conversationKey: 'a' }).then(() => null, (e) => e);
  assert.equal(first?.code, 'CONVERSATION_RATE_LIMITED');
  assert.equal(first.notify, true);
  assert.equal(first.retryAfterMs, 60_000);
  const second = await brain.chat(messages, { conversationKey: 'a' }).then(() => null, (e) => e);
  assert.equal(second.notify, false);
  assert.equal(await brain.chat(messages, { conversationKey: 'b' }), '好');
  now += 60_000;
  assert.equal(await brain.chat(messages, { conversationKey: 'a' }), '好');
  assert.equal(server.requests.length, 4);
  assert.deepEqual(logs.find('model.rate_limited').map((e) => [e.level, e.notify]), [['warn', true], ['info', false]]);
});

test('可以关闭联网搜索、指定思考强度', async () => {
  const server = await fakeDeepSeek([{ body: response('好') }]);
  const { brain } = makeBrain(server, { webSearch: false, reasoningEffort: 'high' });
  await brain.chat(messages);
  assert.equal(server.requests[0].body.tools, undefined);
  assert.deepEqual(server.requests[0].body.reasoning, { effort: 'high' });
});
