#!/usr/bin/env node
// 群聊冒烟模拟：把 QQ 冒烟检查里要两个人配合的几步（docs/module-07b-burst-merge-design.md 第 11 节）自动跑一遍。
// 两个虚构的群友“小甲”“小乙”按真实的时间间隔说话，走真正的处理器和真模型（DeepSeek），
// 等待时间（停 7 秒、只 @ 等 8 秒、留意 30 秒）都和线上一样。只有 QQ 这一头是假的：消息不经过 QQ，发出去的回复记在这里。
// 跑完打印每段的对话记录和自动检查结果。
// 用法：npm run sim:group（需要 .env 里的 DEEPSEEK_API_KEY）。几段同时跑，约 1～2 分钟，花费约 ¥0.1，按官方价格估算。
// 和线上的不同：不联网搜索（线上开着，但这些问题用不到）。用进程内数据库（PGlite），不碰线上数据。对话都是虚构的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fish, MemoryInbox, openTestStorage, createLogger, EMPTY_MENTION_REPLY } from '../src/index.js';
import { createQQHandler } from '../src/qq-handler.js';
import { DeepSeekBrain } from '../src/model/brain.js';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const persona = readFileSync(join(root, 'persona', 'naiwa.md'), 'utf8');
const socialRules = readFileSync(join(root, 'persona', 'social-rules.md'), 'utf8');
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro';
let totalCny = 0;
const ledger = { record: async ({ costCny }) => { totalCny += costCny; }, day: async () => ({ costCny: 0, calls: 0, unknownCalls: 0 }) };
// 模型每次调用用了多久（按会话分开记），打印出来，区分“等人说完”和“模型想得慢”。
const modelMs = new Map();
const brainLogger = createLogger({
  level: 'info', format: 'json',
  write: (_line, _level, record) => {
    if (record.event !== 'model.done' || !record.messageKey) return;
    const conversation = record.messageKey.replace(/:message:.*$/, '');
    modelMs.set(conversation, [...(modelMs.get(conversation) ?? []), record.ms]);
  },
});
const brain = new DeepSeekBrain({ apiKey, model, webSearch: false, ledger, logger: brainLogger });

const SELF = 900;
const PEOPLE = { 小甲: 101, 小乙: 102 };
const NAMES = Object.fromEntries(Object.entries(PEOPLE).map(([name, qq]) => [qq, name]));
// 写对话时用 @奶蛙、@小乙，发给处理器时换成 QQ 的 @。
const toCQ = (text) => text.replace(/@奶蛙/g, `[CQ:at,qq=${SELF}]`).replace(/@(小甲|小乙)/g, (_, name) => `[CQ:at,qq=${PEOPLE[name]}]`);
const has = (text, re) => re.test(text ?? '');
const NAME_IN_REPLY = /奶蛙/; // 别人没提这个梗，回复里不该自己提

