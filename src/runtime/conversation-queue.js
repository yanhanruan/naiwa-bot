// 会话队列：同一会话（一个群或一个私聊）的消息按到达顺序逐条处理，前一条处理完才开始下一条；
// 不同会话之间并行，但同时在处理的会话数有上限。
// - 逐条处理保证“后一条看得到前一条的对话”：前一条的回复发出、写进历史之后，后一条才开始读历史。
// - 每个会话排队的条数有上限（不含正在处理的那条），满了直接拒绝新消息，免得有人刷屏时越排越长。
// - 多个会话都在等空位时轮流来：一个会话处理完一条、还有下一条，就排到其他在等的会话后面。

export class QueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QueueError';
    this.code = code; // QUEUE_FULL | CLOSED
  }
}

export class ConversationQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.maxConcurrent] 同时处理的会话数上限
   * @param {number} [options.maxPending] 每个会话最多排队几条（不含正在处理的）
   */
  constructor({ maxConcurrent = 4, maxPending = 5 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxPending = maxPending;
    this.conversations = new Map(); // key -> { items, running, waiting }；没有任务的会话会被删掉
    this.ready = []; // 有任务、在等空位的会话 key，先来先得
    this.active = 0;
    this.closed = false;
    this.idleWaiters = new Set();
  }

  // 正在处理的加上排队中的条数。
  get size() {
    let n = this.active;
    for (const c of this.conversations.values()) n += c.items.length;
    return n;
  }

  /**
   * 把任务排进某个会话的队列。返回的 Promise 在任务完成时给出它的结果（或错误）；
   * 队列已满或已关闭时以 QueueError 拒绝，任务不会执行。
   */
  run(key, task) {
    if (this.closed) return Promise.reject(new QueueError('CLOSED', '正在退出，不再接收新消息'));
    let c = this.conversations.get(key);
    if (!c) {
      c = { items: [], running: false, waiting: false };
      this.conversations.set(key, c);
    }
    if (c.items.length >= this.maxPending) {
      return Promise.reject(new QueueError('QUEUE_FULL', `这个会话已有 ${c.items.length} 条在排队`));
    }
    return new Promise((resolve, reject) => {
      c.items.push({ task, resolve, reject });
      this._markReady(key, c);
      this._pump();
    });
  }

  // 停止接收新任务，等已经接收的全部处理完；最多等 timeoutMs。返回还没处理完的条数（0 表示都处理完了）。
  async close(timeoutMs = 10_000) {
    this.closed = true;
    if (this.size === 0) return 0;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.idleWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.idleWaiters.add(done);
    });
    return this.size;
  }

  _markReady(key, c) {
    if (c.running || c.waiting || !c.items.length) return;
    c.waiting = true;
    this.ready.push(key);
  }

  _pump() {
    while (this.active < this.maxConcurrent && this.ready.length) {
      const key = this.ready.shift();
      const c = this.conversations.get(key);
      c.waiting = false;
      this._start(key, c);
    }
  }

  _start(key, c) {
    const item = c.items.shift();
    c.running = true;
    this.active += 1;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        c.running = false;
        this.active -= 1;
        if (c.items.length) this._markReady(key, c);
        else this.conversations.delete(key);
        this._pump();
        if (this.active === 0 && !this.ready.length) for (const done of [...this.idleWaiters]) done();
      });
  }
}
