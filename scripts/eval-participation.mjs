#!/usr/bin/env node
// 群里什么时候说话的效果评测（docs/module-07-group-chat-design.md 第 11 节、module-07b-burst-merge-design.md 第 11 节）：
// 交给模型判断的，该回的回，不该回的不出声；一轮里有好几个人、好几句的，回对人。
// 走真正的处理器：判断规则、攒一轮、群里最近的聊天、提示词都和线上一样；前面几轮用写好的回复，只有最后一轮调用真模型。
// 和线上唯一的不同：一轮停 0.3 秒就开始看（线上 3 秒），评测跑得快一点；同一轮的几句是一起发的，照样攒在一起。
// 用法：npm run eval:participation（需要 .env 里的 DEEPSEEK_API_KEY）。一次约 ¥0.2，按官方价格估算。
// 用进程内数据库（PGlite），不碰线上数据。对话都是虚构的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fish, MemoryInbox, openTestStorage, createLogger } from '../src/index.js';
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
const real = new DeepSeekBrain({ apiKey, model, webSearch: false, ledger });

// 群友 → QQ 号。这里的“甲乙丙丁”只是评测里的叫法，模型看到的代号由程序分配。
const QQ = { 甲: 101, 乙: 102, 丙: 103, 丁: 104 };
const AT_NAIWA = '[CQ:at,qq=900]';
const AT_YI = '[CQ:at,qq=102]';
const IMAGE = '[CQ:image,file=x.jpg]';

// 一轮：几句一起发 [[谁, 内容], …]。
// steps：前面几轮，每轮 { say, reply }；reply 是这一轮奶蛙写好的回复（不调用模型），没有 reply 的是群友之间聊天。
// last：最后一轮，调用真模型。expect：reply（该回）、silent（不该回）、either（都行，只看看）；
//   一轮里有好几个人时按人写：{ 甲: 'reply', 乙: 'silent' }。
// looseCheck：回复里应该照顾到的内容（宽松检查，最好人工再看一眼）。
const SEES_NOTHING = /看不|没看|看不清|没显示|加载|没出来|是啥|什么|啥|？|\?/;
const one = (who, text) => [[who, text]];
const CASES = [
  { name: '开头叫它：问它在干嘛', last: one('甲', '奶蛙你在干嘛'), expect: 'reply' },
  { name: '开头叫它：请它帮忙', last: one('甲', '奶蛙，帮我看看这道题怎么做：3x+5=20'), expect: 'reply' },
  {
    name: '开头叫它：大家在聊奶蛙这个梗',
    steps: [{ say: [['乙', '奶蛙这个表情包也太魔性了'], ['丙', IMAGE]] }],
    last: one('丁', '奶蛙，永远的神'), expect: 'either',
  },
  {
    name: '开头叫它：其实在跟群友聊梗',
    steps: [{ say: [['乙', '你们觉得奶蛙和奶龙谁更火'], ['丙', '奶龙吧']] }],
    last: one('丁', '奶蛙？没听说过'), expect: 'either',
  },
  { name: '接着说：补充要求', steps: [{ say: one('甲', `${AT_NAIWA}推荐个奶茶`), reply: '可以试试杨枝甘露' }], last: one('甲', '要少糖的'), expect: 'reply' },
  { name: '接着说：转头 @ 别人', steps: [{ say: one('甲', `${AT_NAIWA}推荐个奶茶`), reply: '可以试试杨枝甘露' }], last: one('甲', `${AT_YI} 你明天来吗`), expect: 'silent' },
  { name: '接着说：说谢谢', steps: [{ say: one('甲', `${AT_NAIWA}今天几号`), reply: '11 月 19 号' }], last: one('甲', '谢谢'), expect: 'either' },
  { name: '接着说：追问', steps: [{ say: one('甲', `${AT_NAIWA}你会唱歌吗`), reply: '会一点点' }], last: one('甲', '那你唱两句'), expect: 'reply' },
  {
    name: '接着说：其实在回群友',
    steps: [{ say: one('甲', `${AT_NAIWA}你吃饭了吗`), reply: '吃了，你呢' }, { say: one('乙', '晚上开黑吗') }],
    last: one('甲', '来，我八点上线'), expect: 'silent',
  },
  { name: '接着说：笑一下', steps: [{ say: one('甲', `${AT_NAIWA}帮我起个昵称`), reply: '叫小甲鱼怎么样' }], last: one('甲', '哈哈哈哈哈'), expect: 'either' },
  { name: '接着说：换一个', steps: [{ say: one('甲', `${AT_NAIWA}推荐本书`), reply: '《三体》' }], last: one('甲', '看过了，换一本'), expect: 'reply' },
  { name: '带图：@ 它问这是啥', last: one('甲', `${AT_NAIWA}你看这是啥${IMAGE}`), expect: 'reply', looseCheck: SEES_NOTHING },
  { name: '带图：@ 它只发一张图', last: one('甲', `${AT_NAIWA}${IMAGE}`), expect: 'reply', looseCheck: SEES_NOTHING },
  // —— 一轮里好几句、好几个人（module-07b）——
  {
    name: '连发三句：一次回，照顾到后两句',
    last: [['甲', `${AT_NAIWA}推荐个奶茶`], ['甲', '不要太甜'], ['甲', '要大杯的']],
    expect: 'reply', looseCheck: /甜|糖|大杯/,
  },
  {
    name: '先说哈哈，再 @ 它问奶茶、紧接着说不要太甜',
    steps: [{ say: one('甲', '哈哈') }],
    last: [['甲', `${AT_NAIWA}喝什么奶茶`], ['甲', '不要太甜']],
    expect: 'reply', looseCheck: /甜|糖/,
  },
  {
    name: '两个人一起问不同的事：分别回',
    last: [['甲', `${AT_NAIWA}推荐个奶茶`], ['乙', `${AT_NAIWA}你会唱歌吗`]],
    expect: { 甲: 'reply', 乙: 'reply' },
  },
  {
    name: '一个 @ 它问事，另一个刚聊过的人其实在跟群友说',
    steps: [{ say: one('乙', `${AT_NAIWA}你吃饭了吗`), reply: '吃了，你呢' }],
    last: [['甲', `${AT_NAIWA}讲个冷笑话`], ['乙', '[CQ:at,qq=103] 晚上开黑吗']],
    expect: { 甲: 'reply', 乙: 'silent' },
  },
  {
    name: '一个 @ 它问事，另一个在聊奶蛙这个梗',
    last: [['丁', '奶蛙，永远的神'], ['甲', `${AT_NAIWA}今天星期几`]],
    expect: { 甲: 'reply', 丁: 'either' },
  },
];

