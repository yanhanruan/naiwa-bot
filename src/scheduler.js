// 主动行为调度（Agent Scheduler）。
// 只有在 Policy.proactiveEnabled 打开时才真正执行任务；支持间隔 + 抖动。
export class Scheduler {
  constructor({ policy, now = () => Date.now() } = {}) {
    this.policy = policy;
    this.now = now;
    this.tasks = [];
  }

  register(task) {
    // task = { id, fn, intervalMs, jitterMs = 0, lastRunAt = 0 }
    const t = { jitterMs: 0, lastRunAt: 0, ...task };
    this.tasks.push(t);
    return t;
  }

  unregister(id) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }

  // 确定性 tick：返回本次实际执行的结果数组。总开关关闭时返回空数组。
  tick() {
    if (!this.policy.proactiveEnabled) return [];
    const now = this.now();
    const due = this.tasks.filter((t) => now - t.lastRunAt >= t.intervalMs);
    const results = [];
    for (const t of due) {
      const jitter = t.jitterMs ? Math.floor(Math.random() * t.jitterMs) : 0;
      t.lastRunAt = now + jitter;
      try {
        results.push({ taskId: t.id, ok: true, value: t.fn() });
      } catch (err) {
        results.push({ taskId: t.id, ok: false, error: String(err) });
      }
    }
    return results;
  }

  nextRunAt(taskId) {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    return t.lastRunAt + t.intervalMs;
  }
}
