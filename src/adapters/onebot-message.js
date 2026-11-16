import { normalizeId, entityKey, conversationKey, messageKey } from '../identity.js';

const label = (value) => typeof value === 'string' && value.trim() ? value : null;

function decodeCQ(value, parameter = false) {
  // &amp; 最后解码，避免把用户输入的字面量 &amp;#91; 二次解释。
  let decoded = value.replace(/&#91;/g, '[').replace(/&#93;/g, ']');
  if (parameter) decoded = decoded.replace(/&#44;/g, ',');
  return decoded.replace(/&amp;/g, '&');
}

function parseCQ(input) {
  const segments = [];
  const text = (value) => { if (value) segments.push({ type: 'text', data: { text: decodeCQ(value) } }); };
  let offset = 0;
  // 先拆分 CQ 码，再解码文本；转义后的字面量 [CQ:...] 不能变成真实 @。
  for (const match of input.matchAll(/\[CQ:([a-zA-Z0-9_-]+)((?:,[^\[\]]*)?)\]/g)) {
    text(input.slice(offset, match.index));
    const pairs = match[2] ? match[2].slice(1).split(',') : [];
    if (pairs.some((pair) => pair.indexOf('=') <= 0)) {
      text(match[0]);
    } else {
      const data = Object.fromEntries(pairs.map((pair) => {
        const index = pair.indexOf('=');
        return [pair.slice(0, index), decodeCQ(pair.slice(index + 1), true)];
      }));
      segments.push({ type: match[1], data });
    }
    offset = match.index + match[0].length;
  }
  text(input.slice(offset));
  return segments;
}

function knownSegment(type, data, conversation) {
  switch (type) {
    case 'text':
      if (typeof data.text !== 'string') throw new TypeError('text segment: missing text');
      return { type: 'text', text: data.text };
    case 'at': {
      if (data.qq === 'all') return { type: 'mention', target: 'all' };
      const userId = normalizeId(data.qq, 'at.qq');
      // name 是发送方客户端给出的显示名，可能过期，仅供显示。
      return { type: 'mention', target: 'user', userId, userKey: entityKey('qq', 'user', userId), name: label(data.name) };
    }
    case 'reply': {
      const id = normalizeId(data.id, 'reply.id');
      return { type: 'reply', messageId: id, messageKey: messageKey(conversation, id) };
    }
    default:
      // 图片/语音/扩展段保留，不把链接或 CQ 码冒充已理解的文本。
      return { type: 'opaque', sourceType: type, data: structuredClone(data) };
  }
}

function normalizeSegments(message, conversation) {
  const input = typeof message === 'string' ? parseCQ(message) : message;
  if (!Array.isArray(input)) throw new TypeError('message: expected an array or CQ string');
  return input.map((segment) => {
    if (!segment || typeof segment.type !== 'string' || !segment.type ||
        (segment.data != null && (typeof segment.data !== 'object' || Array.isArray(segment.data)))) {
      throw new TypeError('message: invalid segment');
    }
    const data = segment.data ?? {};
    try {
      return knownSegment(segment.type, data, conversation);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      // 已知段字段损坏时只降级这一段，不丢弃整条消息的正文；路由身份损坏仍在外层抛错。
      return { type: 'opaque', sourceType: segment.type, data: structuredClone(data), invalid: true };
    }
  });
}

/**
 * OneBot -> 入站消息 v1。纯函数，不连网络、不读写存储。
 * 非消息/不支持的消息/机器人自己的消息返回 null；路由身份或时间损坏则抛出 TypeError，由入口记录并跳过；
 * 单个已知消息段（text/at/reply）字段损坏只降级为 invalid opaque 段。
 * 匿名和系统提示暂不处理，避免把占位 user_id 当成真实用户关系。
 * @returns {import('../message.js').InboundMessage | null}
 */
export function normalizeOneBotMessage(event) {
  if (event?.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return null;
  if (event.message_type === 'group' &&
      (event.anonymous != null || (event.sub_type != null && event.sub_type !== 'normal'))) return null;

  const accountId = normalizeId(event.self_id, 'self_id');
  const userId = normalizeId(event.user_id, 'user_id');
  // 部分实现会把机器人自己发出的消息也按普通消息上报；不处理，避免自问自答循环和把自己记成关系对象。
  if (userId === accountId) return null;
  const id = normalizeId(event.message_id, 'message_id');
  const kind = event.message_type;
  const targetId = kind === 'group' ? normalizeId(event.group_id, 'group_id') : userId;
  const conversation = {
    kind, id: targetId,
    key: conversationKey('qq', accountId, kind, targetId),
    targetKey: entityKey('qq', kind === 'group' ? 'group' : 'user', targetId),
  };
  if (!Number.isSafeInteger(event.time) || event.time < 0 || !Number.isSafeInteger(event.time * 1000)) {
    throw new TypeError('time: expected an epoch timestamp in seconds');
  }
  const nickname = label(event.sender?.nickname);
  const card = kind === 'group' ? label(event.sender?.card) : null;
  const segments = normalizeSegments(event.message, conversation.key);
  return {
    schemaVersion: 1,
    platform: 'qq', kind: 'message.received', id,
    key: messageKey(conversation.key, id),
    ts: event.time * 1000,
    account: { id: accountId, key: entityKey('qq', 'account', accountId) },
    sender: { id: userId, key: entityKey('qq', 'user', userId), nickname, card, displayName: card ?? nickname },
    conversation,
    segments,
    text: segments.filter((s) => s.type === 'text').map((s) => s.text).join(''),
    mentionsSelf: segments.some((s) => s.type === 'mention' && s.target === 'user' && s.userId === accountId),
    // 发送时保留协议原始参数类型；内部标识一律使用规范化后的字符串。
    source: { protocol: 'onebot-v11', subType: label(event.sub_type),
      targetId: kind === 'group' ? event.group_id : event.user_id },
  };
}
