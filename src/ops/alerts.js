// 出问题时提醒你（Module 10，见 docs/module-10-deploy-design.md 第 8 节“提醒怎么做”）。
// alert 服务每 5 分钟查一遍下面这几件事，自己查、不靠奶蛙进程；有新问题或者好了，就 QQ 私聊你的主号、用 Bark 推到手机。
// 这里是判断和发送，循环在 scripts/alert-check.mjs。提醒的话里不带群号、QQ 号和聊天内容（推送会经过第三方）。
import { BACKUP_STALE_MS } from './backups.js';

const MIN = 60_000;
export const ALERT_DEFAULTS = { everyMs: 5 * MIN, graceMs: 5 * MIN, balanceCny: 50 };

const pad = (n) => String(n).padStart(2, '0');
// 北京时间：今天的写“13:50”，别的日子写“11-25 13:50”。
export function when(ms, now) {
  const b = (x) => new Date(x + 8 * 3_600_000);
  const d = b(ms);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return d.toISOString().slice(0, 10) === b(now).toISOString().slice(0, 10) ? time : `${d.toISOString().slice(5, 10)} ${time}`;
}

/**
 * 把查到的情况变成“检查结果”。每项：
 *   key    哪件事；bad true 有问题 / false 没问题 / null 这次查不了（状态不变）
 *   since  问题从什么时候开始（不知道就用第一次查到的时间）
 *   grace  问题持续多久才提醒（毫秒）
 *   text(since) 提醒的话；okText(now) 好了以后说的话（没有就不说）
 *
 * @param {object} seen
 * @param {{online: boolean}|null|undefined} seen.qq SnowLuma 的 get_status；null 表示 SnowLuma 没响应；undefined 没查
 * @param {object|null|undefined} seen.bot Module 9 readStatus() 的结果；null 表示数据库连不上
 * @param {{latest: object|null, drill: object|null}} [seen.backups]
 * @param {{spent: number, budget: number}|null} [seen.budget]
 * @param {{available: boolean, totalCny: number}|null} [seen.balance] null 表示没查到
 * @param {number} [seen.balanceCny] 余额低于多少提醒
 */
export function checkResults(seen, now = Date.now()) {
  const grace = ALERT_DEFAULTS.graceMs;
  const r = [];
  // QQ 小号：直接问 SnowLuma。
  if (seen.qq !== undefined) {
    r.push({
      key: 'snowluma_down', bad: seen.qq === null, grace,
      text: (since) => `⚠ 奶蛙：${when(since, now)} 起 SnowLuma 没响应，QQ 小号的状态查不到。看看 SnowLuma 容器还在不在`,
      okText: () => '✓ 奶蛙：SnowLuma 又有响应了',
    });
    r.push({
      key: 'qq_offline', bad: seen.qq ? !seen.qq.online : null, grace,
      text: (since) => `⚠ 奶蛙：QQ 小号 ${when(since, now)} 起离线，去 noVNC 重新扫码`,
      okText: (t) => `✓ 奶蛙：QQ 小号 ${when(t, now)} 恢复在线`,
    });
  }
  // 奶蛙：Module 9 的心跳表。数据库连不上时这两项查不了。
  if (seen.bot !== undefined) {
    const s = seen.bot;
    r.push({
      key: 'db_down', bad: s === null, grace,
      text: (since) => `⚠ 奶蛙：${when(since, now)} 起连不上数据库，奶蛙也跑不了。看看 db 容器`,
      okText: () => '✓ 奶蛙：数据库又连上了',
    });
    r.push({
      key: 'bot_dead', bad: s ? s.state === 'unresponsive' : null, grace,
      since: s?.heartbeatAt?.getTime?.(),
      text: (since) => `⚠ 奶蛙：${when(since, now)} 起意外停了，没有自己起来（不是用命令停的）`,
      okText: () => '✓ 奶蛙：又跑起来了',
    });
    const disconnected = s ? (s.state === 'running' ? !s.onebot.connected : false) : null;
    r.push({
      key: 'bot_disconnected', bad: disconnected, grace,
      since: s?.onebot?.since?.getTime?.() ?? s?.startedAt?.getTime?.(),
      text: (since) => `⚠ 奶蛙：${when(since, now)} 起连不上 SnowLuma，群里叫它都没用`,
      okText: () => '✓ 奶蛙：又连上 SnowLuma 了',
    });
  }
  // 备份：一天半没有新的，或者最近一次的恢复演练失败。启动后给 30 分钟做第一次备份。
  if (seen.backups) {
    const { latest, drill } = seen.backups;
    r.push({
      key: 'backup_stale', bad: !latest || now - latest.at > BACKUP_STALE_MS, grace: 30 * MIN,
      since: latest ? latest.at + BACKUP_STALE_MS : undefined,
      text: () => (latest ? `⚠ 奶蛙：最近一次备份是 ${when(latest.at, now)}，超过一天半没有新备份了。看看 backup 容器` : '⚠ 奶蛙：还没有备份。看看 backup 容器'),
      okText: () => '✓ 奶蛙：又有新备份了',
    });
    const drillFailed = Boolean(latest && drill && drill.file === latest.file && !drill.ok);
    r.push({
      key: 'drill_failed', bad: drillFailed, grace: 0,
      text: () => `⚠ 奶蛙：最近一次备份（${when(latest.at, now)}）恢复演练失败，这份备份可能用不了`,
      okText: () => '✓ 奶蛙：最新的备份恢复演练通过了',
    });
  }
  // 今天的花费到了上限（奶蛙自己定的每日上限，零点自动恢复）。
  if (seen.budget !== undefined) {
    const b = seen.budget;
    r.push({
      key: 'budget', bad: b ? b.budget > 0 && b.spent >= b.budget : null, grace: 0,
      text: () => `⚠ 奶蛙：今天花到 ${b.budget} 元上限了，零点前只回固定提示。要多给可以 naiwa budget set`,
      okText: () => '✓ 奶蛙：花费上限恢复了（新的一天或者调高了上限）',
    });
  }
  // DeepSeek 账户余额（真的没钱了，要去充值）。
  if (seen.balance !== undefined) {
    const b = seen.balance;
    const empty = b ? !b.available || b.totalCny <= 0 : null;
    r.push({
      key: 'balance_empty', bad: empty, grace: 0,
      text: () => '⚠ 奶蛙：DeepSeek 余额用完了，奶蛙现在只回固定提示，充值后自动恢复',
      okText: null, // 好了由下面“余额低”那一项说
    });
    r.push({
      key: 'balance_low', bad: b ? b.totalCny < (seen.balanceCny ?? ALERT_DEFAULTS.balanceCny) : null, grace: 0,
      text: () => (empty ? '⚠ 奶蛙：DeepSeek 余额不到 ¥1 了，记得充值' : `⚠ 奶蛙：DeepSeek 余额只剩 ¥${b.totalCny.toFixed(2)}，记得充值`),
      okText: () => `✓ 奶蛙：DeepSeek 余额恢复到 ¥${b.totalCny.toFixed(2)}`,
    });
  }
  return r;
}

