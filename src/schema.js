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

// 隐私可见性：self / public / private:<peerId> / group:<groupId> / conversation:<conversationKey> / person:<personKey>
// - conversation：只在这个会话里可见（私聊或群聊均可）。
// - private：某个人的私事，只对这个人可见。
// - person：对这个人的印象，“跟着人走”：这个人在任何群或私聊发言时都可以召回，所以只能放群里也能说的内容。
export const scope = {
  SELF: 'self',
  PUBLIC: 'public',
  private: (peerId) => `private:${peerId}`,
  group: (groupId) => `group:${groupId}`,
  conversation: (conversationKey) => `conversation:${conversationKey}`,
  person: (personKey) => `person:${personKey}`,
};

// 运维身份：能看到全部记忆。只给 CLI 的查看、导出、删除这类管理操作用，聊天流程不能用。
// 以 @ 开头，不会和任何会话、用户 key 撞上。
export const OPERATOR = '@operator';

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

// 判断某条记忆对 requester 是否可见（隐私隔离核心）。必须与 src/memory.js 的 visibleSql 保持一致。
// - OPERATOR：运维，看全部。
// - 'self'：鱼自己，只看自我记忆和公开记忆。不再能看全部记录：聊天流程以 self 身份读取时，不能读到任何会话的私有内容。
// - 其他：按 access 匹配会话、个人。
export function visibleTo(rec, requester) {
  if (requester === OPERATOR) return true;
  const a = rec.access;
  if (a === 'public') return true;
  if (requester === 'self') return a === 'self';
  if (a === `private:${requester}`) return true;
  if (a === `conversation:${requester}`) return true;
  if (a === `person:${requester}`) return true;
  if (a.startsWith('group:')) {
    return (rec.peers || []).includes(requester);
  }
  return false;
}
