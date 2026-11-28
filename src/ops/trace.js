// 查卡在哪（Module 10，见 docs/module-10-deploy-design.md 第 2、4 节）：读日志文件，把一个群（一个人）在一段时间里
// 说的每一句走到了哪一步、当时奶蛙和 QQ 是什么状态，翻成中文。这里都是纯函数，读文件和数据库在 scripts/trace.mjs。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beijingDay } from '../log.js';

const MIN = 60_000;
const DAY = 86_400_000;
const LOG_FILE = /^([a-z]+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

// ---------- 时间 ----------

// 北京时间的“年-月-日 时:分”对应的时刻。
function beijingAt(day, hh = 0, mm = 0) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh - 8, mm);
}

const pad = (n) => String(n).padStart(2, '0');
function beijingParts(ms) {
  const d = new Date(ms + 8 * 3_600_000);
  return { day: d.toISOString().slice(0, 10), hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`, s: pad(d.getUTCSeconds()) };
}
// 今天的只写时分秒，别的日子带上月-日。
export function clock(ms, now) {
  const p = beijingParts(ms);
  const time = `${p.hm}:${p.s}`;
  return p.day === beijingDay(now) ? time : `${p.day.slice(5)} ${time}`;
}
const hm = (ms) => beijingParts(ms).hm;

function sinceText(ms) {
  const mins = Math.round(ms / MIN);
  if (mins < 60) return `${Math.max(mins, 1)} 分钟`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} 小时 ${mins % 60} 分钟` : `${h} 小时`;
}

// ---------- 参数 ----------

/**
 * 解析命令参数：
 *   （什么都不写）               整体情况
 *   群 <群号> [QQ <号码>] [日期] [时间]
 *   私聊 <号码> [日期] [时间]
 *   <messageKey>                 一条消息的全部日志
 * 日期：今天、昨天、前天、11-25、2026-11-25；时间：14:05。
 * 有时间：前后 10 分钟；只有日期：那一整天；都没有：最近 30 分钟。
 */
export function parseArgs(argv, now = Date.now()) {
  const q = { mode: 'overview', kind: null, target: null, qq: null };
  let day = null;
  let time = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]).trim();
    const next = () => {
      const v = argv[++i];
      if (!/^\d+$/.test(String(v ?? ''))) throw new Error(`“${a}”后面要跟号码`);
      return String(v);
    };
    if (a === '群') [q.mode, q.kind, q.target] = ['conversation', 'group', next()];
    else if (a === '私聊') [q.mode, q.kind, q.target] = ['conversation', 'private', next()];
    else if (/^qq$/i.test(a)) q.qq = next();
    else if (a.includes(':message:')) [q.mode, q.messageKey] = ['message', a];
    else if (a === '今天') day = beijingDay(now);
    else if (a === '昨天') day = beijingDay(now - DAY);
    else if (a === '前天') day = beijingDay(now - 2 * DAY);
    else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(a)) day = a.split('-').map((x, j) => (j ? pad(x) : x)).join('-');
    else if (/^\d{1,2}-\d{1,2}$/.test(a)) {
      const [m, d] = a.split('-').map(Number);
      const year = Number(beijingDay(now).slice(0, 4));
      day = `${year}-${pad(m)}-${pad(d)}`;
      if (day > beijingDay(now)) day = `${year - 1}-${pad(m)}-${pad(d)}`; // 1 月查 12 月的
    } else if (/^\d{1,2}:\d{2}$/.test(a)) time = a.split(':').map(Number);
    else throw new Error(`看不懂“${a}”`);
  }
  if (q.qq && q.kind === 'private') throw new Error('私聊不用再写 QQ：私聊 <号码> 就是他');
  if (q.qq && q.mode !== 'conversation') throw new Error('QQ 要和“群 <群号>”一起用');
  if (time) {
    const at = beijingAt(day ?? beijingDay(now), time[0], time[1]);
    [q.from, q.to] = [at - 10 * MIN, at + 10 * MIN];
  } else if (day) [q.from, q.to] = [beijingAt(day), beijingAt(day) + DAY];
  else [q.from, q.to] = [now - 30 * MIN, now];
  return q;
}

// ---------- 读日志 ----------

