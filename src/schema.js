// Fish OS 统一 Schema 与常量（零依赖）
// 统一事件格式 + 记忆记录 + 角色状态 的最小校验。

export const EVENT_KINDS = new Set([
  'message.received',
  'message.sent',
  'content.read',
  'memory.added',
  'memory.retrieved',
  'memory.forgotten',
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

export const MEMORY_TYPES = new Set([
  'episodic', // 情节记忆：发生过什么
  'semantic', // 语义记忆：学到了什么
  'relational', // 关系记忆：与谁有过互动
  'interest', // 兴趣记忆：喜欢/不喜欢什么
  'self', // 自我记忆：角色自身持续经历
]);

export const PLATFORMS = new Set([
  'qq',
  'bilibili',
  'xiaohongshu',
  'douyin',
  'fish-os',
  'character-os',
]);

// 隐私可见性：self / public / private:<peerId> / group:<groupId> / conversation:<conversationKey>
// conversation 表示“只在这个会话里可见”（私聊或群聊均可），与“属于某个人”的 private 是不同语义。
export const scope = {
  SELF: 'self',
  PUBLIC: 'public',
  private: (peerId) => `private:${peerId}`,
  group: (groupId) => `group:${groupId}`,
  conversation: (conversationKey) => `conversation:${conversationKey}`,
};

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

export function validateMemoryRecord(rec) {
  const errors = [];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, errors: ['record must be a plain object'] };
  }
  if (typeof rec.id !== 'string' || !rec.id) errors.push('id: required');
  if (!(typeof rec.ts === 'number' && Number.isFinite(rec.ts))) errors.push('ts: required number');
  if (!MEMORY_TYPES.has(rec.type)) errors.push(`type: unknown "${rec.type}"`);
  if (typeof rec.content !== 'string' || !rec.content) errors.push('content: required non-empty string');
  if (!Array.isArray(rec.peers)) errors.push('peers: must be array');
  if (!Array.isArray(rec.tags)) errors.push('tags: must be array');
  if (typeof rec.importance !== 'number') errors.push('importance: must be number');
  if (typeof rec.access !== 'string' || !rec.access) errors.push('access: required string');
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

// 判断某条记忆对 requester 是否可见（隐私隔离核心）。
// requester === 'self' 表示鱼自己（可看全部）；否则按 access 匹配。
export function visibleTo(rec, requester) {
  if (requester === 'self') return true;
  const a = rec.access;
  if (a === 'public') return true;
  if (a === `private:${requester}`) return true;
  if (a === `conversation:${requester}`) return true;
  if (a.startsWith('group:')) {
    return (rec.peers || []).includes(requester);
  }
  return false;
}
