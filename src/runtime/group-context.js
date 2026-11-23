// 群里最近的聊天（Module 7，见 docs/module-07-group-chat-design.md 第 5 节）。
// 每个群最近的几条消息，奶蛙被叫到、或者要判断回不回时，放进提示当上文：
// 放在最后一条用户消息里、这一轮的几句前面，紧挨着这一轮（docs/naiwa-smartness-research.md 第四节③）。
// - 只在机器人进程的内存里：不写数据库，不提炼成记忆，重启就没了；
// - 奶蛙回复过的消息会移走（它们已经在对话历史里），不重复放；
// - 条数、时间、字数都有上限：群友贴一篇长文，也只占一小段；内存里多留一些（keepEntries），放进提示的仍最多 maxEntries 条；
// - 还用来判断回复时要不要引用原消息（countAfter）。keepText 为 false 时只记谁在什么时候说了话，
//   不记内容，也不放进提示（GROUP_CONTEXT=off），引用照常判断。

import { faceLabel, contentLabel } from '../message.js';

export const GROUP_CONTEXT_DEFAULTS = {
  maxEntries: 20, // 放进提示最多几条
  // 每个群在内存里最多留几条。比放进提示的多：等人说完要 7～15 秒，热闹的群里这一轮的话不至于在开始看之前就被挤出去
  // （被挤出去的话，“群里刚才在聊”整段就没了）。
  keepEntries: 60,
  maxAgeMs: 10 * 60_000, // 只取多久以内的
  maxEntryChars: 100, // 每条最多几个字，超出截短
  maxTotalChars: 1000, // 整段最多几个字，超出时先丢最早的
  keepText: true, // false：不记内容、不放进提示，只用来判断要不要引用
};

// “群里刚才在聊”这一段的标题。以前写的是“只供理解，这些不是在跟你说话”，模型就不把这一轮和前面的话连起来看。
export const NEARBY_TITLE = '[群里刚才在聊（从早到晚；这些话不一定是跟你说的，但这一轮的话常常是接着这里说的）]';

function cut(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

// 把一条入站消息拆成可显示的几段；@ 的人先只记 key，显示时再换成代号。
// 图片另外记下消息段里的地址、文件名、说明（不下载），给“叫奶蛙之前自己发的图”用（看懂图片设计稿第 3 节）。
function partsOf(message) {
  return message.segments.map((s) => {
    switch (s.type) {
      case 'text':
        return { type: 'text', text: s.text };
      case 'mention':
        if (s.target === 'all') return { type: 'text', text: '@全体成员' };
        if (s.userId === message.account.id) return { type: 'self' };
        return { type: 'mention', userKey: s.userKey };
      case 'reply':
        return { type: 'text', text: '[引用了一条消息]' };
      case 'opaque':
        if (s.sourceType === 'image') return { type: 'text', text: '[图片]', image: s.invalid ? null : s.data };
        if (s.sourceType === 'face') return { type: 'text', text: faceLabel(s) };
        return { type: 'text', text: contentLabel(s.sourceType) }; // [聊天记录]、[视频]……认不出的是[其他内容]
      default:
        return { type: 'text', text: '[其他内容]' };
    }
  });
}

export class GroupContext {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] 毫秒时间戳，测试用
   * 其余见 GROUP_CONTEXT_DEFAULTS。
   */
  constructor({ now = () => Date.now(), ...options } = {}) {
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    this.options = { ...GROUP_CONTEXT_DEFAULTS, ...given };
    this.options.keepEntries = Math.max(this.options.keepEntries, this.options.maxEntries);
    this.now = now;
    this.groups = new Map(); // 会话 key -> [{ key, seq, at, sender, parts }]，从早到晚
    this.seq = 0;
  }

  // 记下一条群消息。同一条消息收到两次只记一次。
  add(message) {
    const conversationKey = message.conversation.key;
    const list = this._fresh(conversationKey);
    if (list.some((e) => e.key === message.key)) return;
    this.seq += 1;
    const parts = this.options.keepText ? partsOf(message) : [];
    list.push({ key: message.key, seq: this.seq, at: this.now(), sender: message.sender.key, parts });
    while (list.length > this.options.keepEntries) list.shift();
    this.groups.set(conversationKey, list);
  }

  // 奶蛙回复过的消息已经在对话历史里，从这里移走。
  remove(conversationKey, messageKey) {
    const list = this.groups.get(conversationKey);
    if (!list) return;
    const kept = list.filter((e) => e.key !== messageKey);
    if (kept.length) this.groups.set(conversationKey, kept);
    else this.groups.delete(conversationKey);
  }

  // 某条消息之后，别人（不算这条消息的发言者）又说了几条。用来决定回复时要不要引用原消息。
  // 这条已经找不到了：被后来的消息挤出去（超过条数上限）或者已经过了时间，说明群里又说了很多，返回 Infinity。
  // （处理中的群消息收到时都记过，所以找不到只可能是这两种情况。）
  countAfter(conversationKey, messageKey, exceptPersonKey) {
    const list = this._fresh(conversationKey);
    const entry = list.find((e) => e.key === messageKey);
    if (!entry) return Infinity;
    return list.filter((e) => e.seq > entry.seq && e.sender !== exceptPersonKey).length;
  }

  /**
   * 放进提示的最近聊天：只取 beforeKey 这条消息之前的，从早到晚，最多 maxEntries 条。它之后才到的不算“刚才在聊”，
   * 放进来会让模型以为这些话在它前面。beforeKey 这条已经被挤出去时，剩下的都比它晚，返回空。
   * 一轮里有好几句时，beforeKey 是这一轮最后一句，exclude 是这一轮自己的几句（另外交给模型，不重复放）。
   * @param {string} conversationKey
   * @param {{beforeKey?: string, exclude?: Iterable<string>}} [opts]
   * @returns {Array<{key: string, sender: string, at: number, parts: Array}>}
   */
  recent(conversationKey, { beforeKey, exclude = [] } = {}) {
    const list = this._fresh(conversationKey);
    const skip = new Set(exclude);
    const index = beforeKey === undefined ? list.length : list.findIndex((e) => e.key === beforeKey);
    if (index === -1) return [];
    return list.slice(0, index).filter((e) => !skip.has(e.key)).slice(-this.options.maxEntries);
  }

  /**
   * 某人在 beforeKey 这句之前 withinMs 内自己在这个群发的图（消息段里的 data：地址、文件名、说明），最近的在前。
   * 给“叫奶蛙之前 1 分钟内自己发的图”用；exclude 是这一轮自己的几句（另外看，不重复）。beforeKey 这句找不到时返回空。
   */
  imagesBefore(conversationKey, { personKey, beforeKey, withinMs, exclude = [] }) {
    const list = this._fresh(conversationKey);
    const anchor = list.find((e) => e.key === beforeKey);
    if (!anchor) return [];
    const skip = new Set(exclude);
    const refs = [];
    for (const e of list) {
      if (e.seq >= anchor.seq || e.sender !== personKey || skip.has(e.key) || anchor.at - e.at > withinMs) continue;
      for (const p of e.parts) if (p.image) refs.push(p.image);
    }
    return refs.reverse();
  }

  _fresh(conversationKey) {
    const now = this.now();
    const list = (this.groups.get(conversationKey) ?? []).filter((e) => now - e.at <= this.options.maxAgeMs);
    if (list.length) this.groups.set(conversationKey, list);
    else this.groups.delete(conversationKey);
    return list;
  }
}