/**
 * 读日志目录里日期不晚于 to 那天的所有文件（最多也就 14 天），按时间排好。坏行跳过。
 * @returns {{records: object[], oldestDay: string|null}}
 */
export function readLogs(dir, { to = Date.now() } = {}) {
  if (!dir || !existsSync(dir)) return { records: [], oldestDay: null };
  const lastDay = beijingDay(to);
  const files = readdirSync(dir).map((name) => [name, LOG_FILE.exec(name)]).filter(([, m]) => m && m[2] <= lastDay);
  const records = [];
  for (const [name] of files) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        const ms = Date.parse(r.ts);
        if (Number.isFinite(ms)) records.push({ ...r, ms });
      } catch {
        // 写到一半的行
      }
    }
  }
  records.sort((a, b) => a.ms - b.ms);
  const days = files.map(([, m]) => m[2]).sort();
  return { records, oldestDay: days[0] ?? null };
}

// messageKey → { kind: 'group'|'private', target }
export function conversationOf(messageKey) {
  const m = /:conversation:(group|private):([^:]+):message:/.exec(String(messageKey ?? ''));
  return m ? { kind: m[1], target: decodeURIComponent(m[2]) } : null;
}
const qqOf = (personKey) => /^qq:user:(.+)$/.exec(String(personKey ?? ''))?.[1] ?? null;

// ---------- 当时的状态 ----------

const STOP_EVENTS = {
  'bot.stopping': '奶蛙正常退出',
  'bot.run_lock_lost': '奶蛙因数据库断开退出',
  'bot.force_exit': '奶蛙被强制退出',
};

/**
 * 按时间走一遍日志，得到状态变化（奶蛙启动/退出、和 SnowLuma 连上/断开、QQ 小号离线/恢复）。
 * 两次启动之间没有退出记录，就是意外退出（崩溃、被强杀、Docker 被关）：记在上一次启动以后最后一行日志的时间。
 * @returns {{changes: {ms: number, what: string, text: string, bad?: boolean}[], stateAt: (ms: number) => object}}
 */
export function statusTimeline(records) {
  const changes = [];
  const snapshots = [];
  const s = { bot: 'unknown', onebot: 'unknown', qq: 'unknown', botSince: null, onebotSince: null, qqSince: null };
  let lastMs = null;
  const push = (ms, what, text, bad = false) => changes.push({ ms, what, text, bad });
  const snap = (ms) => snapshots.push({ ms, ...s });
  for (const r of records) {
    if (r.event === 'bot.started') {
      if (s.bot === 'running') {
        push(lastMs, 'bot', `奶蛙意外退出（最后一行日志在这时）`, true);
        Object.assign(s, { bot: 'stopped', botSince: lastMs, onebot: 'unknown', qq: 'unknown' });
        snap(lastMs);
      }
      push(r.ms, 'bot', `奶蛙启动${r.version ? `（版本 ${r.version}）` : ''}`);
      Object.assign(s, { bot: 'running', botSince: r.ms, onebot: 'connecting', onebotSince: r.ms, qq: 'unknown' });
    } else if (STOP_EVENTS[r.event] && s.bot !== 'stopped') {
      push(r.ms, 'bot', STOP_EVENTS[r.event], r.event !== 'bot.stopping');
      Object.assign(s, { bot: 'stopped', botSince: r.ms, onebot: 'unknown', qq: 'unknown' });
    } else if (r.event === 'onebot.connected') {
      if (s.onebot !== 'connected') push(r.ms, 'onebot', '连上 SnowLuma');
      Object.assign(s, { onebot: 'connected', onebotSince: r.ms });
      if (s.qq !== 'offline') Object.assign(s, { qq: 'online', qqSince: r.ms });
    } else if ((r.event === 'onebot.disconnected' || r.event === 'onebot.connect_failed' || r.event === 'onebot.unresponsive')
      && s.onebot === 'connected') {
      push(r.ms, 'onebot', '⚠ 和 SnowLuma 断开，在重连', true);
      Object.assign(s, { onebot: 'disconnected', onebotSince: r.ms });
    } else if (r.event === 'onebot.bot_offline' && s.qq !== 'offline') {
      push(r.ms, 'qq', '⚠ QQ 小号离线', true);
      Object.assign(s, { qq: 'offline', qqSince: r.ms });
    } else if (r.event === 'onebot.bot_online' && s.qq !== 'online') {
      push(r.ms, 'qq', 'QQ 小号恢复在线');
      Object.assign(s, { qq: 'online', qqSince: r.ms });
    } else {
      if (r.ms !== undefined) lastMs = r.ms;
      continue;
    }
    lastMs = r.ms;
    snap(r.ms);
  }
  const stateAt = (ms) => {
    let found = { bot: 'unknown', onebot: 'unknown', qq: 'unknown' };
    for (const x of snapshots) {
      if (x.ms > ms) break;
      found = x;
    }
    return found;
  };
  return { changes, stateAt, lastMs };
}

