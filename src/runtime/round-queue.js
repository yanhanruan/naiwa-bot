// 每个会话（一个群或一个私聊）的“一轮”（见 docs/module-07b-burst-merge-design.md 第 3 节）。
// - 有人叫了奶蛙、或者留意的人说话了，这个会话就开始攒一轮；这些人（这一轮的成员）接下来说的每句都算进来；
// - 成员都停了 quietMs 没再说，或者从这一轮第一句算起过了 maxWaitMs，或者攒到 maxMessages 句，就开始看；
//   别人的闲聊不进这一轮，也不拖长等待；
// - 一个会话同时只有一轮在看；看的时候来的新消息攒进下一轮，这一轮看完、下一轮也到点了才看；
// - 攒满 maxMessages 句、还没开始看时，再来的不收（和原来“排队满了”一样，由处理器记成 dropped）。
// 开始看由 ConversationQueue 安排：不同会话并行，同时在看的会话数有上限；同一会话里按先后来，
// “干嘛蛙”这种不调模型的固定回复也排在里面（见 qq-handler.js）。
// 这里只管攒和排，不碰消息内容：每句是处理器给的一个对象，带上 personKey 就行。
import { QueueError } from './conversation-queue.js';

// 2026-11-23 冒烟检查后从 3 秒 / 10 秒改成 7 秒 / 15 秒：真人一句一句打，隔 4 秒左右很常见，3 秒会把一段话拆成几轮。
export const ROUND_DEFAULTS = {
  quietMs: 7_000, // 这一轮的人停了多久没说话就开始看
  maxWaitMs: 15_000, // 从这一轮第一句算起最多等多久
  maxMessages: 5, // 这一轮最多攒几句；攒满就不等了
};

// 成员是怎么进这一轮的：明确叫它 > 开头叫名字 > 正在留意。同一个人取最强的。
const LEVELS = { follow_up: 1, name: 2, explicit: 3 };

export class RoundQueue {
  /**
   * @param {object} options
   * @param {import('./conversation-queue.js').ConversationQueue} options.queue 安排开始看
   * @param {(round: {id: number, conversationKey: string, items: object[], members: Map<string, object>}) => Promise<void>} options.run
   *   看这一轮（调模型、发送、记录）；自己处理所有错误，不要抛出
   * @param {(error: Error, round: object) => void} options.onRejected 排不进队列（排满了、正在退出）时，这一轮整个不处理
   * @param {(error: Error) => void} [options.onError] 看的时候出了意外错误（run 不该抛错，抛了就是代码问题）：只报告，不丢别的话
   * @param {() => number} [options.clock] 毫秒时间戳
   * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
   * 其余见 ROUND_DEFAULTS。
   */
  constructor({ queue, run, onRejected, onError = () => {}, clock = () => Date.now(), timers = { setTimeout, clearTimeout }, ...options }) {
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    this.options = { ...ROUND_DEFAULTS, ...given };
    this.queue = queue;
    this.run = run;
    this.onRejected = onRejected;
    this.onError = onError;
    this.clock = clock;
    this.timers = timers;
    this.states = new Map(); // 会话 key -> { collecting, submitted, timer }
    this.seq = 0;
  }

  /**
   * 这个人在不在正在攒的这一轮里（还没开始看的那一轮）。在的话返回他的成员信息，不在返回 null。
   * @returns {{level: string, reason: string, name?: string}|null}
   */
  memberOf(conversationKey, personKey) {
    return this.states.get(conversationKey)?.collecting?.members.get(personKey) ?? null;
  }

  /**
   * 把这个人的几句放进正在攒的这一轮（没有就开一轮）。要么都放进去，要么一句都不放（这一轮攒满了）。
   * @param {string} conversationKey
   * @param {string} personKey
   * @param {object[]} items 按先后
   * @param {{level?: 'explicit'|'name'|'follow_up'|null, reason?: string, name?: string}} [membership]
   *   这几句本身怎么来的；level 为空表示他已经是成员，这几句只是跟着进来
   * @returns {boolean} 放进去了没有
   */
  add(conversationKey, personKey, items, { level = null, reason, name } = {}) {
    let state = this.states.get(conversationKey);
    if (!state) {
      state = { collecting: null, submitted: false, timer: null };
      this.states.set(conversationKey, state);
    }
    const now = this.clock();
    let round = state.collecting;
    if (round && round.entries.length + items.length > this.options.maxMessages) return false;
    if (!round) {
      this.seq += 1;
      round = { id: this.seq, conversationKey, entries: [], members: new Map(), ready: false };
      state.collecting = round;
    }
    for (const item of items) round.entries.push({ at: now, personKey, item });
    const member = round.members.get(personKey);
    if (!member) {
      round.members.set(personKey, { level: level ?? 'follow_up', reason: reason ?? 'follow_up', ...(name ? { name } : {}) });
    } else if (level && LEVELS[level] > LEVELS[member.level]) {
      round.members.set(personKey, { level, reason, ...(name ? { name } : {}) });
    }
    // 又有人说话了：重新等他停下来（攒满了就不等了）。
    round.ready = false;
    if (round.entries.length >= this.options.maxMessages) this._markReady(conversationKey, state);
    else this._arm(conversationKey, state);
    return true;
  }

