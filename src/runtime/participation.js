// 群里什么时候说话（Module 7，见 docs/module-07-group-chat-design.md 第 3、7 节）。
// 这里只判断“这条消息要不要处理、怎么处理”，不调模型、不发消息。状态都在内存里，重启就没了。
//
// 判断结果（action）：
//   reply   一定回：私聊、@ 奶蛙、引用奶蛙的消息
//   judge   交给模型判断回不回：接着说、开头叫它
//   wait    只 @ 不说话：处理器先等几秒，看这个人接着说什么（见 qq-handler.js）
//   ignore  不说话：群友之间聊天、名字在句子中间、@全体、不理的 QQ 号、同一个人回得太多
// “只 @ 不说话之后接着说的那句”由处理器判断（它记着谁在等），不在这里。

export const PARTICIPATION_DEFAULTS = {
  botNames: ['奶蛙'],
  followUpMs: 60_000, // “接着说”：叫过奶蛙或奶蛙回复他以后，多久内的下一条交给模型判断
  personCapMax: 20, // 同一个群里，一段时间内最多回同一个人几次（防两个机器人互相叫醒、停不下来）
  personCapWindowMs: 10 * 60_000,
};

// 名字后面紧跟这些，才算“开头叫它”：标点、空白、“你”，或者整条就是名字。
const AFTER_NAME = /^(?:$|[\s,，、:：!！?？~～.。…]|你)/;

const keyOf = (conversationKey, personKey) => `${conversationKey}\u001f${personKey}`;

/**
 * 只 @ 不说话：除了 @ 以外没有任何内容（没有字、没有图、没有引用）。
 * @param {import('../message.js').InboundMessage} message
 */
export function isEmptyMention(message) {
  return message.mentionsSelf && message.segments.every((s) =>
    s.type === 'mention' || (s.type === 'text' && !s.text.trim()));
}

export class Participation {
  /**
   * @param {object} [options]
   * @param {string[]} [options.botNames] 能叫它的名字
   * @param {string[]} [options.ignoreUsers] 不理的人（人的 key，例如 qq:user:101）
   * @param {() => number} [options.now] 毫秒时间戳，测试用
   * 其余见 PARTICIPATION_DEFAULTS。
   */
  constructor({ botNames, ignoreUsers = [], now = () => Date.now(), ...options } = {}) {
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    this.options = { ...PARTICIPATION_DEFAULTS, ...given };
    this.botNames = (botNames?.length ? botNames : PARTICIPATION_DEFAULTS.botNames).filter(Boolean);
    this.ignored = new Set(ignoreUsers);
    this.now = now;
    this.followUps = new Map(); // 群+人 -> “接着说”截止时间
    this.replies = new Map(); // 群+人 -> 最近回复他的时间（升序）
    this.capWarned = new Map(); // 群+人 -> 上一次提醒“回得太多”的时间
  }

  isIgnored(personKey) {
    return this.ignored.has(personKey);
  }

  // 开头叫它：“奶蛙，…”“奶蛙 …”“奶蛙？”“奶蛙你…”，或者整条就是“奶蛙”。名字在句子中间不算。
  callsByName(text) {
    const t = String(text ?? '').trim();
    return this.botNames.some((name) => t.startsWith(name) && AFTER_NAME.test(t.slice(name.length)));
  }

  /**
   * 判断一条消息。会消耗“接着说”：同一个人的下一条用掉以后就没了，奶蛙回复他才再给。
   * @param {import('../message.js').InboundMessage} message
   * @param {{quotesSelf?: boolean}} [context] quotesSelf：这条消息引用了奶蛙发过的消息
   * @returns {{action: 'reply'|'judge'|'wait'|'ignore', reason: string, notify?: boolean}}
   */
  classify(message, { quotesSelf = false } = {}) {
    const person = message.sender.key;
    if (this.ignored.has(person)) return { action: 'ignore', reason: 'ignored_user' };
    if (message.conversation.kind === 'private') return { action: 'reply', reason: 'private' };
    const key = keyOf(message.conversation.key, person);
    if (this._capped(key)) return { action: 'ignore', reason: 'person_cap', notify: this._shouldWarn(key) };
    if (message.mentionsSelf) {
      return isEmptyMention(message) ? { action: 'wait', reason: 'empty_mention' } : { action: 'reply', reason: 'mention' };
    }
    if (quotesSelf) return { action: 'reply', reason: 'quote' };
    if (this._takeFollowUp(key)) return { action: 'judge', reason: 'follow_up' };
    if (this.callsByName(message.text)) return { action: 'judge', reason: 'name' };
    return { action: 'ignore', reason: 'not_addressed' };
  }

  // 这个人在群里叫了奶蛙（@、引用、只 @ 不说话）：从现在起他的下一条算“接着说”。
  noteCalled(conversationKey, personKey) {
    this.followUps.set(keyOf(conversationKey, personKey), this.now() + this.options.followUpMs);
    this._sweep();
  }

  /**
   * 奶蛙在群里给这个人发了一条（回复、“干嘛蛙”或固定提示）：计入次数上限。
   * @param {{reopen?: boolean}} [opts] reopen：发的是真正的回复，他的下一条又算“接着说”
   */
  noteSent(conversationKey, personKey, { reopen = true } = {}) {
    const key = keyOf(conversationKey, personKey);
    const now = this.now();
    const list = (this.replies.get(key) ?? []).filter((at) => now - at < this.options.personCapWindowMs);
    list.push(now);
    this.replies.set(key, list);
    if (reopen) this.followUps.set(key, now + this.options.followUpMs);
    this._sweep();
  }

  _takeFollowUp(key) {
    const until = this.followUps.get(key);
    if (until === undefined) return false;
    this.followUps.delete(key);
    return this.now() <= until;
  }

  _capped(key) {
    const now = this.now();
    const recent = (this.replies.get(key) ?? []).filter((at) => now - at < this.options.personCapWindowMs);
    return recent.length >= this.options.personCapMax;
  }

  // 同一个人回得太多时，每段时间只提醒一次，免得日志也被刷屏。
  _shouldWarn(key) {
    const now = this.now();
    const last = this.capWarned.get(key);
    if (last !== undefined && now - last < this.options.personCapWindowMs) return false;
    this.capWarned.set(key, now);
    return true;
  }

  // 记录多了就清掉过期的，内存不会一直涨。
  _sweep() {
    if (this.followUps.size + this.replies.size < 10_000) return;
    const now = this.now();
    for (const [key, until] of this.followUps) if (until < now) this.followUps.delete(key);
    for (const [key, list] of this.replies) {
      if (!list.some((at) => now - at < this.options.personCapWindowMs)) this.replies.delete(key);
    }
    for (const [key, at] of this.capWarned) if (now - at >= this.options.personCapWindowMs) this.capWarned.delete(key);
  }
}
