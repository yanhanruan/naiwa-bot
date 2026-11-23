// 短期对话历史：每个会话最近几条发给模型的消息，存在数据库里，重启后仍在。
// - 只有确实发出的回复才写入（问的几句和回复一起写），失败、提示语都不写。
// - 每句话单独一行，带着自己的消息编号；奶蛙的回复挂在“它回的那个人这一轮最后一句”上（见 module-07b 第 5 节）。
// - 读取时只取最近 maxEntries 条，而且只要 freshMs 以内的：隔天再来就当新对话，不拿昨天的半句话当上文；
//   开头截到半截（只有奶蛙的回复、没有问的那句）的去掉。
// - 超过 7 天的定期删除。
// - 写入和删除走 writer（持锁连接，见 src/storage/run-lock.js）：forget-person 删掉的原话，旧进程写不回来。读取走 db。
import { senderAliasOf } from '../message.js';

const HOUR_MS = 3_600_000;

export const HISTORY_DEFAULTS = {
  // 一轮可能有好几句，取 20 条以内。12 条在热闹的群里只够一两分钟，奶蛙会忘了自己刚说过的话
  // （docs/naiwa-smartness-research.md 第四节⑤）。
  maxEntries: 20,
  freshMs: 24 * HOUR_MS,
  keepMs: 7 * 24 * HOUR_MS,
};

export class ConversationHistory {
  constructor({ db, writer = db, tenantId = 'default', maxEntries = HISTORY_DEFAULTS.maxEntries, freshMs = HISTORY_DEFAULTS.freshMs } = {}) {
    if (!db) throw new Error('ConversationHistory 需要 db（见 src/storage 的 openStorage）');
    this.db = db;
    this.writer = writer;
    this.tenantId = tenantId;
    this.maxEntries = maxEntries;
    this.freshMs = freshMs;
  }

  /**
   * 某个会话的近期历史，按时间顺序：[{ role, content, to? }]。
   * to：奶蛙这条回复是回谁的（代号），从挂在一起的那句认出来；认不出来的没有这一项。
   */
  async recent(conversationKey) {
    const { rows } = await this.db.query(
      `SELECT role, content, message_key FROM conversation_turns
        WHERE tenant_id = $1 AND conversation_key = $2
          AND created_at > now() - ($3::double precision * interval '1 millisecond')
        ORDER BY id DESC LIMIT $4`,
      [this.tenantId, conversationKey, this.freshMs, this.maxEntries],
    );
    const list = rows.reverse();
    while (list.length && list[0].role === 'assistant') list.shift();
    // 回复前面就是它回的那个人这一轮的几句（最后一句和回复带同一个消息编号），所以在取到的这几条里就能找到。
    const askedBy = new Map();
    for (const row of list) if (row.role === 'user' && row.message_key) askedBy.set(row.message_key, senderAliasOf(row.content));
    return list.map((row) => {
      const to = row.role === 'assistant' ? askedBy.get(row.message_key) : null;
      return to ? { role: row.role, content: row.content, to } : { role: row.role, content: row.content };
    });
  }

  /**
   * 追加几条（按顺序），例如问的几句和回复。
   * @param {string} conversationKey
   * @param {Array<{role: 'user'|'assistant', content: string, messageKey?: string}>} entries
   *   messageKey：这一条对应的入站消息 key；没写的用 opts.messageKey
   * @param {{messageKey?: string}} [opts]
   */
  async append(conversationKey, entries, { messageKey } = {}) {
    if (!entries.length) return;
    const values = [];
    const params = [this.tenantId, conversationKey];
    for (const entry of entries) {
      params.push(entry.role, entry.content, entry.messageKey ?? messageKey ?? null);
      values.push(`($1, $2, $${params.length - 2}, $${params.length - 1}, $${params.length})`);
    }
    // VALUES 按顺序插入，id 递增，读取时按 id 排序就是对话顺序。
    await this.writer.query(
      `INSERT INTO conversation_turns (tenant_id, conversation_key, role, content, message_key) VALUES ${values.join(', ')}`,
      params,
    );
  }

  // 删除早于 olderThanMs 的历史（默认 7 天），返回条数。
  async prune(olderThanMs = HISTORY_DEFAULTS.keepMs) {
    const { rows } = await this.writer.query(
      `DELETE FROM conversation_turns WHERE tenant_id = $1
         AND created_at < now() - ($2::double precision * interval '1 millisecond') RETURNING id`,
      [this.tenantId, olderThanMs],
    );
    return rows.length;
  }
}
