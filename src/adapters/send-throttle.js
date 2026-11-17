import { OneBotError } from './onebot-errors.js';

// 发送节流：非官方 QQ 客户端发得太快、太密有被风控的风险，所以所有发送排成一队，按顺序逐条发：
// - 相邻两条至少间隔 minIntervalMs，再加 0～jitterMs 的随机间隔，避免机械的固定节奏；
// - 任意 windowMs 时间内最多发 maxPerWindow 条；
// - 队列最多 maxQueue 条，满了直接拒绝；预计要排队超过 maxWaitMs 的也直接拒绝。
//   聊天回复晚到一两分钟已经没有意义，不如明确失败，交给上层处理。
// 被拒绝的消息肯定没发出（delivery: not_sent）。
export const THROTTLE_DEFAULTS = {
  minIntervalMs: 1500,
  jitterMs: 1000,
  maxPerWindow: 20,
  windowMs: 60_000,
  maxQueue: 20,
  maxWaitMs: 60_000,
};

export class SendThrottle {
  constructor({ now = Date.now, random = Math.random, ...options } = {}) {
    this.options = { ...THROTTLE_DEFAULTS, ...options };
    this.now = now;
    this.random = random;
    this.queue = [];
    this.recent = []; // 窗口内每条发送的开始时间
    this.lastStartAt = -Infinity;
    this.nextGapMs = 0; // 下一条与上一条之间的间隔（含随机部分），每发一条重新抽一次
    this.running = false;
    this.stopped = false;
    this.timer = null;
    this.wake = null;
  }

  // 排队中（还没开始发送）的条数。
  get size() {
    return this.queue.length;
  }

  // 排队执行 task（真正发送的函数），返回它的结果。
  schedule(task) {
    if (this.stopped) {
      return Promise.reject(new OneBotError('STOPPED', '客户端已停止，未发送', { delivery: 'not_sent' }));
    }
    if (this.queue.length >= this.options.maxQueue) {
      return Promise.reject(new OneBotError('QUEUE_FULL', `发送队列已满（${this.options.maxQueue} 条），未发送`, { delivery: 'not_sent' }));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject, enqueuedAt: this.now() });
      void this._drain();
    });
  }

  // 停止：清空队列（全部以 STOPPED 拒绝），之后的 schedule 也直接拒绝。
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.wake?.();
    for (const item of this.queue.splice(0)) {
      item.reject(new OneBotError('STOPPED', '客户端已停止，未发送', { delivery: 'not_sent' }));
    }
  }

  _delayFrom(now) {
    const { windowMs, maxPerWindow } = this.options;
    while (this.recent.length && now - this.recent[0] >= windowMs) this.recent.shift();
    let readyAt = this.lastStartAt + this.nextGapMs;
    if (this.recent.length >= maxPerWindow) readyAt = Math.max(readyAt, this.recent[0] + windowMs);
    return Math.max(0, readyAt - now);
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, ms);
    });
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const now = this.now();
        const delay = this._delayFrom(now);
        const item = this.queue[0];
        // 预计等不到就提前放弃，而不是白等到超时。
        if (now + delay - item.enqueuedAt > this.options.maxWaitMs) {
          this.queue.shift();
          item.reject(new OneBotError('QUEUE_TIMEOUT', `排队将超过 ${this.options.maxWaitMs}ms，已放弃，未发送`, { delivery: 'not_sent' }));
          continue;
        }
        if (delay > 0) {
          await this._sleep(delay);
          continue; // 醒来后重新计算：期间可能已经停止
        }
        this.queue.shift();
        this.lastStartAt = now;
        this.recent.push(now);
        this.nextGapMs = this.options.minIntervalMs + this.random() * this.options.jitterMs;
        // 逐条发送：等这一条有了结果再发下一条，保证顺序。
        try {
          item.resolve(await item.task());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
