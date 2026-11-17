// 短期对话历史：每个会话最近几条发给模型的消息，存在数据库里，重启后仍在。
// - 只有确实发出的回复才写入（一问一答一起写），失败、提示语都不写。
// - 读取时只取最近 maxEntries 条，而且只要 freshMs 以内的：隔天再来就当新对话，不拿昨天的半句话当上文。
// - 超过 7 天的定期删除。长期记忆（memories）不受影响。
const HOUR_MS = 3_600_000;

export const HISTORY_DEFAULTS = {
  maxEntries: 6, // 3 轮
  freshMs: 24 * HOUR_MS,
  keepMs: 7 * 24 * HOUR_MS,
};

export class ConversationHistory {
  constructor({ db, tenantId = 'default', maxEntries = HISTORY_DEFAULTS.maxEntries, freshMs = HISTORY_DEFAULTS.freshMs } = {}) {
    if (!db) throw new Error('ConversationHistory 需要 db（见 src/storage 的 openStorage）');
    this.db = db;
    this.tenantId = tenantId;
    this.maxEntries = maxEntries;
    this.freshMs = freshMs;
  }

  // 某个会话的近期历史，按时间顺序：[{ role, content }]。
  async recent(conversationKey) {
    const { rows } = await this.db.query(
      `SELECT role, content FROM conversation_turns
        WHERE tenant_id = $1 AND conversation_key = $2
          AND created_at > now() - ($3::double precision * interval '1 millisecond')
        ORDER BY id DESC LIMIT $4`,
      [this.tenantId, conversationKey, this.freshMs, this.maxEntries],
    );
    return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
  }

  /**
   * 追加几条（按顺序），例如一问一答。
   * @param {string} conversationKey
   * @param {Array<{role: 'user'|'assistant', content: string}>} entries
   * @param {{messageKey?: string}} [opts] 对应的入站消息 key，排查问题用
   */
  async append(conversationKey, entries, { messageKey } = {}) {
    if (!entries.length) return;
    const values = [];
    const params = [this.tenantId, conversationKey, messageKey ?? null];
    for (const entry of entries) {
      params.push(entry.role, entry.content);
      values.push(`($1, $2, $${params.length - 1}, $${params.length}, $3)`);
    }
    // VALUES 按顺序插入，id 递增，读取时按 id 排序就是对话顺序。
    await this.db.query(
      `INSERT INTO conversation_turns (tenant_id, conversation_key, role, content, message_key) VALUES ${values.join(', ')}`,
      params,
    );
  }

  // 删除早于 olderThanMs 的历史（默认 7 天），返回条数。
  async prune(olderThanMs = HISTORY_DEFAULTS.keepMs) {
    const { rows } = await this.db.query(
      `DELETE FROM conversation_turns WHERE tenant_id = $1
         AND created_at < now() - ($2::double precision * interval '1 millisecond') RETURNING id`,
      [this.tenantId, olderThanMs],
    );
    return rows.length;
  }
}
