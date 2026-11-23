// 取被引用的那条消息（docs/image-understanding-design.md 4.2、6.4 节）。看图和“引用带原文”共用：
// - 奶蛙自己发的：发出时在内存里记下原文（最近 2000 条），被引用时直接用，不查 SnowLuma；
// - 其余（以及重启以后内存里没有的奶蛙的话）：用 SnowLuma 的 get_msg 查。get_msg 只按编号查、不带群号，
//   编号可能撞车，所以拿到以后先核对是不是当前这个聊天的，对不上的一律不用；
// - 查不到、超时、被取消、核对不过：只留消息编号，和以前一样。
// 这里只取消息，不排原文：原文要用代号写 @，由 src/message.js 排（见 quotedText）。
import { normalizeId, entityKey } from './identity.js';
import { normalizeSegments } from './adapters/onebot-message.js';

export const QUOTE_DEFAULTS = {
  keepSent: 2000, // 内存里记奶蛙最近发的几条原文（和处理器里认“哪些是奶蛙发的”的名单一样长）
};

const idOf = (value) => {
  try {
    return normalizeId(value);
  } catch {
    return null;
  }
};

/**
 * get_msg 取回的消息是不是当前这个聊天的（4.2 节）。字段缺失、对不上都算不是。
 * - 群聊：message_type 是 group，group_id 是当前群号；
 * - 私聊：message_type 是 private，并且是对方发的（user_id 是对方），或者是奶蛙发给他的（user_id 是奶蛙，target_id 是对方）。
 * 返回的编号和要查的不一样，也算不是。
 * @param {object} data get_msg 返回的 data
 * @param {import('./message.js').InboundMessage} message 引用它的那条消息
 * @param {string} requestedId 要查的消息编号
 */
export function belongsTo(data, message, requestedId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const kind = message.conversation.kind;
  if (data.message_type !== kind) return false;
  const returned = idOf(data.message_id ?? data.real_id);
  if (returned !== null && returned !== requestedId) return false;
  if (kind === 'group') return idOf(data.group_id) === message.conversation.id;
  const userId = idOf(data.user_id);
  if (userId === message.conversation.id) return true;
  return userId === message.account.id && idOf(data.target_id) === message.conversation.id;
}

// 等一个 Promise，外面取消了就不等了（原来的 Promise 照样跑完，结果丢掉）。
export function unlessAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => {});
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export class QuoteReader {
  constructor({ keepSent = QUOTE_DEFAULTS.keepSent } = {}) {
    this.keepSent = keepSent;
    this.sent = new Map(); // 奶蛙发出的消息 key -> 原文，按插入顺序淘汰
  }

  // 奶蛙发出了一条：记下原文。只在内存里，重启就没了。
  rememberSent(messageKey, text) {
    if (typeof messageKey !== 'string' || typeof text !== 'string') return;
    this.sent.delete(messageKey);
    this.sent.set(messageKey, text);
    while (this.sent.size > this.keepSent) this.sent.delete(this.sent.keys().next().value);
  }

  /**
   * 取被引用的那条。
   * @param {import('./message.js').InboundMessage} message 引用它的那条消息
   * @param {{messageId: string, messageKey: string}} reply 引用段
   * @param {object} opts
   * @param {object} [opts.client] OneBot 客户端（要有 call）；没有就只用内存里记的
   * @param {boolean} [opts.fromSelf] 处理器认出这条是奶蛙发的（重启前发的也认得）
   * @param {number} [opts.deadline] 最晚等到什么时候（Date.now() 的毫秒数）
   * @param {AbortSignal} [opts.signal] 看图共用的 20 秒到了就取消
   * @returns {Promise<{status: 'ok', fromSelf: boolean, authorKey?: string, text?: string, segments?: Array, source: 'memory'|'get_msg'}
   *   | {status: 'missing'|'mismatch'|'failed', fromSelf: boolean}>}
   *   ok 时：奶蛙自己的话从内存来，带 text；从 get_msg 来的带 segments（规范化后的消息段），由 src/message.js 排成原文
   */
  async read(message, reply, { client = null, fromSelf = false, deadline = Infinity, signal = null } = {}) {
    const remembered = this.sent.get(reply.messageKey);
    if (remembered !== undefined) return { status: 'ok', fromSelf: true, text: remembered, source: 'memory' };
    const failed = (status) => ({ status, fromSelf });
    if (typeof client?.call !== 'function') return failed('failed');
    const remainingMs = Math.min(deadline, Date.now() + 15_000) - Date.now();
    if (signal?.aborted || remainingMs <= 0) return failed('failed');
    let data;
    try {
      const messageId = /^-?\d+$/.test(reply.messageId) ? Number(reply.messageId) : reply.messageId;
      data = await unlessAborted(client.call('get_msg', { message_id: messageId }, { timeoutMs: remainingMs, key: message.key }), signal);
    } catch {
      return failed('failed'); // 查不到（SnowLuma 返回失败）、超时、断线、被取消
    }
    if (data == null) return failed('missing');
    if (!belongsTo(data, message, reply.messageId)) return failed('mismatch');
    let segments;
    try {
      segments = normalizeSegments(data.message, message.conversation.key);
    } catch {
      return failed('failed');
    }
    const userId = idOf(data.user_id);
    if (userId === null) return failed('mismatch'); // 不知道是谁说的：来源无法确认
    if (userId === message.account.id) return { status: 'ok', fromSelf: true, segments, source: 'get_msg' };
    return { status: 'ok', fromSelf: false, authorKey: entityKey('qq', 'user', userId), segments, source: 'get_msg' };
  }
}