// timeline：[第几秒, 谁, 说什么]；tail：最后一句以后再等几秒。
// checks(r)：返回 [[通过没有, 说明], …]。r.sent：发出的回复；r.msg(i)：第 i 句（从 1 数）的处理结果；r.calls：调用模型几次。
const SCENARIOS = [
  {
    step: 1, name: '@ 奶蛙连发三句，每句隔 4 秒（打字慢）',
    timeline: [[0, '小甲', '@奶蛙 推荐个奶茶'], [4, '小甲', '不要太甜'], [8, '小甲', '要大杯']],
    tail: 20,
    checks: (r) => [
      [r.sent.length === 1, `只回一次（实际 ${r.sent.length} 次）`],
      [has(r.sent[0]?.text, /甜|糖/) && has(r.sent[0]?.text, /大杯|大/), '照顾到“不要太甜”和“要大杯”'],
      [!r.sent.some((s) => NAME_IN_REPLY.test(s.text)), '回复里没有自己提“奶蛙”'],
    ],
  },
  {
    step: 2, name: '两个人同时 @ 奶蛙问不同的事',
    timeline: [[0, '小甲', '@奶蛙 推荐个奶茶'], [1, '小乙', '@奶蛙 你会唱歌吗']],
    tail: 20,
    checks: (r) => [
      [r.sent.length === 2, `分别回了两条（实际 ${r.sent.length} 条）`],
      [r.sent.some((s) => s.quote?.who === '小甲') && r.sent.some((s) => s.quote?.who === '小乙'), '两条各引用对应那个人的话，看得出各回谁'],
      [r.calls === 1, `两个人一起看，只调一次模型（实际 ${r.calls} 次）`],
      [!r.sent.some((s) => NAME_IN_REPLY.test(s.text)), '回复里没有自己提“奶蛙”'],
    ],
  },
  {
    step: 3, name: '奶蛙回了以后不 @ 接着问；接着 @ 别人；之后不 @ 它',
    timeline: [[0, '小甲', '@奶蛙 推荐个奶茶'], [15, '小甲', '大杯的有吗'], [30, '小甲', '@小乙 你喝过没'], [45, '小甲', '那家店在哪']],
    tail: 15,
    checks: (r) => [
      [r.msg(1).replied, '@ 它问的：回了'],
      [r.msg(2).replied, '不 @ 接着问（还在留意的 30 秒里）：回了'],
      [r.msg(3).looked && !r.msg(3).replied, `@ 别人说的：模型看了，没回（实际：${r.msg(3).label}）`],
      [!r.msg(4).looked, `之后不 @ 它说的：不再看（实际：${r.msg(4).label}）`],
    ],
  },
  {
    step: 4, name: '只 @ 不说话',
    timeline: [[0, '小甲', '@奶蛙']],
    tail: 12,
    checks: (r) => [
      [r.sent.length === 1 && r.sent[0].text === EMPTY_MENTION_REPLY, `回了“${EMPTY_MENTION_REPLY}”`],
      [r.sent[0]?.at >= 8, `等了 8 秒才回（实际第 ${r.sent[0]?.at.toFixed(1)} 秒）`],
      [r.calls === 0, '不调用模型'],
    ],
  },
  {
    step: 4, name: '只 @，2 秒后补了问题',
    timeline: [[0, '小甲', '@奶蛙'], [2, '小甲', '推荐个奶茶']],
    tail: 15,
    checks: (r) => [
      [r.sent.length === 1 && r.sent[0].text !== EMPTY_MENTION_REPLY, `只回补的那句，不发“${EMPTY_MENTION_REPLY}”`],
    ],
  },
  {
    step: 4, name: '小甲只 @ 不说话的同时，小乙 @ 奶蛙问事',
    timeline: [[0, '小甲', '@奶蛙'], [1, '小乙', '@奶蛙 讲个冷笑话']],
    tail: 15,
    checks: (r) => {
      const joke = r.sent.find((s) => s.text !== EMPTY_MENTION_REPLY);
      const empty = r.sent.find((s) => s.text === EMPTY_MENTION_REPLY);
      return [
        // 小乙第 1 秒说完，停 7 秒就该开始看（第 8 秒左右），不因为小甲在等补话而多等。
        [r.callStarts[0] < 9, `小乙停了 7 秒就开始看，不等小甲（第 ${r.callStarts[0]?.toFixed(1) ?? '-'} 秒开始调用模型）`],
        [Boolean(joke), '小乙被回了'],
        // 小乙那一轮和“干嘛蛙”都在第 8 秒左右到点，谁先发都行。
        [empty && empty.at >= 8, `小甲 8 秒没说话，回了“${EMPTY_MENTION_REPLY}”（第 ${empty?.at.toFixed(1) ?? '-'} 秒）`],
      ];
    },
  },
  {
    step: 5, name: '先说“哈哈”，再 @ 奶蛙问奶茶、紧接着说“不要太甜”',
    timeline: [[0, '小甲', '哈哈'], [5, '小甲', '@奶蛙 喝什么奶茶'], [6, '小甲', '不要太甜']],
    tail: 15,
    checks: (r) => [
      [r.sent.length === 1, `只回一次（实际 ${r.sent.length} 次）`],
      [has(r.sent[0]?.text, /甜|糖/), '照顾到“不要太甜”'],
      [!r.msg(1).looked, '“哈哈”不用接（没请模型看这一句）'],
      [!r.sent.some((s) => NAME_IN_REPLY.test(s.text)), '回复里没有自己提“奶蛙”'],
    ],
  },
];

