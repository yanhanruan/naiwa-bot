// 群里什么时候说话（Module 7，见 docs/module-07-group-chat-design.md；“留意”和“一轮”见 module-07b-burst-merge-design.md）。
// 这里只判断“这条消息要不要请模型看、算哪一种”，不调模型、不发消息。状态都在内存里，重启就没了。
//
// 判断结果（action）：
//   explicit  明确叫它：私聊、@ 奶蛙、引用奶蛙的消息。要回他
//   judge     请模型看，回不回由模型定：开头叫名字（name）、正在留意的人说话（follow_up）
//   wait      只 @ 不说话：处理器单独给这个人几秒补话（见 qq-handler.js）
//   ignore    不看：群友之间聊天、名字在句子中间、@全体、不理的 QQ 号、同一个人回得太多
// 这个人是不是在正在攒的“这一轮”里、是不是刚才只 @ 不说话，由处理器判断（它记着），不在这里。
//
// “留意”：有人叫了奶蛙（@、引用、只 @ 不说话、开头叫名字），或者奶蛙回了他，接下来 watchMs 内留意这个人，
// 他说的话哪怕没 @ 也请模型看一眼。模型看过他的话、决定不回他，马上不再留意（dismiss），直到他再叫奶蛙。

export const PARTICIPATION_DEFAULTS = {
  botNames: ['奶蛙'],
  watchMs: 30_000, // 留意多久（第一版试用值）
  personCapMax: 20, // 同一个群里，一段时间内最多回同一个人几条（防两个机器人互相叫醒、停不下来）
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
    this.watching = new Map(); // 群+人 -> { from: 从什么时候开始留意, until: 留意到什么时候 }
    this.replies = new Map(); // 群+人 -> 最近发给他的时间（升序）
    this.capWarned = new Map(); // 群+人 -> 上一次提醒“回得太多”的时间
  }

  isIgnored(personKey) {
    return this.ignored.has(personKey);
  }

  // 开头叫它：“奶蛙，…”“奶蛙 …”“奶蛙？”“奶蛙你…”，或者整条就是“奶蛙”。名字在句子中间不算。
  // 返回叫到的是哪个名字，没叫到返回 null。
  calledName(text) {
    const t = String(text ?? '').trim();
    return this.botNames.find((name) => t.startsWith(name) && AFTER_NAME.test(t.slice(name.length))) ?? null;
  }

  callsByName(text) {
    return this.calledName(text) !== null;
  }

  /**
   * 判断一条消息。只读状态，不改任何东西（“回得太多”的提醒除外：每段时间只提醒一次）。
   * @param {import('../message.js').InboundMessage} message
   * @param {{quotesSelf?: boolean}} [context] quotesSelf：这条消息引用了奶蛙发过的消息
   * @returns {{action: 'explicit'|'judge'|'wait'|'ignore', reason: string, notify?: boolean, name?: string}}
   *   name：叫到的名字
   */
  classify(message, { quotesSelf = false } = {}) {
    const person = message.sender.key;
    if (this.ignored.has(person)) return { action: 'ignore', reason: 'ignored_user' };
    if (message.conversation.kind === 'private') return { action: 'explicit', reason: 'private' };
    const key = keyOf(message.conversation.key, person);
    if (this._capped(key)) return { action: 'ignore', reason: 'person_cap', notify: this._shouldWarn(key) };
    if (message.mentionsSelf) {
      return isEmptyMention(message) ? { action: 'wait', reason: 'empty_mention' } : { action: 'explicit', reason: 'mention' };
    }
    if (quotesSelf) return { action: 'explicit', reason: 'quote' };
    const name = this.calledName(message.text);
    if (name !== null) return { action: 'judge', reason: 'name', name };
    if (this.isWatched(message.conversation.key, person)) return { action: 'judge', reason: 'follow_up' };
    return { action: 'ignore', reason: 'not_addressed' };
  }

  // 现在是不是在留意这个人。
  isWatched(conversationKey, personKey) {
    const watch = this.watching.get(keyOf(conversationKey, personKey));
    return watch !== undefined && this.now() <= watch.until;
  }

  // 这个人在群里叫了奶蛙（@、引用、只 @ 不说话、开头叫名字）：从现在起留意他。
  // 开头叫名字也算：奶蛙还在想“奶蛙，”的时候他补的“推荐个奶茶”才不会丢；模型看了觉得不是在叫它，马上就不留意了。
  noteCalled(conversationKey, personKey) {
    this._watch(keyOf(conversationKey, personKey));
    this._sweep();
  }

  /**
   * 奶蛙在群里给这个人发了一条（回复、“干嘛蛙”或固定提示）：计入次数上限。
   * @param {{reopen?: boolean}} [opts] reopen：发的是真正的回复，从现在起再留意他
   */
  noteSent(conversationKey, personKey, { reopen = true } = {}) {
    const key = keyOf(conversationKey, personKey);
    const now = this.now();
    const list = (this.replies.get(key) ?? []).filter((at) => now - at < this.options.personCapWindowMs);
    list.push(now);
    this.replies.set(key, list);
    if (reopen) this._watch(key);
    this._sweep();
  }

  /**
   * 模型看过他的话、决定不回他：马上不再留意，直到他再叫奶蛙。
   * @param {{lookedAt?: number}} [opts] lookedAt：这一轮开始看的时间。他在那之后又叫了奶蛙（留意是新续的），就不清掉。
   */
  dismiss(conversationKey, personKey, { lookedAt = Infinity } = {}) {
    const key = keyOf(conversationKey, personKey);
    const watch = this.watching.get(key);
    if (watch && watch.from <= lookedAt) this.watching.delete(key);
  }

  _watch(key) {
    const now = this.now();
    this.watching.set(key, { from: now, until: now + this.options.watchMs });
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
    if (this.watching.size + this.replies.size < 10_000) return;
    const now = this.now();
    for (const [key, watch] of this.watching) if (watch.until < now) this.watching.delete(key);
    for (const [key, list] of this.replies) {
      if (!list.some((at) => now - at < this.options.personCapWindowMs)) this.replies.delete(key);
    }
    for (const [key, at] of this.capWarned) if (now - at >= this.options.personCapWindowMs) this.capWarned.delete(key);
  }
}
