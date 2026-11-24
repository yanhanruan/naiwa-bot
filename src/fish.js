import { EventStore } from './eventstore.js';
import { CharacterCore } from './character.js';
import { Policy } from './policy.js';
import { Scheduler } from './scheduler.js';
import { Bridge } from './bridge.js';
import { Mood } from './mood/mood.js';

// 数字生命顶层编排：把人格、事件、策略、调度、Bridge 组装成一条「鱼」。
// 平台适配器通过 reactTo / touch / act 与鱼交互。记忆（事实）见 src/memory/。
// 所有持久化都通过 db（见 src/storage），因此涉及存储的方法都是异步的。
// writer：forget-person 会删的数据走它写（持锁连接，见 src/storage/run-lock.js）；不传就用 db（测试、CLI）。
export class Fish {
  // 用 Fish.open 创建：它会在数据库里准备好角色状态。
  static async open({ db, writer, tenantId = 'default', name = '奶蛙', persona = {}, policy = {} } = {}) {
    const fish = new Fish({ db, writer, tenantId, name, persona, policy });
    await fish.character.init();
    return fish;
  }

  constructor({ db, writer = db, tenantId = 'default', name = '奶蛙', persona = {}, policy = {} } = {}) {
    if (!db) throw new Error('Fish requires a db（见 src/storage 的 openStorage）');
    this.db = db;
    this.writer = writer ?? db;
    this.tenantId = tenantId;
    this.events = new EventStore(db, { tenantId });
    this.character = new CharacterCore({ db, writer: this.writer, tenantId, name, persona });
    this.mood = new Mood({ db, tenantId }); // 奶蛙的心情（Module 8）：全局一份
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

  // 平台适配器把入站消息转成统一事件交给这里。
  async reactTo(event) {
    return this.events.append(event);
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

  // 记一次互动（次数、第一次见面时间）。不记好感，也不往事件表写（Module 8：不按人存情绪）。
  async touch(peerId, opts) {
    return this.character.touchRelationship(peerId, opts);
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
