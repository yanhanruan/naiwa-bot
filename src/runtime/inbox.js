// 入站消息记录：每条要处理（叫到了奶蛙）的消息记一行，用来
// 1. 去重：同一条消息（message key）在去重窗口内（默认 24 小时）第二次出现，直接跳过，不会重复回复；
// 2. 如实记录结果：回复了、只发了提示、没发出去（以及是否可能已经发出）、被丢弃、因退出或重启中断……
//    发送失败不会被记成“已回复”。
// 只存标识和结果，不存聊天内容。
//
// 状态：queued（排队中）→ processing（处理中）→ 结束状态之一：
//   replied     发出了模型的回复
//   notice      发出了固定提示（模型失败、花费上限、会话限速、内容过滤）
//   silent      按规则不回复（同一段限速时间里的第二次及以后）
//   send_failed 没发出去；delivery 说明是肯定没发出（not_sent）还是可能已发出（unknown）
//   dropped     排队太久或队列已满，没有处理
//   skipped     收到时已经太旧，没有处理
//   abandoned   处理到一半时进程退出或重启

import { messageKey } from '../identity.js';

export const MESSAGE_STATUSES = ['queued', 'processing', 'replied', 'notice', 'silent', 'send_failed', 'dropped', 'skipped', 'abandoned'];
const DAY_MS = 24 * 3_600_000;

// 生产用：存在 PostgreSQL 的 inbound_messages 表里，重启后仍能去重，也能查到每条消息的结果。
export class MessageInbox {
  constructor({ db, tenantId = 'default', dedupeWindowMs = DAY_MS } = {}) {
    if (!db) throw new Error('MessageInbox 需要 db（见 src/storage 的 openStorage）');
    this.db = db;
    this.tenantId = tenantId;
    this.dedupeWindowMs = dedupeWindowMs;
  }

  // 第一次见到这条消息返回 true，并记为 queued；去重窗口内见过返回 false。
  // 由数据库的主键保证：同一条消息同时到达两次，也只有一次返回 true。
  // 超过去重窗口的旧记录会被覆盖（消息编号以后可能被重新使用）。
  async claim(message) {
    const { rows } = await this.db.query(
      `INSERT INTO inbound_messages (tenant_id, message_key, conversation_key, message_ts, received_at, status, updated_at)
       VALUES ($1, $2, $3, $4, now(), 'queued', now())
       ON CONFLICT (tenant_id, message_key) DO UPDATE SET
         conversation_key = EXCLUDED.conversation_key, message_ts = EXCLUDED.message_ts, received_at = now(),
         status = 'queued', outcome = NULL, error_code = NULL, delivery = NULL, sent_message_id = NULL,
         send_attempts = 0, updated_at = now()
       WHERE inbound_messages.received_at < now() - ($5::double precision * interval '1 millisecond')
       RETURNING message_key`,
      [this.tenantId, message.key, message.conversation.key, new Date(message.ts), this.dedupeWindowMs],
    );
    return rows.length === 1;
  }

  /**
   * 更新一条消息的状态和结果。
   * @param {string} messageKey
   * @param {{status: string, outcome?: string, errorCode?: string, delivery?: string, sentMessageId?: string|number, sendAttempts?: number}} result
   */
  async update(messageKey, { status, outcome, errorCode, delivery, sentMessageId, sendAttempts }) {
    await this.db.query(
      `UPDATE inbound_messages SET status = $3, outcome = COALESCE($4, outcome), error_code = COALESCE($5, error_code),
         delivery = COALESCE($6, delivery), sent_message_id = COALESCE($7, sent_message_id),
         send_attempts = COALESCE($8, send_attempts), updated_at = now()
       WHERE tenant_id = $1 AND message_key = $2`,
      [this.tenantId, messageKey, status, outcome ?? null, errorCode ?? null, delivery ?? null,
        sentMessageId === undefined || sentMessageId === null ? null : String(sentMessageId), sendAttempts ?? null],
    );
  }

