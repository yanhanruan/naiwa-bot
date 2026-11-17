import { EventStore } from './eventstore.js';
import { MemoryService } from './memory.js';
import { CharacterCore } from './character.js';
import { Policy } from './policy.js';
import { Scheduler } from './scheduler.js';
import { Bridge } from './bridge.js';
import { scope } from './schema.js';

// 数字生命顶层编排：把人格、记忆、事件、策略、调度、Bridge 组装成一条「鱼」。
// 平台适配器通过 reactTo / remember / recall / touch / act 与鱼交互。
// 所有持久化都通过 db（见 src/storage），因此涉及存储的方法都是异步的。
export class Fish {
  // 用 Fish.open 创建：它会在数据库里准备好角色状态。
  static async open({ db, tenantId = 'default', name = '奶蛙', persona = {}, policy = {} } = {}) {
    const fish = new Fish({ db, tenantId, name, persona, policy });
    await fish.character.init();
    return fish;
  }

  constructor({ db, tenantId = 'default', name = '奶蛙', persona = {}, policy = {} } = {}) {
    if (!db) throw new Error('Fish requires a db（见 src/storage 的 openStorage）');
    this.db = db;
    this.tenantId = tenantId;
    this.events = new EventStore(db, { tenantId });
    this.memory = new MemoryService(db, { tenantId });
    this.character = new CharacterCore({ db, tenantId, name, persona });
    this.policy = new Policy(policy);
    this.scheduler = new Scheduler({ policy: this.policy });
    this.bridge = new Bridge(this);
    this.connectedPlatforms = [];
    this._started = false;
  }

  async start() {
    await this.events.append({ kind: 'system.started', payload: { name: this.character.name } });
    this._started = true;
    return this;
  }

  async stop() {
    await this.events.append({ kind: 'system.stopped', payload: {} });
    this._started = false;
    return this;
  }

  async connect(platform) {
    if (!this.connectedPlatforms.includes(platform)) {
      this.connectedPlatforms.push(platform);
      await this.events.append({ kind: 'platform.connected', platform, payload: {} });
    }
    return this;
  }

  async disconnect(platform) {
    this.connectedPlatforms = this.connectedPlatforms.filter((p) => p !== platform);
    await this.events.append({ kind: 'platform.disconnected', platform, payload: {} });
    return this;
  }

  // —— 高级 API（平台适配器 / 工具调用统一入口）——

  async remember({ type, content, tags, peers, importance, access, summary, meta }) {
    const res = await this.memory.add({ type, content, tags, peers, importance, access, summary, meta });
    if (res.added) {
      await this.events.append({
        kind: 'memory.added',
        platform: 'fish-os',
        payload: { id: res.record.id, type: res.record.type, access: res.record.access },
        privacy: res.record.access,
      });
    }
    return res;
  }

  async recall({ query, requester = 'self', types, limit }) {
    const recs = await this.memory.retrieve({ query, requester, types, limit });
    // 事件只记查询的字数，不记原文：聊天流程拿整条消息当查询，原文进事件表就会永久保存。
    await this.events.append({
      kind: 'memory.retrieved',
      platform: 'fish-os',
      payload: { queryChars: String(query ?? '').length, requester, count: recs.length },
      privacy: 'self',
    });
    return recs;
  }

  // 平台适配器把入站消息转成统一事件交给这里。
  async reactTo(event) {
    const ev = await this.events.append(event);
    await this.character.perceive(ev);
    return ev;
  }

  // 只读内容摄取：把平台适配器拉到的内容转成统一事件（不产生任何写操作）。
  async ingestContent(items) {
    const events = [];
    for (const item of items) {
      events.push(
        await this.events.append({
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

  async touch(peerId, opts) {
    const rel = await this.character.touchRelationship(peerId, opts);
    await this.events.append({
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

  async proactiveTick() {
    await this.events.append({ kind: 'proactive.tick', platform: 'fish-os', payload: { enabled: this.policy.proactiveEnabled } });
    return this.scheduler.tick();
  }
}
