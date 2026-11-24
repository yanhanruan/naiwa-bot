import { validateCharacterState } from './schema.js';
import { moodName } from './mood/mood.js';

// Character OS Bridge：对外暴露结构化角色状态 / 意图执行接口。
export class Bridge {
  constructor(fish) {
    this.fish = fish;
  }

  // 查询角色当前心情与状态（结构化，符合 schema）。心情见 src/mood/：今天的基调、现在是哪一档、起伏。
  async getCharacterState() {
    const m = await this.fish.mood.current();
    const mood = { now: moodName(m.level), base: moodName(m.base), manual: m.manual, ripple: Number(m.ripple.toFixed(2)), day: m.day };
    const st = { ...(await this.fish.character.state()), mood };
    const v = validateCharacterState(st);
    if (!v.ok) throw new Error(`invalid character state: ${v.errors.join('; ')}`);
    return st;
  }

  // 完整运行状态（含策略开关、事件计数），供 Character OS 或监控使用。
  async getStatus() {
    return {
      character: await this.getCharacterState(),
      policy: {
        proactiveEnabled: this.fish.policy.proactiveEnabled,
        publishApprovalRequired: this.fish.policy.publishApprovalRequired,
        dmApprovalRequired: this.fish.policy.dmApprovalRequired,
        pendingApprovals: this.fish.policy.pendingCount(),
      },
      events: { count: await this.fish.events.count() },
      platforms: this.fish.connectedPlatforms ?? [],
    };
  }

  // 执行一个意图（统一工具调用接口）。写操作走审批，读/回复直接执行。
  async act(intent = {}) {
    const fish = this.fish;
    const check = fish.policy.check(intent);
    if (check.needsApproval) {
      const req = fish.policy.requestApproval(intent);
      await fish.events.append({
        kind: 'approval.requested',
        platform: intent.platform ?? 'fish-os',
        target: intent.target ?? null,
        payload: { action: intent, approvalId: req.id },
        privacy: 'self',
      });
      return { ok: false, approved: false, pendingApprovalId: req.id, reason: check.reason };
    }
    if (!check.ok) {
      return { ok: false, approved: false, reason: check.reason };
    }
    await fish.events.append({
      kind: intent.type === 'proactive' ? 'proactive.action' : 'message.sent',
      platform: intent.platform ?? 'fish-os',
      target: intent.target ?? null,
      payload: { action: intent },
      privacy: intent.privacy ?? 'self',
    });
    return { ok: true, approved: true, action: intent };
  }

  async approve(id) {
    const fish = this.fish;
    const res = fish.policy.approve(id);
    if (res.ok) {
      await fish.events.append({
        kind: 'approval.granted',
        platform: 'fish-os',
        payload: { approvalId: id, action: res.request.action },
        privacy: 'self',
      });
    }
    return res;
  }

  async deny(id) {
    const fish = this.fish;
    const res = fish.policy.deny(id);
    if (res.ok) {
      await fish.events.append({
        kind: 'approval.denied',
        platform: 'fish-os',
        payload: { approvalId: id, action: res.request.action },
        privacy: 'self',
      });
    }
    return res;
  }
}
