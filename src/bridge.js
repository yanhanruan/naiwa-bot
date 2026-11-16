import { validateCharacterState } from './schema.js';

// Character OS Bridge：对外暴露结构化角色状态 / 记忆 / 意图执行接口。
export class Bridge {
  constructor(fish) {
    this.fish = fish;
  }

  // 查询角色当前情绪与状态（结构化，符合 schema）。
  getCharacterState() {
    const st = this.fish.character.state();
    const v = validateCharacterState(st);
    if (!v.ok) throw new Error(`invalid character state: ${v.errors.join('; ')}`);
    return st;
  }

  // 完整运行状态（含策略开关、记忆/事件计数），供 Character OS 或监控使用。
  getStatus() {
    return {
      character: this.getCharacterState(),
      policy: {
        proactiveEnabled: this.fish.policy.proactiveEnabled,
        publishApprovalRequired: this.fish.policy.publishApprovalRequired,
        dmApprovalRequired: this.fish.policy.dmApprovalRequired,
        pendingApprovals: this.fish.policy.pendingCount(),
      },
      memory: { count: this.fish.memory.count() },
      events: { count: this.fish.events.count() },
      platforms: this.fish.connectedPlatforms ?? [],
    };
  }

  // 检索角色记忆（带隐私隔离）。
  getMemory({ query = '', requester = 'self', types = null, limit = 10 } = {}) {
    return this.fish.memory.retrieve({ query, requester, types, limit });
  }

  // 输出可供 Character OS 使用的结构化情绪/动作指令。
  express(intent = {}) {
    const c = this.fish.character;
    const mood = c.moodLabel();
    return {
      intent: intent.intent ?? 'chat',
      mood,
      moodVector: { ...c.mood },
      style: c.persona.style,
      tone: c.persona.tone,
      expression: this._render(intent, mood),
    };
  }

  _render(intent, mood) {
    const moodDecor = {
      '兴奋': '（摆摆尾巴，眼睛亮晶晶）',
      '开心': '（吐了个小泡泡）',
      '低落': '（轻轻沉到水底，尾巴没精打采）',
      '有点闷': '（慢慢游了一圈）',
      '困困的': '（打了个哈欠，泡泡都变小了）',
      '平静': '（悠悠地摆着鳍）',
    }[mood] ?? '';
    return `${moodDecor}${intent.text ?? ''}`;
  }

  // 执行一个意图（统一工具调用接口）。写操作走审批，读/回复直接执行。
  act(intent = {}) {
    const fish = this.fish;
    const check = fish.policy.check(intent);
    if (check.needsApproval) {
      const req = fish.policy.requestApproval(intent);
      fish.events.append({
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
    fish.events.append({
      kind: intent.type === 'proactive' ? 'proactive.action' : 'message.sent',
      platform: intent.platform ?? 'fish-os',
      target: intent.target ?? null,
      payload: { action: intent },
      privacy: intent.privacy ?? 'self',
    });
    return { ok: true, approved: true, action: intent };
  }

  approve(id) {
    const fish = this.fish;
    const res = fish.policy.approve(id);
    if (res.ok) {
      fish.events.append({
        kind: 'approval.granted',
        platform: 'fish-os',
        payload: { approvalId: id, action: res.request.action },
        privacy: 'self',
      });
    }
    return res;
  }

  deny(id) {
    const fish = this.fish;
    const res = fish.policy.deny(id);
    if (res.ok) {
      fish.events.append({
        kind: 'approval.denied',
        platform: 'fish-os',
        payload: { approvalId: id, action: res.request.action },
        privacy: 'self',
      });
    }
    return res;
  }
}