// 一段时间开始时的状态，用一句话说。
function stateSentence(st) {
  if (st.bot === 'unknown') return '日志里看不出那时奶蛙在不在跑';
  if (st.bot === 'stopped') return '奶蛙没在跑';
  const parts = ['奶蛙在跑'];
  parts.push({ connected: '连着 SnowLuma', disconnected: '⚠ 和 SnowLuma 断开着', connecting: '正在连 SnowLuma' }[st.onebot] ?? '');
  parts.push({ online: 'QQ 小号在线', offline: '⚠ QQ 小号离线' }[st.qq] ?? '');
  return parts.filter(Boolean).join(' · ');
}

// ---------- 每句话走到了哪一步 ----------

const IGNORED = {
  not_addressed: '没叫奶蛙（不是 @、不是引用它、没用“奶蛙”开头，也不在留意中）→ 不看',
  group_off: '这个群当时设成了“不说话” → 不看',
  at_only: '这个群当时设成了“只回 @”，他没 @ → 不看',
  ignored_user: '他在不理名单里（naiwa ignore）→ 不看',
  person_cap: '他短时间内被回得太多，暂时不理（防两个机器人互相刷屏）',
  shutting_down: '奶蛙正在退出 → 没处理',
};
const TRIGGERS = {
  mention: '@ 了奶蛙',
  quote: '引用了奶蛙的话',
  name: '用名字开头叫了奶蛙',
  follow_up: '在留意中',
  private: '私聊',
  empty_mention: '只 @ 不说话',
  after_empty_mention: '@ 以后补了一句',
  member: '这一轮里接着说的',
};
const ERRORS = {
  INSUFFICIENT_BALANCE: 'DeepSeek 账户余额不足',
  AUTH: 'DeepSeek key 不对',
  TIMEOUT: '模型超时',
  NETWORK: '连不上模型服务',
  RATE_LIMITED: 'DeepSeek 限流',
  SERVER_ERROR: 'DeepSeek 出错',
  EMPTY: '模型没给出能发的回复',
  BAD_RESPONSE: '模型返回的数据看不懂',
  BAD_REQUEST: '请求被 DeepSeek 拒绝',
  QUEUE_FULL: '排队的太多',
  QUEUE_TIMEOUT: '排队太久',
  NOT_CONNECTED: '没连上 SnowLuma',
};
const DELIVERY = { not_sent: '肯定没发出', unknown: '可能已经发出' };
const sec = (ms) => `${(ms / 1000).toFixed(1)} 秒`;

function outcomeText(done) {
  const err = ERRORS[done.errorCode] ?? done.errorCode;
  switch (done.outcome) {
    case 'replied': return `${done.replyMs ? `模型 ${sec(done.replyMs)} → ` : ''}发出 ✓`;
    case 'fixed_reply': return '回了“干嘛蛙” ✓';
    case 'model_silent': return '模型看了，觉得不用回 → 不出声';
    case 'group_off': return '这个群这时设成了“不说话” → 不出声';
    case 'budget_exceeded': return '今天的模型花费到了上限 → 发了固定提示（没人明确叫它时不出声）';
    case 'rate_limited': return '这个会话调用太频繁 → 发了固定提示';
    case 'rate_limited_silent': return '这个会话调用太频繁 → 不出声';
    case 'filtered': return '模型按内容安全策略拒绝 → 发了婉拒提示';
    case 'fallback': return `${err ? `${err} → ` : '生成失败 → '}发了固定提示`;
    case 'judge_failed': return `${err ? `${err} → ` : '生成失败 → '}不出声`;
    case 'send_failed': return `发送没成功：${err ?? '原因不明'}，${DELIVERY[done.delivery] ?? '不知道发没发出'}`;
    default: return `结果：${done.outcome}${err ? `（${err}）` : ''}`;
  }
}

