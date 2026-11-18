// “地方”：事实出自哪里。和会话 key 不同，地方 key 不带机器人账号：换号以后记忆不断。
// - 群：qq:account:900:conversation:group:200 → qq:group:200
// - 私聊：qq:account:900:conversation:private:101 → 对方的 key qq:user:101
// 私聊和群的地方 key 前缀不同（user / group），不会撞上。
// 会话 key 的格式见 src/identity.js：每一段都经过 encodeURIComponent，不含冒号。
const CONVERSATION = /^([^:]+):account:([^:]+):conversation:(private|group):([^:]+)$/;

/**
 * @param {string} conversationKey
 * @returns {{key: string, kind: 'private'|'group'}}
 */
export function placeOf(conversationKey) {
  const match = CONVERSATION.exec(String(conversationKey));
  if (!match) throw new TypeError(`无法识别的会话 key：${conversationKey}`);
  const [, platform, , kind, target] = match;
  return kind === 'group'
    ? { key: `${platform}:group:${target}`, kind: 'group' }
    : { key: `${platform}:user:${target}`, kind: 'private' };
}

const PERSON = /^([^:]+):user:([^:]+)$/;

// 人的 key（qq:user:101）拆成平台和用户号；格式不对返回 null。
export function parsePersonKey(personKey) {
  const match = PERSON.exec(String(personKey));
  return match ? { platform: match[1], id: match[2] } : null;
}