  // 启动时调用：上次退出时还在排队或处理中的消息标为 abandoned，返回条数。
  // 只适用于同一租户只有一个机器人进程的情况（目前就是这样）。
  async recoverInterrupted() {
    const { rows } = await this.db.query(
      `UPDATE inbound_messages SET status = 'abandoned', outcome = COALESCE(outcome, 'interrupted'), updated_at = now()
       WHERE tenant_id = $1 AND status IN ('queued', 'processing') RETURNING message_key`,
      [this.tenantId],
    );
    return rows.length;
  }

  // 删除早于 olderThanMs 的记录，返回条数。默认保留 30 天。
  async prune(olderThanMs = 30 * DAY_MS) {
    const { rows } = await this.db.query(
      `DELETE FROM inbound_messages WHERE tenant_id = $1 AND received_at < now() - ($2::double precision * interval '1 millisecond')
       RETURNING message_key`,
      [this.tenantId, olderThanMs],
    );
    return rows.length;
  }

  // 最近发出的消息（按时间顺序），用于重启后仍能识别“有人引用了奶蛙发过的消息”。
  // 返回奶蛙发出的那条消息的 key（会话 key + 发出的消息编号）。
  async recentSentMessages({ withinMs = 7 * DAY_MS, limit = 2000 } = {}) {
    const { rows } = await this.db.query(
      `SELECT conversation_key, sent_message_id FROM inbound_messages
        WHERE tenant_id = $1 AND sent_message_id IS NOT NULL
          AND received_at > now() - ($2::double precision * interval '1 millisecond')
        ORDER BY received_at DESC LIMIT $3`,
      [this.tenantId, withinMs, limit],
    );
    return rows.reverse().map((row) => messageKey(row.conversation_key, row.sent_message_id));
  }

  // 查一条消息的记录（排查问题、测试用）。
  async get(messageKey) {
    const { rows } = await this.db.query(
      `SELECT message_key, conversation_key, status, outcome, error_code, delivery, sent_message_id, send_attempts
         FROM inbound_messages WHERE tenant_id = $1 AND message_key = $2`,
      [this.tenantId, messageKey],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

function toRecord(row) {
  return {
    messageKey: row.message_key,
    conversationKey: row.conversation_key,
    status: row.status,
    outcome: row.outcome ?? undefined,
    errorCode: row.error_code ?? undefined,
    delivery: row.delivery ?? undefined,
    sentMessageId: row.sent_message_id ?? undefined,
    sendAttempts: Number(row.send_attempts),
  };
}

// 只存在内存里的版本，接口相同：测试和没有数据库的场合用。重启后清空，最多记 maxEntries 条。
export class MemoryInbox {
  constructor({ dedupeWindowMs = DAY_MS, maxEntries = 10_000, now = () => Date.now() } = {}) {
    this.dedupeWindowMs = dedupeWindowMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  async claim(message) {
    const now = this.now();
    const previous = this.entries.get(message.key);
    if (previous && now - previous.receivedAt < this.dedupeWindowMs) return false;
    this.entries.delete(message.key);
    this.entries.set(message.key, {
      messageKey: message.key, conversationKey: message.conversation.key, receivedAt: now, status: 'queued', sendAttempts: 0,
    });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return true;
  }

  async update(messageKey, result) {
    const entry = this.entries.get(messageKey);
    if (!entry) return;
    for (const [key, value] of Object.entries(result)) {
      if (value !== undefined && value !== null) entry[key] = key === 'sentMessageId' ? String(value) : value;
    }
  }

  async recoverInterrupted() {
    return 0;
  }

  async prune() {
    return 0;
  }

  async recentSentMessages() {
    return [...this.entries.values()]
      .filter((entry) => entry.sentMessageId !== undefined)
      .map((entry) => messageKey(entry.conversationKey, entry.sentMessageId));
  }

  async get(messageKey) {
    const entry = this.entries.get(messageKey);
    if (!entry) return null;
    const { receivedAt, ...record } = entry;
    return record;
  }
}
