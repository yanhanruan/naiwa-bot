import { faceName } from './qq-faces.js';

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

export const QUOTE_MAX_CHARS = 200; // 引用原文最多几个字（看懂图片设计稿 6.4 节）

function cut(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

// 打不开的内容按种类写，模型才知道那是什么、能直说打不开；认不出种类的写“[其他内容]”（设计稿 6.4 节）。
const CONTENT_LABELS = {
  forward: '[聊天记录]', video: '[视频]', record: '[语音]', file: '[文件]',
  json: '[卡片]', xml: '[卡片]', share: '[链接]', music: '[音乐]', location: '[位置]', contact: '[名片]', poke: '[戳一戳]',
};
export function contentLabel(sourceType) {
  return Object.hasOwn(CONTENT_LABELS, sourceType) ? CONTENT_LABELS[sourceType] : '[其他内容]';
}

// QQ 自带的小表情（小黄脸）显示成“[QQ表情：流泪]”，表里没有的显示“[QQ表情]”（设计稿 6.3 节）。
export function faceLabel(segment) {
  const name = faceName(segment?.data?.id);
  return name ? `[QQ表情：${name}]` : '[QQ表情]';
}

/**
 * 被引用那条消息的原文（设计稿 6.4 节）：@ 写代号，图写“[图片]”，小黄脸写名字，引用里再套的引用写“[引用了一条消息]”，
 * 合并转发、视频、语音、文件这些打不开的按种类写（见 contentLabel）；最多 QUOTE_MAX_CHARS 个字。
 * @param {Array} segments 规范化后的消息段（见 adapters/onebot-message.js）
 * @param {{aliasOf: (userKey: string) => string|undefined, accountId: string}} opts
 */
export function quotedText(segments, { aliasOf, accountId }) {
  const text = segments.map((s) => {
    switch (s.type) {
      case 'text':
        return s.text;
      case 'mention':
        if (s.target === 'all') return '@全体成员';
        if (s.userId === accountId) return '@你';
        return `@${aliasOf(s.userKey) ?? '某人'}`;
      case 'reply':
        return '[引用了一条消息]';
      case 'opaque':
        if (s.sourceType === 'image') return '[图片]';
        if (s.sourceType === 'face') return faceLabel(s);
        return contentLabel(s.sourceType);
      default:
        return '[其他内容]';
    }
  }).join('').replace(/\s+/g, ' ').trim();
  return cut(text, QUOTE_MAX_CHARS);
}

// 引用段：查到被引用的那条时，带上谁说的、原文、看过的图（设计稿 6.1、6.4 节）。
function replyForModel(segment, message, aliasOf, quote) {
  const out = { type: 'reply', messageId: segment.messageId };
  if (!quote) return out;
  if (quote.fromSelf) out.fromYou = true;
  if (quote.status !== 'ok') return out;
  if (!quote.fromSelf) out.from = aliasOf(quote.authorKey) ?? '某人';
  const text = quote.text !== undefined
    ? cut(String(quote.text).replace(/\s+/g, ' ').trim(), QUOTE_MAX_CHARS)
    : quotedText(quote.segments ?? [], { aliasOf, accountId: message.account.id });
  if (text) out.text = text;
  if (quote.images?.length) out.images = quote.images;
  return out;
}

// 模型只收到显示所需的字段。昵称和消息正文仍是用户输入，不授予任何权限。
// 会话信息每轮相同，放在系统提示里；同一会话内消息 ID 已唯一，不重复发送完整 key。
function segmentForModel(segment, index, message, aliasOf, extra) {
  switch (segment.type) {
    case 'mention': {
      if (segment.target === 'all') return { type: 'mention', target: 'all' };
      if (segment.userId === message.account.id) return { type: 'mention', toYou: true };
      const mention = { type: 'mention', alias: aliasOf(segment.userKey) };
      return segment.name ? { ...mention, name: segment.name } : mention;
    }
    case 'reply':
      return replyForModel(segment, message, aliasOf, extra?.quote);
    case 'opaque': {
      // 看过的图写成描述；小黄脸查表写名字；其余（没看、没看成的图，语音、视频……）仍是“未解析”。
      const description = segment.sourceType === 'image' ? extra?.images?.get(index) : undefined;
      if (description) return { type: 'image', description };
      if (segment.sourceType === 'face' && !segment.invalid) {
        const name = faceName(segment.data?.id);
        return name ? { type: 'face', name } : { type: 'face' };
      }
      return { type: 'uninterpreted', sourceType: segment.sourceType };
    }
    default:
      return segment;
  }
}

/**
 * @param {InboundMessage} message
 * @param {(userKey: string) => string} aliasOf 本会话的代号簿，见 createAliasBook()
 * @param {{images?: Map<number, string>, quote?: object|null, recentImages?: string[]}} [extra]
 *   查引用、看图的结果（见 src/images/look.js）：第几段的图的描述、引用的那条、叫奶蛙之前自己发的图的描述
 */
export function messageForModel(message, aliasOf, extra = null) {
  if (typeof aliasOf !== 'function') throw new TypeError('messageForModel: aliasOf is required');
  const envelope = {
    sender: { alias: aliasOf(message.sender.key), name: message.sender.displayName },
    messageId: message.id,
    segments: message.segments.map((segment, index) => segmentForModel(segment, index, message, aliasOf, extra)),
  };
  if (extra?.recentImages?.length) envelope.recentImages = extra.recentImages;
  return JSON.stringify(envelope);
}

/**
 * 引用里要用代号的人：被引用那条的作者和那条里 @ 的人（见 src/images/look.js 的结果）。
 * @param {Iterable<{quote?: object|null}>} extras
 */
export function peopleInQuotes(extras) {
  const keys = new Set();
  for (const extra of extras) {
    const quote = extra?.quote;
    if (quote?.status !== 'ok') continue;
    if (quote.authorKey) keys.add(quote.authorKey);
    for (const s of quote.segments ?? []) if (s.type === 'mention' && s.target === 'user') keys.add(s.userKey);
  }
  return [...keys];
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
