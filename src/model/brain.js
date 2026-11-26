// DeepSeek 大脑（模型调用适配器）：Responses API + 服务端联网搜索（web_search，只有 deepseek-v4-pro 支持）。
// 这一层负责“调用模型”这件事本身。处理器只会拿到一段可以发出的文字，或者一个 ModelError：
// - 时限：一次回复（含重试）最多 deadlineMs；第一次尝试最多 firstAttemptMs，给第二次留出时间。
// - 重试：最多两次尝试。第二次不搜索、不思考，最快最省，最可能在剩余时间里答完。
//   只有“换一次可能成功”的错误才重试（超时、限流、服务端错误、空回复、数据无法识别）；
//   鉴权、余额、参数、内容过滤这类错误重试也没用，直接失败。
// - 检查结果：HTTP 200 也要看 status。failed 是生成失败；incomplete 是被长度上限截断或被内容过滤。
// - 错误信息是固定的中文说明，不带模型服务返回的原文；日志只记状态码、对方的错误码和 trace id。
// - 花费：每次拿到 usage 就按官方价格估算花费、记进账本；超时拿不到 usage 的，按当天平均估算。
// - 上限：今天的花费达到上限后不再调用模型；每个会话在时间窗口内的调用次数有上限（见 rate-limiter.js）。
import { setTimeout as sleep } from 'node:timers/promises';
import { ModelError } from './errors.js';
import { estimateCostCny, beijingDate } from './pricing.js';
import { silentLogger } from '../log.js';

export const BRAIN_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  webSearch: true,
  reasoningEffort: null, // null：用模型默认（v4-pro 默认开启思考）
  maxOutputTokens: 2500, // 含思考消耗的 token
  deadlineMs: 60_000, // 一次回复（含重试）的总时限
  firstAttemptMs: 45_000, // 第一次尝试最多等多久，剩下的时间留给第二次
  minAttemptMs: 5_000, // 剩余时间不够这么久，就不再发起第二次
  retryDelayMs: 1_000, // 服务端错误、网络错误后等多久再试
  rateLimitDelayMs: 3_000, // 被限流（429）后等多久再试
  budgetWarnRatio: 0.8, // 今天的花费超过上限的这个比例时，记一条警告
  unknownCallCostCny: 0.05, // 超时拿不到用量、当天又没有可参考的平均值时，按这个金额估算
};

// 对方返回的错误码、trace id 只保留短的安全标识，其他一律丢弃（原文可能带有输入片段）。
function safeId(value) {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[\w.:-]{1,80}$/.test(text) ? text : undefined;
}

function outputText(json) {
  const output = Array.isArray(json.output) ? json.output : [];
  return output
    .filter((item) => item?.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

// Responses API 的 usage：input_tokens 含缓存命中（input_tokens_details.cached_tokens），
// output_tokens 含思考（output_tokens_details.reasoning_tokens），server_tool_use 是搜索、读网页的次数（全为 0 时省略）。
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const tools = usage.server_tool_use ?? {};
  return {
    inputTokens: n(usage.input_tokens),
    cachedTokens: n(usage.input_tokens_details?.cached_tokens),
    outputTokens: n(usage.output_tokens),
    reasoningTokens: n(usage.output_tokens_details?.reasoning_tokens),
    searches: n(tools.tool_search) + n(tools.tool_image_search),
    fetches: n(tools.tool_fetch),
  };
}

function httpError(status, raw, traceId) {
  let providerCode;
  try {
    const body = JSON.parse(raw);
    providerCode = safeId(body?.error?.code) ?? safeId(body?.error?.type);
  } catch {
    // 错误响应不是 JSON：只记状态码
  }
  let code = 'BAD_REQUEST';
  if (status === 401 || status === 403) code = 'AUTH';
  else if (status === 402) code = 'INSUFFICIENT_BALANCE';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status === 408) code = 'TIMEOUT';
  else if (status >= 500) code = 'SERVER_ERROR';
  return new ModelError(code, { httpStatus: status, providerCode, traceId });
}