/** 一条消息的几行日志 → 一句话。 */
export function describeMessage(recs) {
  const by = (event) => recs.find((r) => r.event === event);
  const ignored = by('message.ignored');
  if (ignored) return IGNORED[ignored.reason] ?? `不看（${ignored.reason}）`;
  const steps = [];
  const accepted = by('message.accepted');
  const waiting = by('message.waiting');
  if (accepted) steps.push(TRIGGERS[accepted.trigger] ?? accepted.trigger);
  else if (waiting) steps.push('只 @ 不说话 → 等他补话');
  const round = recs.find((r) => r.event === 'round.started');
  if (round) steps.push(`${hm(round.ms)}:${beijingParts(round.ms).s} 开始看`);
  const done = by('message.done');
  const skipped = by('message.skipped');
  const dropped = by('message.dropped');
  if (done) steps.push(outcomeText(done));
  else if (skipped) steps.push(skipped.reason === 'stale' ? '收到时已经太旧（奶蛙停着时积下的）→ 不回' : '并到了下一句');
  else if (dropped) steps.push(dropped.reason === 'stale' ? '排队太久 → 不回了' : '排队的太多 → 没处理');
  else if (by('message.merged')) steps.push('又只 @ 了一下 → 并到下一句');
  else if (by('message.voided')) steps.push('模型刚看过他、没回他 → 这句不看了');
  else if (by('message.failed')) steps.push('处理时出了意外错误');
  else if (by('message.duplicate') && steps.length === 0) steps.push('重复收到 → 跳过');
  else steps.push('还没有结果（还在处理，或者处理到一半奶蛙退出了）');
  return steps.join(' → ');
}

// ---------- 报告 ----------

/**
 * 一个群（一个人）在一段时间里的报告。
 * @param {object} q parseArgs 的结果（mode = conversation）
 * @param {{records: object[], oldestDay: string|null}} logs
 * @param {number} now
 * @returns {string[]} 一行一项
 */
export function conversationReport(q, { records, oldestDay }, now = Date.now()) {
  const lines = [];
  const where = q.kind === 'group' ? `群 ${q.target}` : `私聊 ${q.target}`;
  const range = `${clock(q.from, now)}～${clock(q.from < now && q.to > now ? now : q.to, now)}`;
  if (!oldestDay || beijingDay(q.to) < oldestDay) {
    lines.push(`当时（${range}）：没有日志。日志只留 14 天${oldestDay ? `，现在最早的是 ${oldestDay}` : '，日志目录里还什么都没有'}`);
    return lines;
  }
  const { changes, stateAt } = statusTimeline(records);
  const inside = changes.filter((c) => c.ms >= q.from && c.ms < q.to);
  const startState = stateAt(q.from);
  lines.push(`当时（${range}）：${stateSentence(startState)}${inside.length ? '，期间：' : ''}`);
  for (const c of inside) lines.push(`  ${clock(c.ms, now)}  ${c.text}`);

  // 这个会话的消息：按 messageKey 分组，第一行的时间就是收到的时间。
  const groups = new Map();
  for (const r of records) {
    if (!r.messageKey || r.ms < q.from - 5 * MIN || r.ms >= q.to + 5 * MIN) continue;
    const conv = conversationOf(r.messageKey);
    if (!conv || conv.kind !== q.kind || conv.target !== q.target) continue;
    if (!groups.has(r.messageKey)) groups.set(r.messageKey, []);
    groups.get(r.messageKey).push(r);
  }
  // 轮的日志不带 messageKey，按 round.started 里列的几条挂上去。
  for (const r of records) {
    if (r.event !== 'round.started' || !Array.isArray(r.messageKeys)) continue;
    for (const key of r.messageKeys) groups.get(key)?.push(r);
  }
  const messages = [...groups.values()]
    .map((recs) => recs.sort((a, b) => a.ms - b.ms))
    .filter((recs) => recs[0].ms >= q.from && recs[0].ms < q.to)
    .filter((recs) => !q.qq || qqOf(recs.find((r) => r.sender)?.sender) === q.qq)
    .sort((a, b) => a[0].ms - b[0].ms);

  const who = q.qq ? `${where} 里 QQ ${q.qq}` : where;
  if (messages.length) {
    lines.push(`${who} 说了 ${messages.length} 句：`);
    for (const recs of messages) {
      const speaker = !q.qq && q.kind === 'group' ? `QQ ${qqOf(recs.find((r) => r.sender)?.sender) ?? '?'}  ` : '';
      lines.push(`  ${clock(recs[0].ms, now)}  ${speaker}${describeMessage(recs)}`);
    }
    return lines;
  }
  lines.push(`${who}：这段时间一条都没收到。`);
  lines.push(`原因多半是：${whyNothing(q, records, { changes, stateAt, now })}`);
  return lines;
}