const db = await openTestStorage();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(scenario, index) {
  const group = 300 + index;
  const inbox = new MemoryInbox();
  const logs = [];
  const logger = createLogger({ level: 'info', format: 'json', write: (_line, _level, record) => logs.push(record) });
  const said = []; // [{ id, who, text, at }]
  const sent = []; // [{ at, text, quote }]
  let calls = 0;
  const callStarts = [];
  let t0 = 0;
  const elapsed = () => (Date.now() - t0) / 1000;
  const client = {
    sendGroupMsg: async (_id, message) => {
      const text = message.find((s) => s.type === 'text')?.data.text ?? '';
      const quoted = message.find((s) => s.type === 'reply')?.data.id;
      const quote = quoted ? said.find((m) => String(m.id) === String(quoted)) ?? null : null;
      sent.push({ at: elapsed(), text, quote });
      return { message_id: 80000 + sent.length };
    },
  };
  const handle = createQQHandler({
    fish: await Fish.open({ db, tenantId: `sim-${index}-${Date.now()}` }),
    brain: {
      chat: (messages, opts) => {
        calls += 1;
        callStarts.push(elapsed());
        return brain.chat(messages, { ...opts, webSearch: false });
      },
    },
    getClient: () => client, persona, socialRules, inbox, logger,
  });
  t0 = Date.now();
  const pending = [];
  for (const [at, who, text] of scenario.timeline) {
    await sleep(Math.max(0, t0 + at * 1000 - Date.now()));
    const id = said.length + 1;
    said.push({ id, who, text, at: elapsed() });
    pending.push(handle({
      post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: SELF, user_id: PEOPLE[who], group_id: group,
      message_id: id, time: Math.floor(Date.now() / 1000), sender: { nickname: who }, message: toCQ(text),
    }));
  }
  await sleep(scenario.tail * 1000);
  // 停止接收新消息，等手上的（包括排在后面的“干嘛蛙”）都处理完。
  await handle.stop(120_000);
  await Promise.allSettled(pending);
  const records = new Map();
  for (const m of said) records.set(m.id, await inbox.get(`qq:account:${SELF}:conversation:group:${group}:message:${m.id}`));
  const r = {
    sent,
    calls,
    callStarts,
    modelSeconds: (modelMs.get(`qq:account:${SELF}:conversation:group:${group}`) ?? []).map((ms) => (ms / 1000).toFixed(1)),
    warnings: logs.filter((e) => e.level === 'warn' || e.level === 'error').map((e) => e.event),
    msg: (i) => {
      const record = records.get(i);
      const looked = Boolean(record) && !['skipped', 'dropped'].includes(record.status);
      const replied = record?.status === 'replied';
      const label = !record ? '没请模型看' : replied ? '回了' : record.status === 'silent' ? '看了没回' : `${record.status}/${record.outcome}`;
      return { looked, replied, label };
    },
  };
  const results = scenario.checks(r);
  const lines = [
    ...said.map((m) => ({ at: m.at, line: `${m.who}：${m.text}` })),
    ...sent.map((s) => ({ at: s.at, line: `奶蛙${s.quote ? `（引用${s.quote.who}“${s.quote.text}”）` : ''}：${s.text.replace(/\n+/g, ' ⏎ ')}` })),
  ].sort((a, b) => a.at - b.at);
  return { scenario, results, lines, r };
}

console.log(`同时跑 ${SCENARIOS.length} 段，约 1 分钟……\n`);
const outcomes = await Promise.all(SCENARIOS.map((s, i) => run(s, i)));
let total = 0;
let passed = 0;
for (const { scenario, results, lines, r } of outcomes) {
  console.log(`【第 ${scenario.step} 步】${scenario.name}`);
  for (const { at, line } of lines) console.log(`  ${at.toFixed(1).padStart(5)} 秒  ${line}`);
  const took = r.modelSeconds.length ? `，模型每次想了 ${r.modelSeconds.join('、')} 秒` : '';
  console.log(`  调用模型 ${r.calls} 次${took}${r.warnings.length ? `；警告：${[...new Set(r.warnings)].join('、')}` : ''}`);
  for (const [ok, what] of results) {
    total += 1;
    if (ok) passed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${what}`);
  }
  console.log('');
}
await db.close();
console.log(`自动检查 ${total} 项，通过 ${passed} 项；模型 ${model}，花费约 ¥${totalCny.toFixed(3)}（按官方价格估算）`);
process.exitCode = passed === total ? 0 : 1;