// 回复被长度上限截断时，保留到最后一个完整句子；完整的部分不到一半，就保留原文、末尾加省略号。
export function trimToSentence(text) {
  const trimmed = text.trimEnd();
  let last = -1;
  for (const match of trimmed.matchAll(/[。！？!?…~～\n]/g)) last = match.index;
  if (last >= 0 && last + 1 >= trimmed.length * 0.5) return trimmed.slice(0, last + 1).trimEnd();
  return `${trimmed}…`;
}

const round = (value) => Math.round(value * 10_000) / 10_000;

function usageFields(usage) {
  return usage ? { ...usage } : {};
}

export class DeepSeekBrain {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {import('./usage-ledger.js').ModelUsageLedger} [options.ledger] 用量账本；不传就不入账，也不执行每日上限
   * @param {import('./rate-limiter.js').ConversationRateLimiter} [options.limiter] 按会话限速；不传就不限
   * @param {number|(() => number)} [options.dailyBudgetCny] 每日花费上限（元）；0 表示不限。
   *   传函数时每次调用前取一次（Module 9：用 naiwa budget set 改，奶蛙不用重启）
   * @param {object} [options.logger] 见 src/log.js
   * 其余选项见 BRAIN_DEFAULTS。
   */
  constructor({
    apiKey, ledger = null, limiter = null, dailyBudgetCny = 0, logger = silentLogger,
    fetchImpl = globalThis.fetch, now = () => new Date(), ...options
  } = {}) {
    if (!apiKey) throw new Error('DeepSeekBrain 需要 apiKey');
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    this.options = { ...BRAIN_DEFAULTS, ...given };
    this.apiKey = apiKey;
    this.baseUrl = String(this.options.baseUrl).replace(/\/+$/, '');
    this.model = this.options.model;
    this.webSearch = this.options.webSearch;
    this.reasoningEffort = this.options.reasoningEffort;
    this.maxOutputTokens = this.options.maxOutputTokens;
    this.ledger = ledger;
    this.limiter = limiter;
    this.budget = typeof dailyBudgetCny === 'function' ? dailyBudgetCny : () => dailyBudgetCny;
    this.log = logger;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.budgetAlerts = { warned: null, exceeded: null }; // 每天只提醒一次
  }

  /**
   * 生成一条回复。成功返回非空文字；失败抛 ModelError。
   * @param {Array<{role: string, content: string|Array}>} messages system 消息合并成 instructions，其余作为 input
   *   （content 可以是 Responses API 的内容块数组，例如看图时的 input_text、input_image）
   * @param {object} [opts]
   * @param {string} [opts.key] 消息 key，只用于日志关联
   * @param {string} [opts.conversationKey] 会话 key，用于按会话限速和用量统计
   * @param {string} [opts.safetyCheck] DeepSeek 内容安全审核的级别（看图时传 'high'）；不传就不带这个参数
   * @param {number} [opts.deadline] 外面给的截止时间（Date.now() 的毫秒数）：每次尝试都不超过它，到点不再重试
   * @param {AbortSignal} [opts.signal] 外面的取消信号：取消时停下正在等的请求，不再重试
   */
  async chat(messages, {
    key, conversationKey, webSearch = this.webSearch, maxOutputTokens = this.maxOutputTokens,
    safetyCheck = null, deadline: outerDeadline = Infinity, signal = null,
  } = {}) {
    const log = key ? this.log.child({ messageKey: key }) : this.log;
    const startedAt = Date.now();
    if (signal?.aborted) throw new ModelError('TIMEOUT'); // 外面已经到点：一次都不调
    await this._checkBudget(log);
    this._checkRate(log, conversationKey);

    const deadline = Math.min(startedAt + this.options.deadlineMs, outerDeadline);
    const plan = [
      { webSearch, reasoningEffort: this.reasoningEffort },
      { webSearch: false, reasoningEffort: 'none' },
    ];
    const spent = { costCny: 0 };
    let lastError = null;
    for (let i = 0; i < plan.length; i += 1) {
      if (lastError) {
        const delayMs = this._retryDelay(lastError);
        if (signal?.aborted || deadline - Date.now() - delayMs < this.options.minAttemptMs) break;
        if (delayMs) await sleep(delayMs);
      }
      // 外面到点了（取消了，或者截止时间已过）：不再发请求。
      if (signal?.aborted || deadline - Date.now() <= 0) {
        lastError ??= new ModelError('TIMEOUT');
        break;
      }
      const timeoutMs = Math.max(1, Math.min(i === 0 ? this.options.firstAttemptMs : Infinity, deadline - Date.now()));
      const attemptStartedAt = Date.now();
      try {
        const result = await this._attempt(messages, {
          ...plan[i], n: i + 1, timeoutMs, maxOutputTokens, conversationKey, log, spent, safetyCheck, signal,
        });
        log.info('model.done', {
          attempts: i + 1,
          webSearch: result.webSearch,
          reasoningEffort: result.reasoningEffort ?? undefined,
          truncated: result.truncated || undefined,
          ...usageFields(result.usage),
          costCny: round(spent.costCny),
          ms: Date.now() - startedAt,
          traceId: result.traceId,
        });
        return result.text;
      } catch (error) {
        if (!(error instanceof ModelError)) throw error; // 不是模型调用本身的问题（代码错误），不重试
        lastError = error;
        log.warn('model.attempt_failed', {
          msg: '模型调用失败', attempt: i + 1, code: error.code, httpStatus: error.httpStatus,
          providerCode: error.providerCode, traceId: error.traceId, retryable: error.retryable, ms: Date.now() - attemptStartedAt,
        });
        if (!error.retryable) throw error;
      }
    }
    throw lastError;
  }