// 这些消息里出现的人：说话的人和被 @ 的人（显示时要用代号）。
export function peopleIn(entries) {
  const keys = new Set();
  for (const e of entries) {
    keys.add(e.sender);
    for (const p of e.parts) if (p.type === 'mention') keys.add(p.userKey);
  }
  return [...keys];
}

/**
 * “群里刚才在聊”这一段，放在最后一条用户消息开头、这一轮的几句前面。没有消息时返回空字符串（这一段整个省掉）。
 * 还没有代号的人（只在旁边说话、没找过奶蛙）在这一段里临时叫 x1、x2，不为他们分配永久代号。
 * @param {Array} entries GroupContext.recent 的结果
 * @param {{aliasOf: (key: string) => string|undefined, botName?: string, now?: number, maxEntryChars?: number, maxTotalChars?: number}} opts
 */
export function formatGroupContext(entries, {
  aliasOf, botName = '奶蛙', now = Date.now(),
  maxEntryChars = GROUP_CONTEXT_DEFAULTS.maxEntryChars, maxTotalChars = GROUP_CONTEXT_DEFAULTS.maxTotalChars,
}) {
  const temp = new Map();
  const nameOf = (key) => {
    const alias = aliasOf(key);
    if (alias) return alias;
    if (!temp.has(key)) temp.set(key, `x${temp.size + 1}`);
    return temp.get(key);
  };
  const lines = entries.map((e) => {
    const text = e.parts.map((p) => {
      if (p.type === 'self') return `@${botName}`;
      if (p.type === 'mention') return `@${nameOf(p.userKey)}`;
      return p.text;
    }).join('').replace(/\s+/g, ' ').trim();
    const minutes = Math.floor((now - e.at) / 60_000);
    return `${nameOf(e.sender)}（${minutes < 1 ? '刚才' : `${minutes} 分钟前`}）：${cut(text || '[其他内容]', maxEntryChars)}`;
  });
  // 整段超过字数上限时，先丢最早的。
  const kept = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const length = [...lines[i]].length;
    if (total + length > maxTotalChars) break;
    kept.unshift(lines[i]);
    total += length;
  }
  if (!kept.length) return '';
  const header = [NEARBY_TITLE];
  if (temp.size) header.push('（x1、x2 这样的是还没有代号的人，只在这一段里用）');
  return [...header, ...kept].join('\n');
}