/**
 * 对照上一次的状态，决定这次要说什么。同一件事只提醒一次，好了再说一声。
 * @param {Record<string, {badSince: number, notified: boolean}>} state 上一次的状态（会被复制，不改原对象）
 * @returns {{state: object, messages: {key: string, text: string}[]}} messages 发出去以后，调用方再用 markSent 记下已提醒
 */
export function decide(state, results, now = Date.now()) {
  const next = structuredClone(state ?? {});
  const messages = [];
  for (const res of results) {
    const entry = next[res.key];
    if (res.bad === null || res.bad === undefined) continue; // 这次查不了，不动
    if (res.bad) {
      const e = entry ?? (next[res.key] = { badSince: res.since ?? now, notified: false });
      if (!e.notified && now - e.badSince >= res.grace) messages.push({ key: res.key, text: res.text(e.badSince), kind: 'alert' });
    } else if (entry) {
      if (entry.notified && res.okText) messages.push({ key: res.key, text: res.okText(now), kind: 'ok' });
      delete next[res.key];
    }
  }
  return { state: next, messages };
}

// 至少一路发出去了：把这些提醒记成“已提醒”。都没发出去就不记，下一轮再发。
export function markSent(state, messages) {
  for (const m of messages) if (m.kind === 'alert' && state[m.key]) state[m.key].notified = true;
  return state;
}

// ---------- 查 ----------

/**
 * 开一条临时的 WebSocket 连 SnowLuma，调一个 OneBot 动作，拿到结果就断开。
 * 不和奶蛙共用连接：奶蛙停了也能查、也能发。
 */
export function oneBotCall({ url, token, action, params = {}, timeoutMs = 8_000, WebSocketImpl = globalThis.WebSocket }) {
  return new Promise((resolve, reject) => {
    const sep = url.includes('?') ? '&' : '?';
    const ws = new WebSocketImpl(token ? `${url}${sep}access_token=${encodeURIComponent(token)}` : url);
    const echo = `alert-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const done = (fn, value) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已经断了 */ }
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error('SnowLuma 没有回应')), timeoutMs);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ action, params, echo })));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.echo !== echo) return; // 别的事件（群消息、心跳）不管
      if (msg.status === 'ok' || msg.retcode === 0) done(resolve, msg.data);
      else done(reject, new Error(`SnowLuma 返回失败（retcode ${msg.retcode}）`));
    });
    ws.addEventListener('error', () => done(reject, new Error('连不上 SnowLuma')));
  });
}

// DeepSeek 账户余额（人民币）。
export async function deepseekBalance({ apiKey, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const res = await fetchImpl('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`余额接口返回 HTTP ${res.status}`);
  const body = await res.json();
  const cny = (body.balance_infos ?? []).find((b) => b.currency === 'CNY');
  return { available: Boolean(body.is_available), totalCny: Number(cny?.total_balance ?? 0) };
}

// Bark：填的是 App 里显示的地址（https://api.day.app/<key>/…），只取到 key 为止。
export function barkEndpoint(raw) {
  const u = new URL(raw);
  const key = u.pathname.split('/').filter(Boolean)[0];
  if (!key) throw new Error('ALERT_BARK_URL 里没有 key，应该像 https://api.day.app/xxxxxxxx');
  return `${u.origin}/${key}`;
}

export async function sendBark({ url, text, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const res = await fetchImpl(barkEndpoint(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ title: '奶蛙', body: text, group: 'naiwa' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Bark 返回 HTTP ${res.status}`);
}
