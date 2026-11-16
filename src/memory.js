import { randomUUID } from 'node:crypto';
import { JsonStore } from './store.js';
import { MEMORY_TYPES, clamp, clamp01, validateMemoryRecord, visibleTo } from './schema.js';

function normalize(s) {
  return String(s).replace(/\s+/g, '').toLowerCase();
}

// 朴素摘要（截断）。生产环境可替换为 LLM 摘要器，接口保持一致。
function summarize(content, max = 140) {
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

// 长期记忆服务：情节/语义/关系/兴趣/自我五类，支持检索、摘要、去重、遗忘、导出、删除。
export class MemoryService {
  constructor(file) {
    this.store = new JsonStore(file);
    this.records = this.store.load() ?? [];
  }

  _persist() {
    this.store.save(this.records);
  }

  _isDuplicate(content, type, access) {
    const n = normalize(content);
    if (n.length < 6) return false;
    // 不同可见范围各自拥有记录，不能因正文相同而吞掉另一会话的记忆。
    return this.records.some((r) => r.type === type && r.access === access && normalize(r.content) === n);
  }

  add({ type, content, tags = [], peers = [], importance = 0.5, access = 'self', summary = null, meta = {} }) {
    if (!MEMORY_TYPES.has(type)) throw new Error(`unknown memory type: ${type}`);
    if (this._isDuplicate(content, type, access)) return { added: false, reason: 'duplicate' };
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
    this.records.push(rec);
    this._persist();
    return { added: true, record: rec };
  }

  retrieve({ query = '', requester = 'self', types = null, limit = 10 } = {}) {
    const now = Date.now();
    const visible = this.records.filter((r) => visibleTo(r, requester));
    const filtered = types ? visible.filter((r) => types.includes(r.type)) : visible;
    const scored = filtered.map((r) => ({ r, score: scoreRecord(r, query, now) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.r);
  }

  get(id) {
    return this.records.find((r) => r.id === id) ?? null;
  }

  forget(id, requester = 'self') {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) return { ok: false, reason: 'not-found' };
    if (!visibleTo(this.records[idx], requester)) return { ok: false, reason: 'forbidden' };
    const [removed] = this.records.splice(idx, 1);
    this._persist();
    return { ok: true, removed };
  }

  export({ requester = 'self' } = {}) {
    return this.records.filter((r) => visibleTo(r, requester)).map((r) => ({ ...r }));
  }

  // requester === 'self' 时删除全部；否则只删除对其可见的部分（隐私隔离）。
  deleteAll(requester = 'self') {
    if (requester === 'self') {
      const n = this.records.length;
      this.records = [];
      this._persist();
      return { ok: true, deleted: n };
    }
    const before = this.records.length;
    this.records = this.records.filter((r) => !visibleTo(r, requester));
    this._persist();
    return { ok: true, deleted: before - this.records.length };
  }

  summarizeFor({ requester = 'self', types = null, limit = 20 } = {}) {
    const recs = this.retrieve({ requester, types, limit, query: '' });
    return recs.map((r) => ({ id: r.id, type: r.type, summary: r.summary, ts: r.ts }));
  }

  count() {
    return this.records.length;
  }
}