  /**
   * 不再留意这个人：他只是因为“正在留意”才进了正在攒的这一轮，就把他和他的话拿出来，返回拿出来的那几句。
   * 他在这一轮里明确叫过奶蛙、或者开头叫过名字的，留着。
   * @returns {object[]}
   */
  revoke(conversationKey, personKey) {
    const state = this.states.get(conversationKey);
    const round = state?.collecting;
    const member = round?.members.get(personKey);
    if (!member || member.level !== 'follow_up') return [];
    const removed = round.entries.filter((e) => e.personKey === personKey).map((e) => e.item);
    round.entries = round.entries.filter((e) => e.personKey !== personKey);
    round.members.delete(personKey);
    if (!round.entries.length) {
      state.collecting = null;
      this.timers.clearTimeout(state.timer);
      state.timer = null;
      this._forget(conversationKey, state);
    } else if (!round.ready) {
      this._arm(conversationKey, state); // 剩下的人可能早就停了
    }
    return removed;
  }

  // 正在攒的都马上开始看，不再等（退出前调用，之后再关掉 queue）。
  flush() {
    for (const [conversationKey, state] of this.states) if (state.collecting) this._markReady(conversationKey, state);
  }

  // 按成员最后一句和这一轮第一句的时间，定什么时候到点。
  _arm(conversationKey, state) {
    const round = state.collecting;
    this.timers.clearTimeout(state.timer);
    const first = round.entries[0].at;
    const last = round.entries.at(-1).at;
    const due = Math.min(last + this.options.quietMs, first + this.options.maxWaitMs);
    state.timer = this.timers.setTimeout(() => this._markReady(conversationKey, state), Math.max(0, due - this.clock()));
  }

  // 到点了：标成可以看，排进队列。到点以后又有人说话，add 会把它改回去、重新计时，所以不会卡住。
  _markReady(conversationKey, state) {
    this.timers.clearTimeout(state.timer);
    state.timer = null;
    if (!state.collecting) return;
    state.collecting.ready = true;
    if (state.submitted) return; // 已经排着了，轮到时会看到它
    state.submitted = true;
    this.queue.run(conversationKey, () => this._start(conversationKey, state)).catch((error) => {
      // 不是排队的错误：这一轮已经开始看了，是看的时候出的意外。只报告；这时候正在攒的是下一轮，不能丢。
      if (!(error instanceof QueueError)) {
        this.onError(error);
        return;
      }
      // 排不进队列：队列满了或正在退出。这一轮整个不处理。
      state.submitted = false;
      const round = state.collecting;
      state.collecting = null;
      this._forget(conversationKey, state);
      if (round) this.onRejected(error, this._sealed(round));
    });
  }

  // 轮到这个会话了：正在攒的那一轮要是到点了，就封起来开始看；没到点（刚才又有人说话），等它下次到点再排。
  async _start(conversationKey, state) {
    state.submitted = false;
    const round = state.collecting;
    if (!round) {
      this._forget(conversationKey, state);
      return;
    }
    if (!round.ready) return;
    state.collecting = null;
    this.timers.clearTimeout(state.timer);
    state.timer = null;
    // 看的时候来的新消息另开一个状态，攒成下一轮。
    this._forget(conversationKey, state);
    await this.run(this._sealed(round));
  }

  // 这个会话没有在攒、也没有排着的一轮了：不再记它，内存不会一直涨。
  _forget(conversationKey, state) {
    if (this.states.get(conversationKey) === state && !state.collecting && !state.submitted) this.states.delete(conversationKey);
  }

  _sealed(round) {
    return { id: round.id, conversationKey: round.conversationKey, items: round.entries.map((e) => e.item), members: round.members };
  }
}
