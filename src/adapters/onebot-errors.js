// OneBot 请求失败时统一抛出的错误。
// code 说明原因；delivery 说明消息（或其他动作）是否已经送达，供上层决定能不能重试：
//   not_sent — 肯定没发出：未连接、排队被丢弃、对方明确返回失败。可以重试。
//   unknown  — 请求已经发出但没等到结果：超时、等待期间断线、客户端停止。重试可能重复发送。
export const ONEBOT_ERROR_CODES = [
  'NOT_CONNECTED', // 发请求时没有可用连接
  'TIMEOUT', // 请求发出后在限定时间内没有响应
  'CONNECTION_LOST', // 等待响应期间连接断开
  'ACTION_FAILED', // OneBot 返回失败（retcode 非 0）
  'QUEUE_FULL', // 发送队列已满
  'QUEUE_TIMEOUT', // 排队时间超过上限，放弃发送
  'STOPPED', // 客户端已停止
];

export class OneBotError extends Error {
  constructor(code, message, { delivery = 'not_sent', action, retcode } = {}) {
    super(message);
    this.name = 'OneBotError';
    this.code = code;
    this.delivery = delivery;
    if (action !== undefined) this.action = action;
    if (retcode !== undefined) this.retcode = retcode;
  }
}
