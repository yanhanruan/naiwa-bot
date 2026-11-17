// 模型调用的错误。message 是固定的中文说明，不包含模型服务返回的原文（原文可能带有输入片段）。
// retryable：换一次请求有可能成功（超时、限流、服务端错误、空回复……）；配置或内容问题重试没有用。
export const MODEL_ERRORS = {
  TIMEOUT: { retryable: true, message: '模型在限定时间内没有返回' },
  NETWORK: { retryable: true, message: '连不上模型服务' },
  RATE_LIMITED: { retryable: true, message: '模型服务限流（HTTP 429）' },
  SERVER_ERROR: { retryable: true, message: '模型服务内部错误' },
  BAD_RESPONSE: { retryable: true, message: '模型服务返回的数据无法识别' },
  EMPTY: { retryable: true, message: '模型没有给出可以发送的回复' },
  FILTERED: { retryable: false, message: '模型按内容安全策略拒绝回答' },
  AUTH: { retryable: false, message: '模型服务鉴权失败，请检查 API key' },
  INSUFFICIENT_BALANCE: { retryable: false, message: '模型服务账户余额不足' },
  BAD_REQUEST: { retryable: false, message: '模型服务拒绝了请求参数' },
  BUDGET_EXCEEDED: { retryable: false, message: '今天的模型花费已达上限' },
  CONVERSATION_RATE_LIMITED: { retryable: false, message: '这个会话调用模型太频繁' },
};

export class ModelError extends Error {
  /**
   * @param {keyof MODEL_ERRORS} code
   * @param {object} [details]
   * @param {number} [details.httpStatus] 模型服务返回的 HTTP 状态码
   * @param {string} [details.providerCode] 模型服务返回的错误码（只保留短的安全标识）
   * @param {string} [details.traceId] 模型服务的请求追踪号（响应头 x-ds-trace-id），向 DeepSeek 反馈问题时用
   * @param {boolean} [details.notify] 会话限速：这是不是这段受限时间里的第一次拒绝（处理器据此决定要不要提示）
   * @param {number} [details.retryAfterMs] 会话限速：多久以后恢复
   */
  constructor(code, { httpStatus, providerCode, traceId, notify, retryAfterMs } = {}) {
    const spec = MODEL_ERRORS[code];
    if (!spec) throw new TypeError(`未知的模型错误码：${code}`);
    super(spec.message);
    this.name = 'ModelError';
    this.code = code;
    this.retryable = spec.retryable;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (providerCode !== undefined) this.providerCode = providerCode;
    if (traceId !== undefined) this.traceId = traceId;
    if (notify !== undefined) this.notify = notify;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}