// 查不到消息时，按当时的记录说是哪种情况（设计稿第 2 节例 2 的表）。
// 坏的那一段写真正的起止时间（可能在查询的时间段之外），例如“21:18:05～21:52:40 QQ 小号离线”。
function whyNothing(q, records, { changes, stateAt, now }) {
  const KINDS = [
    { what: 'bot', test: (st) => st.bot === 'stopped', since: (st) => st.botSince, label: '奶蛙没在跑' },
    { what: 'qq', test: (st) => st.bot === 'running' && st.qq === 'offline', since: (st) => st.qqSince, label: 'QQ 小号离线，群消息到不了奶蛙' },
    { what: 'onebot', test: (st) => st.bot === 'running' && st.onebot === 'disconnected', since: (st) => st.onebotSince, label: '奶蛙和 SnowLuma 断开了，一直在重连' },
  ];
  const points = [q.from, ...changes.filter((c) => c.ms > q.from && c.ms < q.to).map((c) => c.ms)];
  const seen = new Set();
  const bad = [];
  for (const ms of points) {
    const st = stateAt(ms);
    const kind = KINDS.find((k) => k.test(st));
    if (!kind) continue;
    const startMs = kind.since(st) ?? ms;
    if (seen.has(`${kind.what}:${startMs}`)) continue;
    seen.add(`${kind.what}:${startMs}`);
    // 好起来的时刻：这之后第一次不再是这种状态。
    const end = changes.find((c) => c.ms > startMs && !kind.test(stateAt(c.ms)));
    bad.push(end ? `${clock(startMs, now)}～${clock(end.ms, now)} ${kind.label}` : `${clock(startMs, now)} 起 ${kind.label}（到现在还没好）`);
  }
  if (bad.length) return bad.join('；');
  const before = records.filter((r) => r.ms < q.from).at(-1);
  const after = records.find((r) => r.ms >= q.to);
  const any = records.some((r) => r.ms >= q.from && r.ms < q.to);
  if (!any) {
    return `这段时间一行日志都没有（上一行是 ${before ? clock(before.ms, now) : '没有'}，下一行是 ${after ? clock(after.ms, now) : '没有'}）。`
      + '奶蛙那时要是在跑，就是群里没人说话；要是群里确实有人说话，可能是 Docker 没开、Mac 在睡眠';
  }
  if (stateAt(q.from).bot === 'running') return '这段时间奶蛙在跑、连接正常，就是没收到这里的消息。多半是群号、时间记错了';
  return '日志里看不出当时的状态';
}

/** 一条消息的全部日志，原样列出来（给排查的人看）。 */
export function messageReport(messageKey, { records }) {
  const recs = records.filter((r) => r.messageKey === messageKey
    || (r.event === 'round.started' && Array.isArray(r.messageKeys) && r.messageKeys.includes(messageKey)));
  if (!recs.length) return [`日志里没有 ${messageKey}`];
  return recs.map(({ ms, ...r }) => JSON.stringify(r));
}

/**
 * 整体情况里“最近 1 小时”和“出问题的”两行。
 */