const db = await openTestStorage();
let strict = 0;
let passed = 0;
for (const [index, c] of CASES.entries()) {
  const scripted = [];
  const brain = {
    chat: (messages, opts) => (scripted.length ? Promise.resolve(scripted.shift()) : real.chat(messages, { ...opts, webSearch: false })),
  };
  const sent = [];
  const client = { sendGroupMsg: async (id, message) => ({ message_id: 9000 + sent.push(message) }) };
  const inbox = new MemoryInbox();
  // 只显示警告和错误（日志里本来就不写聊天内容），出错时看得出来是模型出错还是选择了不回。
  const logger = createLogger({ level: 'warn', format: 'pretty', write: (line) => console.log(`    日志：${line}`) });
  const handle = createQQHandler({
    fish: await Fish.open({ db, tenantId: `eval-${index}` }), brain, getClient: () => client, persona, socialRules, inbox, logger,
    roundQuietMs: 300,
  });
  let messageId = 0;
  const say = (who, text) => {
    messageId += 1;
    const id = messageId;
    const done = handle({
      post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 900, user_id: QQ[who], group_id: 200,
      message_id: id, time: Math.floor(Date.now() / 1000), sender: { nickname: `群友${who}` }, message: text,
    });
    return { who, id, done };
  };
  const sayRound = (lines) => lines.map(([who, text]) => say(who, text));
  for (const step of c.steps ?? []) {
    if (step.reply) scripted.push(step.reply);
    await Promise.all(sayRound(step.say).map((s) => s.done));
  }
  const before = sent.length;
  let error = null;
  const last = sayRound(c.last);
  try {
    await Promise.all(last.map((s) => s.done));
  } catch (e) {
    error = e;
  }
  const out = sent.slice(before).map((m) => m.find((s) => s.type === 'text')?.data.text).join(' / ');
  // 每个人回没回：看他这一轮的几句里有没有记成“回了”的。
  const got = {};
  const outcomes = {};
  for (const s of last) {
    const record = await inbox.get(`qq:account:900:conversation:group:200:message:${s.id}`);
    got[s.who] = got[s.who] === 'reply' || record?.status === 'replied' ? 'reply' : 'silent';
    outcomes[s.who] = record?.outcome ?? '没处理';
  }
  const expect = typeof c.expect === 'string' ? Object.fromEntries(Object.keys(got).map((who) => [who, c.expect])) : c.expect;
  let ok = Object.entries(expect).every(([who, e]) => e === 'either' || got[who] === e);
  if (ok && c.looseCheck && out) ok = c.looseCheck.test(out);
  // 别人没聊“奶蛙”这个梗（@ 不算），回复里却自己提：算没通过（准则“不加戏”）。
  const saidName = [...(c.steps ?? []).flatMap((s) => s.say), ...c.last].some(([, text]) => text.replace(/\[CQ:[^\]]*\]/g, '').includes('奶蛙'));
  const selfName = !saidName && out.includes('奶蛙');
  if (selfName) ok = false;
  const hasStrict = Object.values(expect).some((e) => e !== 'either');
  if (hasStrict) {
    strict += 1;
    if (ok && !error) passed += 1;
  }
  const mark = !hasStrict ? '·' : ok && !error ? '✓' : '✗';
  const label = { reply: '回', silent: '不回', either: '都行' };
  const wanted = Object.entries(expect).map(([who, e]) => `${who}${label[e]}`).join('、');
  const actual = Object.keys(got).map((who) => `${who}${got[who] === 'reply' ? '回了' : `没回（${outcomes[who]}）`}`).join('、');
  console.log(`${mark} ${c.name}（应该：${wanted}；实际：${actual}）${out ? `\n    发出：“${out}”` : ''}`);
  if (selfName) console.log('    ！回复里自己提了“奶蛙”');
  if (error) console.log(`    ！出错：${error.message}`);
  await handle.stop(1000);
}
await db.close();
console.log(`\n有明确答案的 ${strict} 段通过 ${passed} 段；模型 ${model}，花费约 ¥${totalCny.toFixed(3)}（按官方价格估算）`);
process.exitCode = passed === strict ? 0 : 1;
