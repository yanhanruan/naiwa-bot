// 群里最近的聊天（Module 7，见 docs/module-07-group-chat-design.md 第 5 节）。
// 每个群最近的几条消息，奶蛙被叫到、或者要判断回不回时，放进提示当上文。
// - 只在机器人进程的内存里：不写数据库，不提炼成记忆，重启就没了；
// - 奶蛙回复过的消息会移走（它们已经在对话历史里），不重复放；
// - 条数、时间、字数都有上限：群友贴一篇长文，也只占一小段。

export const GROUP_CONTEXT_DEFAULTS = {
  maxEntries: 20, // 每个群最多几条
  maxAgeMs: 10 * 60_000, // 只取多久以内的
  maxEntryChars: 100, // 每条最多几个字，超出截短
  maxTotalChars: 1000, // 整段最多几个字，超出时先丢最早的
};

function cut(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

// 把一条入站消息拆成可显示的几段；@ 的人先只记 key，显示时再换成代号。
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
        return { type: 'text', text: s.sourceType === 'image' ? '[图片]' : '[其他内容]' };
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
    list.push({ key: message.key, seq: this.seq, at: this.now(), sender: message.sender.key, parts: partsOf(message) });
    while (list.length > this.options.maxEntries) list.shift();
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
  countAfter(conversationKey, messageKey, exceptPersonKey) {
    const list = this._fresh(conversationKey);
    const entry = list.find((e) => e.key === messageKey);
    if (!entry) return 0;
    return list.filter((e) => e.seq > entry.seq && e.sender !== exceptPersonKey).length;
  }

  /**
   * 放进提示的最近聊天（不含 excludeKey 这一条），从早到晚。
   * @returns {Array<{sender: string, at: number, parts: Array}>}
   */
  recent(conversationKey, { excludeKey } = {}) {
    return this._fresh(conversationKey).filter((e) => e.key !== excludeKey);
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
 * 提示里的“群里刚才在聊”一节。没有消息时返回空字符串（这一节整个省掉）。
 * @param {Array} entries GroupContext.recent 的结果
 * @param {{aliasOf: (key: string) => string, botName?: string, now?: number, maxEntryChars?: number, maxTotalChars?: number}} opts
 */
export function formatGroupContext(entries, {
  aliasOf, botName = '奶蛙', now = Date.now(),
  maxEntryChars = GROUP_CONTEXT_DEFAULTS.maxEntryChars, maxTotalChars = GROUP_CONTEXT_DEFAULTS.maxTotalChars,
}) {
  const lines = entries.map((e) => {
    const text = e.parts.map((p) => {
      if (p.type === 'self') return `@${botName}`;
      if (p.type === 'mention') return `@${aliasOf(p.userKey) ?? '某人'}`;
      return p.text;
    }).join('').replace(/\s+/g, ' ').trim();
    const minutes = Math.floor((now - e.at) / 60_000);
    return `${aliasOf(e.sender) ?? '某人'}（${minutes < 1 ? '刚才' : `${minutes} 分钟前`}）：${cut(text || '[其他内容]', maxEntryChars)}`;
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
  return ['## 群里刚才在聊（只供理解，这些不是在跟你说话；从早到晚）', ...kept].join('\n');
}