  _retryDelay(error) {
    if (error.code === 'RATE_LIMITED') return this.options.rateLimitDelayMs;
    if (error.code === 'SERVER_ERROR' || error.code === 'NETWORK') return this.options.retryDelayMs;
    return 0; // 超时、空回复、数据无法识别：马上换一种方式再试
  }

  _body(messages, { webSearch, reasoningEffort, maxOutputTokens, safetyCheck }) {
    const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const input = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const body = { model: this.model, input, max_output_tokens: maxOutputTokens };
    if (safetyCheck) body.safety_check = { level: safetyCheck };
    if (instructions) body.instructions = instructions;
    if (webSearch) body.tools = [{ type: 'web_search' }];
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
    return body;
  }

  async _attempt(messages, {
    webSearch, reasoningEffort, maxOutputTokens, timeoutMs, n, conversationKey, log, spent, safetyCheck = null, signal = null,
  }) {
    const at = this.now();
    const fetchImpl = this.fetchImpl;
    let res;
    let raw;
    // 同时管住等响应头和读响应体；外面取消时一起停。
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      res = await fetchImpl(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(this._body(messages, { webSearch, reasoningEffort, maxOutputTokens, safetyCheck })),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      raw = await res.text();
    } catch (error) {
      if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        // 请求已经发出（包括被外面取消的），对方可能已经在生成并计费，只是我们拿不到用量：按估算入账，宁可多算。
        await this._recordUsage({ at, conversationKey, usage: null, log, spent });
        throw new ModelError('TIMEOUT');
      }
      throw new ModelError('NETWORK');
    }
    const traceId = safeId(res.headers.get('x-ds-trace-id'));
    if (!res.ok) throw httpError(res.status, raw, traceId);

    let json = null;
    try {
      json = JSON.parse(raw); // 排队时对方会先发空行，JSON.parse 会忽略开头的空白
    } catch {
      // 下面统一处理
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new ModelError('BAD_RESPONSE', { httpStatus: res.status, traceId });
    }
    // 生成失败、被截断、被过滤的调用也可能计费，只要有 usage 就入账。
    const usage = normalizeUsage(json.usage);
    if (usage) await this._recordUsage({ at, conversationKey, usage, log, spent });
    const text = outputText(json);
    const status = json.status ?? 'completed';
    const reason = safeId(json.incomplete_details?.reason);
    // status 也来自对方，和其他字段一样只记安全的短标识；下面的判断仍用原值。
    log.debug('model.attempt', {
      attempt: n, webSearch, reasoningEffort: reasoningEffort ?? undefined, status: safeId(status), reason,
      textChars: text.length, traceId, ...usageFields(usage),
    });

