import { randomUUID } from 'node:crypto';

// 权限与人工审批（Policy & Approval）。
// 最小权限：读(read)/回复(reply)允许；发布(publish)/私信(dm)默认需审批；
// 主动行为(proactive)受总开关控制。
export class Policy {
  constructor({
    proactiveEnabled = false,
    publishApprovalRequired = true,
    dmApprovalRequired = true,
    allowReply = true,
  } = {}) {
    this.proactiveEnabled = proactiveEnabled;
    this.publishApprovalRequired = publishApprovalRequired;
    this.dmApprovalRequired = dmApprovalRequired;
    this.allowReply = allowReply;
    this.pending = [];
    this.decisions = [];
  }

  setProactiveEnabled(v) {
    this.proactiveEnabled = !!v;
    return this.proactiveEnabled;
  }

  // 判断动作是否可直接执行 / 需要审批 / 被拒绝。
  check(action) {
    const type = action?.type;
    if (!type) return { ok: false, reason: 'missing-action-type', needsApproval: false };
    if (type === 'read' || type === 'reply') {
      return this.allowReply
        ? { ok: true, needsApproval: false }
        : { ok: false, reason: 'reply-disabled', needsApproval: false };
    }
    if (type === 'publish') {
      if (this.publishApprovalRequired) {
        return { ok: false, reason: 'publish-requires-approval', needsApproval: true };
      }
      return { ok: true, needsApproval: false };
    }
    if (type === 'dm') {
      if (this.dmApprovalRequired) {
        return { ok: false, reason: 'dm-requires-approval', needsApproval: true };
      }
      return { ok: true, needsApproval: false };
    }
    if (type === 'proactive') {
      if (!this.proactiveEnabled) {
        return { ok: false, reason: 'proactive-disabled', needsApproval: false };
      }
      return { ok: true, needsApproval: false };
    }
    return { ok: false, reason: `unknown-action-type:${type}`, needsApproval: false };
  }

  requestApproval(action) {
    const req = { id: randomUUID(), ts: Date.now(), action, status: 'pending' };
    this.pending.push(req);
    return req;
  }

  approve(id) {
    return this._decide(id, 'approved');
  }

  deny(id) {
    return this._decide(id, 'denied');
  }

  _decide(id, status) {
    const req = this.pending.find((r) => r.id === id);
    if (!req) return { ok: false, reason: 'not-found' };
    req.status = status;
    req.decidedAt = Date.now();
    this.pending = this.pending.filter((r) => r.id !== id);
    this.decisions.push(req);
    return { ok: true, request: req };
  }

  pendingCount() {
    return this.pending.length;
  }
}
