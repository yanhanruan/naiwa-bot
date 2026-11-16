/**
 * 入站消息契约 v1。结构化消息与旧 EventStore 的审计事件是不同对象。
 * @typedef {Object} InboundMessage
 * @property {1} schemaVersion
 * @property {string} platform
 * @property {'message.received'} kind
 * @property {string} id 平台原始消息 ID（字符串形式）
 * @property {string} key 会话范围内稳定、带命名空间的消息标识
 * @property {number} ts 平台事件时间，毫秒
 * @property {{id: string, key: string}} account 收到消息的机器人账号
 * @property {{id: string, key: string, nickname: ?string, card: ?string, displayName: ?string}} sender
 * @property {{kind: 'private'|'group', id: string, key: string, targetKey: string}} conversation
 * @property {Array<TextSegment|MentionSegment|ReplySegment|OpaqueSegment>} segments 有序消息段
 * @property {string} text 纯文本投影；不能代替 segments 判断 @ 或引用
 * @property {boolean} mentionsSelf 是否明确 @ 当前账号；@全体为 false
 * @property {{protocol: string, subType: ?string, targetId: string|number}} source 传输层元信息
 *
 * @typedef {{type: 'text', text: string}} TextSegment
 * @typedef {{type: 'mention', target: 'all'}|{type: 'mention', target: 'user', userId: string, userKey: string, name: ?string}} MentionSegment
 *   name 来自 @ 段自带的显示名，可能缺失或过期，只用于显示
 * @typedef {{type: 'reply', messageId: string, messageKey: string}} ReplySegment
 * @typedef {{type: 'opaque', sourceType: string, data: Object, invalid?: true}} OpaqueSegment
 *   invalid 表示已知类型（text/at/reply）的字段损坏，已降级保留原始数据
 */

// 模型只收到显示所需的字段。昵称和消息正文仍是用户输入，不授予任何权限。
// 会话标识每轮相同，放在系统提示里；同一会话内消息 ID 已唯一，不重复发送完整 key。
function segmentForModel(segment) {
  switch (segment.type) {
    case 'mention':
      if (segment.target === 'all') return { type: 'mention', target: 'all' };
      return segment.name
        ? { type: 'mention', userKey: segment.userKey, name: segment.name }
        : { type: 'mention', userKey: segment.userKey };
    case 'reply':
      return { type: 'reply', messageId: segment.messageId };
    case 'opaque':
      return { type: 'uninterpreted', sourceType: segment.sourceType };
    default:
      return segment;
  }
}

/** @param {InboundMessage} message */
export function messageForModel(message) {
  return JSON.stringify({
    sender: { key: message.sender.key, name: message.sender.displayName },
    messageId: message.id,
    segments: message.segments.map(segmentForModel),
  });
}
