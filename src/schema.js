// Fish OS 统一 Schema 与常量（零依赖）
// 统一事件格式 + 角色状态 的最小校验。记忆（事实）的规则见 src/memory/。

export const EVENT_KINDS = new Set([
  'message.received',
  'message.sent',
  'content.read',
  'mood.changed',
  'interest.grown',
  'relationship.touched',
  'proactive.tick',
  'proactive.action',
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'platform.connected',
  'platform.disconnected',
  'bridge.status',
  'system.started',
  'system.stopped',
]);

export const PLATFORMS = new Set([
  'qq',
  'bilibili',
  'xiaohongshu',
  'douyin',
  'fish-os',
  'character-os',
]);

export function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export function clamp(n, lo, hi) {
  if (typeof n !== 'number' || Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function validateEvent(ev) {
  const errors = [];
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return { ok: false, errors: ['event must be a plain object'] };
  }
  if (typeof ev.id !== 'string' || !ev.id) errors.push('id: required non-empty string');
  if (!(typeof ev.ts === 'number' && Number.isFinite(ev.ts))) errors.push('ts: required number (epoch ms)');
  if (typeof ev.platform !== 'string' || !ev.platform) errors.push('platform: required non-empty string');
  if (!EVENT_KINDS.has(ev.kind)) errors.push(`kind: unknown "${ev.kind}"`);
  if (!('actor' in ev)) errors.push('actor: required');
  if (!('payload' in ev)) errors.push('payload: required');
  if (ev.privacy !== undefined && typeof ev.privacy !== 'string') errors.push('privacy: must be string');
  if (ev.target !== undefined && !(typeof ev.target === 'string' || ev.target === null)) {
    errors.push('target: must be string or null');
  }
  return { ok: errors.length === 0, errors };
}

export function validateCharacterState(st) {
  const errors = [];
  if (!st || typeof st !== 'object' || Array.isArray(st)) {
    return { ok: false, errors: ['state must be a plain object'] };
  }
  if (typeof st.id !== 'string' || !st.id) errors.push('id: required');
  if (typeof st.name !== 'string' || !st.name) errors.push('name: required');
  if (!st.mood || typeof st.mood !== 'object') errors.push('mood: required object');
  if (!Array.isArray(st.interests)) errors.push('interests: must be array');
  if (!st.relationships || typeof st.relationships !== 'object') {
    errors.push('relationships: required object');
  }
  return { ok: errors.length === 0, errors };
}
