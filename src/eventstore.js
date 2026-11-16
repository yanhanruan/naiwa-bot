import { randomUUID } from 'node:crypto';
import { JsonStore } from './store.js';
import { validateEvent } from './schema.js';

// 跨平台事件记录（Event Store）：append-only，统一事件格式。
// 事件封套：{ id, ts, platform, kind, actor, target, payload, privacy, meta }
export class EventStore {
  constructor(file) {
    this.store = new JsonStore(file);
    this.events = this.store.load() ?? [];
  }

  append(partial) {
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
    this.events.push(ev);
    this.store.save(this.events);
    return ev;
  }

  all() {
    return [...this.events];
  }

  query(filter = {}) {
    return this.events.filter((ev) => {
      for (const [k, v] of Object.entries(filter)) {
        if (ev[k] !== v) return false;
      }
      return true;
    });
  }

  count(filter) {
    return this.query(filter ?? {}).length;
  }
}