export function overviewLines({ records }, now = Date.now()) {
  const since = now - 60 * MIN;
  const recent = records.filter((r) => r.ms >= since);
  const firstLines = new Set();
  let groupMessages = 0;
  let replies = 0;
  for (const r of recent) {
    if (r.messageKey && !firstLines.has(r.messageKey)) {
      firstLines.add(r.messageKey);
      if (conversationOf(r.messageKey)?.kind === 'group') groupMessages += 1;
    }
    if (r.event === 'message.done' && (r.outcome === 'replied' || r.outcome === 'fixed_reply')) replies += 1;
  }
  const rounds = recent.filter((r) => r.event === 'round.started').length;
  const lines = [`最近 1 小时：收到 ${groupMessages} 条群消息，请模型看了 ${rounds} 轮，回了 ${replies} 句`];
  const problems = new Map();
  for (const r of recent) {
    if (r.level !== 'warn' && r.level !== 'error') continue;
    if (r.event === 'message.ignored') continue;
    const label = PROBLEM_LABELS[r.event] ?? r.event;
    const p = problems.get(label) ?? { n: 0, last: 0 };
    problems.set(label, { n: p.n + 1, last: r.ms });
  }
  lines.push(problems.size
    ? `出问题的：${[...problems].map(([label, p]) => `${label} ${p.n} 次（最近 ${clock(p.last, now)}）`).join('；')}`
    : '出问题的：没有');
  return lines;
}

const PROBLEM_LABELS = {
  'send.failed': '发送失败',
  'reply.failed': '生成回复失败',
  'model.attempt_failed': '模型调用失败后重试',
  'model.budget_exceeded': '花费到上限',
  'onebot.disconnected': '和 SnowLuma 断开',
  'onebot.connect_failed': '连 SnowLuma 没连上（在重连）',
  'bot.run_lock_lost': '奶蛙因数据库断开退出',
  'alert.not_configured': '提醒服务没设收提醒的地方',
  'alert.balance_failed': '查 DeepSeek 余额失败',
  'onebot.bot_offline': 'QQ 小号离线',
  'onebot.request_timeout': '请求 SnowLuma 超时',
  'message.dropped': '消息没处理（排队太久或太多）',
  'message.done': '有消息没发出去',
  'reply.model_silent': '明确叫它的人模型没回',
  'record.failed': '保存记录失败',
  'alert.send_failed': '提醒没发出去',
};

/**
 * “现在”那一行。
 * @param {object|null} status Module 9 的 readStatus() 结果；null 表示数据库连不上
 * @param {{changes: object[]}} timeline 用来补“QQ 小号在不在线”（心跳表里没有）
 */
export function nowLine(status, timeline, now = Date.now()) {
  if (!status) return '现在：数据库连不上，查不到奶蛙现在的状态（下面是日志里的记录）';
  if (status.state === 'never') return '现在：这个数据库里奶蛙还没跑过';
  if (status.state === 'stopped') return `现在：奶蛙没在跑（${clock(status.stoppedAt.getTime(), now)} 正常退出）`;
  if (status.state === 'unresponsive') {
    return `现在：⚠ 奶蛙没响应（最后一次心跳在 ${clock(status.heartbeatAt.getTime(), now)}，没有正常退出：崩了、被强杀，或者 Docker 没开）`;
  }
  const version = status.code?.commit ? `，版本 ${status.code.commit}` : '';
  const parts = [`现在：奶蛙在跑（${clock(status.startedAt.getTime(), now)} 启动${version}）`];
  const since = status.onebot.since?.getTime();
  parts.push(status.onebot.connected ? '连着 SnowLuma'
    : `⚠ 连不上 SnowLuma${since ? `（${hm(since)} 起，已经 ${sinceText(now - since)}）` : '（启动以后还没连上过）'}`);
  if (status.onebot.connected) {
    const qq = [...timeline.changes].reverse().find((c) => c.what === 'qq' || (c.what === 'onebot' && !c.bad));
    if (qq?.what === 'qq' && qq.bad) {
      parts.push(`⚠ QQ 小号 ${hm(qq.ms)} 起离线（已经 ${sinceText(now - qq.ms)}）：消息收不到也发不出，去 noVNC 重新扫码`);
    } else parts.push('QQ 小号在线');
  }
  return parts.join(' · ');
}
