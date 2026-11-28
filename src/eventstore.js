import { randomUUID } from 'node:crypto';
import { validateEvent } from './schema.js';

// 跨平台事件记录（Event Store）：只追加，统一事件格式。
// 事件封套：{ id, ts, platform, kind, actor, target, payload, privacy, meta }
const FILTER_COLUMNS = new Set(['platform', 'kind', 'actor', 'target', 'privacy']);
const COLUMNS = 'id, ts, platform, kind, actor, target, payload, privacy, meta';

export function eventFromRow(row) {
  return {
    id: row.id,
    ts: row.ts.getTime(),
    platform: row.platform,
    kind: row.kind,
    actor: row.actor,
    target: row.target,
    payload: row.payload,
    privacy: row.privacy,
    meta: row.meta,
  };
}

function where(tenantId, filter) {
  const params = [tenantId];
  const clauses = ['tenant_id = $1'];
  for (const [k, v] of Object.entries(filter)) {
    if (!FILTER_COLUMNS.has(k)) throw new Error(`不支持按 ${k} 过滤事件`);
    params.push(v);
    clauses.push(`${k} IS NOT DISTINCT FROM $${params.length}`);
  }
  return { sql: clauses.join(' AND '), params };
}

export class EventStore {
  constructor(db, { tenantId = 'default' } = {}) {
    this.db = db;
    this.tenantId = tenantId;
  }

  // 删掉 keepDays 天以前的事件（Module 10：事件表原来不清理）。
  async prune({ keepDays = 90 } = {}) {
    const { rowCount } = await this.db.query(
      `DELETE FROM events WHERE tenant_id = $1 AND ts < now() - ($2::int * interval '1 day')`, [this.tenantId, keepDays]);
    return rowCount;
  }

  async append(partial) {
    const ev = {
      id: randomUUID(),
      ts: Date.now(),
      platform: partial.platform ?? 'fish-os',
      kind: partial.kind,
      actor: partial.actor ?? 'fish',
      target: partial.target ?? null,
      payload: partial.payload ?? {},
      privacy: partial.privacy ?? 'self',
      meta: partial.meta ?? {},
    };
    const v = validateEvent(ev);
    if (!v.ok) throw new Error(`invalid event: ${v.errors.join('; ')}`);
    await this.db.query(
      `INSERT INTO events (tenant_id, ${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [this.tenantId, ev.id, new Date(ev.ts), ev.platform, ev.kind, ev.actor, ev.target, ev.payload, ev.privacy, ev.meta],
    );
    return ev;
  }

  // filter 只支持 platform / kind / actor / target / privacy 的等值匹配。
  async query(filter = {}, { limit = 1000 } = {}) {
    const w = where(this.tenantId, filter);
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM events WHERE ${w.sql} ORDER BY ts, id LIMIT $${w.params.length + 1}`,
      [...w.params, limit],
    );
    return rows.map(eventFromRow);
  }

  async count(filter = {}) {
    const w = where(this.tenantId, filter);
    const { rows } = await this.db.query(`SELECT count(*)::int AS n FROM events WHERE ${w.sql}`, w.params);
    return rows[0].n;
  }
}
