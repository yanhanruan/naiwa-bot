import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from './eventstore.js';
import { MemoryService } from './memory.js';
import { CharacterCore } from './character.js';
import { Policy } from './policy.js';
import { Scheduler } from './scheduler.js';
import { Bridge } from './bridge.js';
import { scope } from './schema.js';

// 数字生命顶层编排：把人格、记忆、事件、策略、调度、Bridge 组装成一条「鱼」。
// 平台适配器通过 reactTo / remember / recall / touch / act 与鱼交互。
export class Fish {
  constructor({ home, name = '奶蛙', persona = {}, policy = {} } = {}) {
    if (!home) throw new Error('Fish requires a home directory');
    this.home = home;
    mkdirSync(home, { recursive: true });
    this.events = new EventStore(join(home, 'events.json'));
    this.memory = new MemoryService(join(home, 'memory.json'));
    this.character = new CharacterCore({ name, persona, file: join(home, 'character.json') });
    this.policy = new Policy(policy);
    this.scheduler = new Scheduler({ policy: this.policy });
    this.bridge = new Bridge(this);
    this.connectedPlatforms = [];
    this._started = false;
  }

  start() {
    this.events.append({ kind: 'system.started', payload: { name: this.character.name } });
    this._started = true;
    return this;
  }

  stop() {
    this.events.append({ kind: 'system.stopped', payload: {} });
    this._started = false;
    return this;
  }

  connect(platform) {
    if (!this.connectedPlatforms.includes(platform)) {
      this.connectedPlatforms.push(platform);
      this.events.append({ kind: 'platform.connected', platform, payload: {} });
    }
    return this;
  }

  disconnect(platform) {
    this.connectedPlatforms = this.connectedPlatforms.filter((p) => p !== platform);
    this.events.append({ kind: 'platform.disconnected', platform, payload: {} });
    return this;
  }

  // —— 高级 API（平台适配器 / 工具调用统一入口）——

  remember({ type, content, tags, peers, importance, access, summary, meta }) {
    const res = this.memory.add({ type, content, tags, peers, importance, access, summary, meta });
    if (res.added) {
      this.events.append({
        kind: 'memory.added',
        platform: 'fish-os',
        payload: { id: res.record.id, type: res.record.type, access: res.record.access },
        privacy: res.record.access,
      });
    }
    return res;
  }

  recall({ query, requester = 'self', types, limit }) {
    const recs = this.memory.retrieve({ query, requester, types, limit });
    this.events.append({
      kind: 'memory.retrieved',
      platform: 'fish-os',
      payload: { query, requester, count: recs.length },
      privacy: 'self',
    });
    return recs;
  }

  // 平台适配器把入站消息转成统一事件交给这里。
  reactTo(event) {
    const ev = this.events.append(event);
    this.character.perceive(ev);
    return ev;
  }

  // 只读内容摄取：把平台适配器拉到的内容转成统一事件（不产生任何写操作）。
  ingestContent(items) {
    const events = [];
    for (const item of items) {
      events.push(
        this.events.append({
          platform: item.platform,
          kind: 'content.read',
          actor: this.character.name,
          target: item.id,
          payload: { title: item.title, author: item.author, url: item.url, stats: item.stats },
          privacy: 'self',
        }),
      );
    }
    return events;
  }

  // 形成简短观察（写入自我记忆）。
  observe(content, { tags = [], importance = 0.4 } = {}) {
    return this.remember({ type: 'self', content, tags, importance, access: 'self' });
  }

  touch(peerId, opts) {
    const rel = this.character.touchRelationship(peerId, opts);
    this.events.append({
      kind: 'relationship.touched',
      platform: 'fish-os',
      target: peerId,
      payload: { sentiment: rel.sentiment, interactions: rel.interactions },
      privacy: scope.private(peerId),
    });
    return rel;
  }

  // 主动行为：注册周期性任务；只在总开关打开时由 tick 触发。
  schedule(task) {
    return this.scheduler.register(task);
  }

  proactiveTick() {
    this.events.append({ kind: 'proactive.tick', platform: 'fish-os', payload: { enabled: this.policy.proactiveEnabled } });
    return this.scheduler.tick();
  }
}
