// id 是平台原始标识；key 是本项目内部使用的、带命名空间的稳定标识。
export function normalizeId(value, field = 'id') {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.trim() === value) return value;
  throw new TypeError(`${field}: expected a non-empty string or safe integer`);
}

function part(value, field) {
  return encodeURIComponent(normalizeId(value, field));
}

export function entityKey(platform, kind, id) {
  if (!['account', 'user', 'group'].includes(kind)) throw new TypeError('unknown entity kind');
  return `${part(platform, 'platform')}:${kind}:${part(id, 'id')}`;
}

export function conversationKey(platform, accountId, kind, targetId) {
  if (!['private', 'group'].includes(kind)) throw new TypeError('unknown conversation kind');
  return `${entityKey(platform, 'account', accountId)}:conversation:${kind}:${part(targetId, 'targetId')}`;
}

export function messageKey(conversation, id) {
  return `${normalizeId(conversation, 'conversationKey')}:message:${part(id, 'messageId')}`;
}
