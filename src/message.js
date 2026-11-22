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

/**
 * 进程内的代号簿：按首次出现顺序把用户 key 映射成 u1、u2…，重启后重新编号。
 * 模型只看到代号，看不到 QQ 号或内部 key，避免在回复里复述号码；真实 key 只留在程序内部。
 * 处理器从 Module 6 起改用全局、持久的代号（src/context/aliases.js）；这里保留给不连数据库的场合和测试。
 * @returns {(userKey: string) => string}
 */
export function createAliasBook() {
  const aliases = new Map();
  return (userKey) => {
    if (!aliases.has(userKey)) aliases.set(userKey, `u${aliases.size + 1}`);
    return aliases.get(userKey);
  };
}

// 模型只收到显示所需的字段。昵称和消息正文仍是用户输入，不授予任何权限。
// 会话信息每轮相同，放在系统提示里；同一会话内消息 ID 已唯一，不重复发送完整 key。
function segmentForModel(segment, message, aliasOf) {
  switch (segment.type) {
    case 'mention': {
      if (segment.target === 'all') return { type: 'mention', target: 'all' };
      if (segment.userId === message.account.id) return { type: 'mention', toYou: true };
      const mention = { type: 'mention', alias: aliasOf(segment.userKey) };
      return segment.name ? { ...mention, name: segment.name } : mention;
    }
    case 'reply':
      return { type: 'reply', messageId: segment.messageId };
    case 'opaque':
      return { type: 'uninterpreted', sourceType: segment.sourceType };
    default:
      return segment;
  }
}

/**
 * @param {InboundMessage} message
 * @param {(userKey: string) => string} aliasOf 本会话的代号簿，见 createAliasBook()
 */
export function messageForModel(message, aliasOf) {
  if (typeof aliasOf !== 'function') throw new TypeError('messageForModel: aliasOf is required');
  return JSON.stringify({
    sender: { alias: aliasOf(message.sender.key), name: message.sender.displayName },
    messageId: message.id,
    segments: message.segments.map((segment) => segmentForModel(segment, message, aliasOf)),
  });
}

/**
 * 原话表里存的信封是谁说的（代号）。不是信封、或者认不出来，返回 null。
 * @param {string} content messageForModel 的结果
 */
export function senderAliasOf(content) {
  try {
    const alias = JSON.parse(content)?.sender?.alias;
    return typeof alias === 'string' && /^u\d+$/.test(alias) ? alias : null;
  } catch {
    return null;
  }
}
