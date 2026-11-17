import { randomUUID } from 'node:crypto';
import { MEMORY_TYPES, clamp, clamp01, validateMemoryRecord } from './schema.js';

function normalize(s) {
  return String(s).replace(/\s+/g, '').toLowerCase();
}

// 去重键：太短的内容（如“好”“哈哈”）不去重。
export function dedupeKey(content) {
  const n = normalize(content);
  return n.length < 6 ? null : n;
}

// 朴素摘要（截断）。生产环境可替换为 LLM 摘要器，接口保持一致。
export function summarize(content, max = 140) {
  const s = String(content).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// 检索打分：重要性 + 新鲜度 + 关键词匹配（可解释、可测试）。
function scoreRecord(rec, query, now) {
  const ageDays = Math.max(0, now - rec.ts) / 86400000;
  const recency = 1 / (1 + ageDays);
  let match = 0;
  if (query) {
    const q = normalize(query);
    const hay = normalize([rec.content, rec.summary, (rec.tags || []).join(' ')].join(' '));
    if (q && hay.includes(q)) {
      match = 1;
    } else {
      const tokens = query.split(/\s+/).filter((t) => t.length > 0);
      const hits = tokens.filter((t) => hay.includes(normalize(t))).length;
      match = tokens.length ? hits / tokens.length : 0;
    }
  }
  const importance = clamp01(rec.importance);
  return importance * 0.5 + recency * 0.3 + match * 0.2;
}

export const MEMORY_COLUMNS = 'id, ts, type, content, summary, tags, peers, importance, access, meta';

function fromRow(row) {
  return {
    id: row.id,
    ts: row.ts.getTime(),
    type: row.type,
    content: row.content,
    summary: row.summary,
    tags: row.tags,
    peers: row.peers,
    importance: row.importance,
    access: row.access,
    meta: row.meta,
  };
}

// 可见性的 SQL 版本，必须与 schema.js 的 visibleTo 保持一致。n 是 requester 参数的序号。
function visibleSql(n) {
  const r = `$${n}::text`;
  return `(${r} = 'self'
    OR access = 'public'
    OR access = 'private:' || ${r}
    OR access = 'conversation:' || ${r}
    OR (access LIKE 'group:%' AND ${r} = ANY(peers)))`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 长期记忆服务：情节/语义/关系/兴趣/自我五类，支持检索、摘要、去重、遗忘、导出、删除。
// 不在内存里缓存记录：每次都读写数据库，多个进程（机器人、CLI）看到的是同一份数据。
export class MemoryService {
  constructor(db, { tenantId = 'default' } = {}) {
    this.db = db;
    this.tenantId = tenantId;
  }

  async add({ type, content, tags = [], peers = [], importance = 0.5, access = 'self', summary = null, meta = {} }) {
    if (!MEMORY_TYPES.has(type)) throw new Error(`unknown memory type: ${type}`);
    const rec = {
      id: randomUUID(),
      ts: Date.now(),
      type,
      content: String(content),
      summary: summary ?? summarize(content),
      tags,
      peers,
      importance: clamp(importance, 0, 1),
      access,
      meta,
    };
    const v = validateMemoryRecord(rec);
    if (!v.ok) throw new Error(`invalid memory record: ${v.errors.join('; ')}`);
    // 去重由唯一索引保证；冲突时不插入，即为重复。多个进程同时写同一条也只会留一条。
    const { rows } = await this.db.query(
      `INSERT INTO memories (tenant_id, ${MEMORY_COLUMNS}, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id, type, access, dedupe_key) DO NOTHING
       RETURNING id`,
      [this.tenantId, rec.id, new Date(rec.ts), rec.type, rec.content, rec.summary, rec.tags, rec.peers,
        rec.importance, rec.access, rec.meta, dedupeKey(rec.content)],
    );
    if (rows.length === 0) return { added: false, reason: 'duplicate' };
    return { added: true, record: rec };
  }

  async retrieve({ query = '', requester = 'self', types = null, limit = 10 } = {}) {
    const { rows } = await this.db.query(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE tenant_id = $1 AND ${visibleSql(2)} AND ($3::text[] IS NULL OR type = ANY($3::text[]))`,
      [this.tenantId, requester, types],
    );
    const now = Date.now();
    const scored = rows.map(fromRow).map((r) => ({ r, score: scoreRecord(r, query, now) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.r);
  }

  async get(id) {
    if (!UUID.test(String(id))) return null;
    const { rows } = await this.db.query(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId, id],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async forget(id, requester = 'self') {
    if (!UUID.test(String(id))) return { ok: false, reason: 'not-found' };
    const { rows } = await this.db.query(
      `DELETE FROM memories WHERE tenant_id = $1 AND id = $2 AND ${visibleSql(3)} RETURNING ${MEMORY_COLUMNS}`,
      [this.tenantId, id, requester],
    );
    if (rows[0]) return { ok: true, removed: fromRow(rows[0]) };
    return { ok: false, reason: (await this.get(id)) ? 'forbidden' : 'not-found' };
  }

  async export({ requester = 'self' } = {}) {
    const { rows } = await this.db.query(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE tenant_id = $1 AND ${visibleSql(2)} ORDER BY ts, id`,
      [this.tenantId, requester],
    );
    return rows.map(fromRow);
  }

  // requester === 'self' 时删除全部；否则只删除对其可见的部分（隐私隔离）。
  async deleteAll(requester = 'self') {
    const { rows } = await this.db.query(
      `WITH d AS (DELETE FROM memories WHERE tenant_id = $1 AND ${visibleSql(2)} RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
      [this.tenantId, requester],
    );
    return { ok: true, deleted: rows[0].n };
  }

  async summarizeFor({ requester = 'self', types = null, limit = 20 } = {}) {
    const recs = await this.retrieve({ requester, types, limit, query: '' });
    return recs.map((r) => ({ id: r.id, type: r.type, summary: r.summary, ts: r.ts }));
  }

  async count() {
    const { rows } = await this.db.query('SELECT count(*)::int AS n FROM memories WHERE tenant_id = $1', [this.tenantId]);
    return rows[0].n;
  }
}