    if (status === 'failed') {
      throw new ModelError('SERVER_ERROR', { httpStatus: res.status, providerCode: safeId(json.error?.code), traceId });
    }
    if (status === 'incomplete') {
      if (reason === 'content_filter') throw new ModelError('FILTERED', { traceId });
      if (!text.trim()) throw new ModelError('EMPTY', { traceId }); // 例如长度上限全被思考用掉了
      log.warn('model.truncated', { msg: '回复超出长度上限被截断，只保留到最后一个完整句子', attempt: n, reason, traceId });
      return { text: trimToSentence(text), usage, traceId, truncated: true, webSearch, reasoningEffort };
    }
    if (status !== 'completed') throw new ModelError('BAD_RESPONSE', { httpStatus: res.status, traceId });
    if (!text.trim()) throw new ModelError('EMPTY', { traceId });
    return { text, usage, traceId, truncated: false, webSearch, reasoningEffort };
  }

  async _recordUsage({ at, conversationKey, usage, log, spent }) {
    try {
      let costCny;
      if (usage) {
        costCny = estimateCostCny({ model: this.model, usage, at });
      } else {
        const today = this.ledger ? await this.ledger.day(at) : null;
        costCny = today?.calls > 0
          ? today.costCny / (today.calls + today.unknownCalls)
          : this.options.unknownCallCostCny;
      }
      spent.costCny += costCny;
      await this.ledger?.record({ at, conversationKey, model: this.model, usage, costCny });
    } catch (error) {
      // 入账失败不影响回复，但今天的花费会少算，要让运维看到。
      log.error('model.usage_record_failed', { msg: '记录模型用量失败，今日花费会少算', error });
    }
  }

  async _checkBudget(log) {
    const budgetCny = Number(this.budget());
    if (!this.ledger || !(budgetCny > 0)) return;
    const at = this.now();
    let spentCny;
    try {
      spentCny = (await this.ledger.day(at)).costCny;
    } catch (error) {
      // 读不到账本（数据库出问题）时不拦：这时记忆也读不了，回复多半本来就会失败。
      log.error('model.budget_check_failed', { msg: '读取今日花费失败，本次不检查上限', error });
      return;
    }
    const day = beijingDate(at);
    const fields = { spentCny: round(spentCny), budgetCny, day };
    if (spentCny >= budgetCny) {
      if (this.budgetAlerts.exceeded !== day) {
        this.budgetAlerts.exceeded = day;
        log.error('model.budget_exceeded', { msg: '今日模型花费已达上限，北京时间零点前不再调用模型', ...fields });
      }
      throw new ModelError('BUDGET_EXCEEDED');
    }
    if (spentCny >= budgetCny * this.options.budgetWarnRatio && this.budgetAlerts.warned !== day) {
      this.budgetAlerts.warned = day;
      log.warn('model.budget_warning', {
        msg: `今日模型花费已超过上限的 ${Math.round(this.options.budgetWarnRatio * 100)}%`, ...fields,
      });
    }
  }

  _checkRate(log, conversationKey) {
    if (!this.limiter || !conversationKey) return;
    const gate = this.limiter.take(conversationKey);
    if (gate.allowed) return;
    // 第一次被拒记警告；同一段受限时间里之后的拒绝只记 info，免得刷屏的人把日志也刷满。
    log[gate.notify ? 'warn' : 'info']('model.rate_limited', {
      msg: '这个会话调用模型太频繁，本条不调用模型', window: gate.window, retryAfterMs: gate.retryAfterMs, notify: gate.notify,
    });
    throw new ModelError('CONVERSATION_RATE_LIMITED', { notify: gate.notify, retryAfterMs: gate.retryAfterMs });
  }
}
