// 按会话限速：每个会话（一个群或一个私聊）在滑动时间窗口内最多调用模型若干次。
// - 超过时拒绝。同一段受限时间里，只有第一次拒绝带 notify: true（处理器据此发一次提示），之后静默。
// - 被拒绝的请求不计数，所以窗口过了就自动恢复，不会因为一直有人刷而越限越久。
// - 只在进程内记录，重启后清零。这是防刷屏用的；防花费失控靠持久化的每日花费上限。
export class ConversationRateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.perMinute] 每分钟最多几次；0 表示不限
   * @param {number} [options.perHour] 每小时最多几次；0 表示不限
   * @param {() => number} [options.now] 当前时间（毫秒），测试用
   * @param {number} [options.maxConversations] 最多跟踪多少个会话，超出时丢掉最久没活动的
   */
  constructor({ perMinute = 10, perHour = 120, now = () => Date.now(), maxConversations = 10_000 } = {}) {
    this.windows = [
      { name: 'minute', ms: 60_000, limit: perMinute },
      { name: 'hour', ms: 3_600_000, limit: perHour },
    ].filter((w) => Number.isFinite(w.limit) && w.limit > 0);
    this.longestMs = Math.max(0, ...this.windows.map((w) => w.ms));
    this.now = now;
    this.maxConversations = maxConversations;
    this.state = new Map(); // conversationKey -> { calls: 时间戳（升序）, notifiedUntil }；按最近活动排序
  }

  /**
   * 申请一次调用。允许时记一次并返回 { allowed: true }；
   * 否则返回 { allowed: false, window: 'minute' | 'hour', retryAfterMs, notify }。
   */
  take(conversationKey) {
    if (!this.windows.length) return { allowed: true };
    const now = this.now();
    const s = this.state.get(conversationKey) ?? { calls: [], notifiedUntil: 0 };
    this.state.delete(conversationKey); // 重新插入，让 Map 的顺序代表最近活动
    this.state.set(conversationKey, s);
    if (this.state.size > this.maxConversations) this.state.delete(this.state.keys().next().value);

    while (s.calls.length && now - s.calls[0] >= this.longestMs) s.calls.shift();
    for (const w of this.windows) {
      const inWindow = s.calls.filter((t) => now - t < w.ms);
      if (inWindow.length >= w.limit) {
        // 窗口里最早的那几次移出窗口后才能再调用
        const retryAfterMs = inWindow[inWindow.length - w.limit] + w.ms - now;
        const notify = now >= s.notifiedUntil;
        if (notify) s.notifiedUntil = now + retryAfterMs;
        return { allowed: false, window: w.name, retryAfterMs, notify };
      }
    }
    s.calls.push(now);
    return { allowed: true };
  }
}
