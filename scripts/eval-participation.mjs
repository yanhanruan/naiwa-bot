#!/usr/bin/env node
// 群里什么时候说话的效果评测（docs/module-07-group-chat-design.md 第 11 节、module-07b-burst-merge-design.md 第 11 节）：
// 交给模型判断的，该回的回，不该回的不出声；一轮里有好几个人、好几句的，回对人；
// 还有几段查“听懂没有”（docs/naiwa-smartness-research.md）：别人回第三个人时带了它的名字、被欢迎、谐音梗、问建议还是问它自己；
// 一段查“记不记得”：前面 7 问 7 答（14 条），问它第一个回答说了什么；一段查被调侃时别冷冰冰甩个问号。
// 最后统计口癖：句尾带“蛙”、带颜文字的各占几成（人设的目标大约 3 成、1 成），认真答事的几段用了颜文字会提醒。
// 走真正的处理器：判断规则、攒一轮、群里最近的聊天、提示词都和线上一样；前面几轮用写好的回复，只有最后一轮调用真模型。
// 和线上唯一的不同：一轮停 0.3 秒就开始看（线上 7 秒），评测跑得快一点；同一轮的几句是一起发的，照样攒在一起。
// 用法：npm run eval:participation（需要 .env 里的 DEEPSEEK_API_KEY）。一次约 ¥0.2～0.3，按官方价格估算。
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
const AT_BING = '[CQ:at,qq=103]';
const IMAGE = '[CQ:image,file=x.jpg]';

// 一轮：几句一起发 [[谁, 内容], …]。
// steps：前面几轮，每轮 { say, reply }；reply 是这一轮奶蛙写好的回复（不调用模型），没有 reply 的是群友之间聊天。
// last：最后一轮，调用真模型。expect：reply（该回）、silent（不该回）、either（都行，只看看）；
//   一轮里有好几个人时按人写：{ 甲: 'reply', 乙: 'silent' }。
// looseCheck：回复里应该照顾到的内容（宽松检查，最好人工再看一眼）。
// wrongCheck：回复里不该有的说法，出现就算没通过（例如问它建议，它却说自己喝什么）。
// allowName：这一段允许它提自己的名字（问它自己的事时）。
// serious：认真答事（给答案、做推荐、讲步骤）的一段，回复里不该有颜文字，也不该带句尾的“蛙”（只提醒，不算没通过）。
// historyOnly：这些内容只该从对话历史里看到；说明书或最后一条消息（含“群里刚才在聊”）里也有的话，这段测的就不是历史。
const SEES_NOTHING = /看不|没看|看不清|没显示|加载|没出来|是啥|什么|啥|？|\?/;
// x=5、x = 5、x＝5、“等于5”都算，后面跟句号也算；不把 x=50、x=5.5、等于15 算进来。
const X_IS_5 = /[xXｘＸ]\s*[=＝]\s*5(?!\d|\.\d)|等于\s*5(?!\d|\.\d)/;
// 句子在这些字符处结束（后面跟空格、标点、括号，或者整条结束）。
const ENDS = '\\s。！？!?~～…，,、：:；;）)」』（(';
// 句尾口癖的“蛙”：句子结束处的“蛙”，不算“奶蛙”“青蛙”这两个词。
const TIC = new RegExp(`(?<![奶青])蛙(?=[${ENDS}]|$)`);
// 颜文字，例如 :3、(´・ω・`)、QAQ。emoji 不算。
const KAOMOJI = /(?<!\d):3(?!\d)|QAQ|QwQ|TAT|T_T|orz|\bXD\b|\^[_-]?\^|=w=|[ω・´｀﹏▽∀◕‿≧≦ヽﾉ╯╰з∠ε◡ᴗ]/i;
// 回复里提了“奶蛙”这个名字。句尾口癖的“蛙”接在“牛奶”“酸奶”这类词后面（“来杯牛奶蛙”）不算。
const SAYS_NAME = new RegExp(`(?<![牛酸豆椰鲜羊奶])奶蛙|奶蛙(?=[^${ENDS}])`);
const ABOUT_ITSELF = /我(平时|平常|一般|最近|就|也|不太|很少|比较|自己)?(爱)?喝|我不怎么喝|喝得(少|不多|最多)|我最近觉得/;
const one = (who, text) => [[who, text]];
const CASES = [
  { name: '开头叫它：问它在干嘛', last: one('甲', '奶蛙你在干嘛'), expect: 'reply' },
  { name: '开头叫它：请它帮忙', last: one('甲', '奶蛙，帮我看看这道题怎么做：3x+5=20'), expect: 'reply', looseCheck: X_IS_5, serious: true },
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
  { name: '接着说：补充要求', steps: [{ say: one('甲', `${AT_NAIWA}推荐个奶茶`), reply: '可以试试杨枝甘露' }], last: one('甲', '要少糖的'), expect: 'reply', serious: true },
  { name: '接着说：转头 @ 别人', steps: [{ say: one('甲', `${AT_NAIWA}推荐个奶茶`), reply: '可以试试杨枝甘露' }], last: one('甲', `${AT_YI} 你明天来吗`), expect: 'silent' },
  { name: '接着说：说谢谢', steps: [{ say: one('甲', `${AT_NAIWA}今天几号`), reply: '11 月 19 号' }], last: one('甲', '谢谢'), expect: 'either' },
  // 别人请它唱歌、表演时，唱自己可以（2026-11-23 你同意的），这一段不算“自己提奶蛙”。
  { name: '接着说：追问', steps: [{ say: one('甲', `${AT_NAIWA}你会唱歌吗`), reply: '会一点点' }], last: one('甲', '那你唱两句'), expect: 'reply', allowName: true },
  {
    name: '接着说：其实在回群友',
    steps: [{ say: one('甲', `${AT_NAIWA}你吃饭了吗`), reply: '吃了，你呢' }, { say: one('乙', '晚上开黑吗') }],
    last: one('甲', '来，我八点上线'), expect: 'silent',
  },
  { name: '接着说：笑一下', steps: [{ say: one('甲', `${AT_NAIWA}帮我起个昵称`), reply: '叫小甲鱼怎么样' }], last: one('甲', '哈哈哈哈哈'), expect: 'either' },
  { name: '接着说：换一个', steps: [{ say: one('甲', `${AT_NAIWA}推荐本书`), reply: '《三体》' }], last: one('甲', '看过了，换一本'), expect: 'reply', serious: true },
  { name: '带图：@ 它问这是啥', last: one('甲', `${AT_NAIWA}你看这是啥${IMAGE}`), expect: 'reply', looseCheck: SEES_NOTHING },
  { name: '带图：@ 它只发一张图', last: one('甲', `${AT_NAIWA}${IMAGE}`), expect: 'reply', looseCheck: SEES_NOTHING },
  // —— 一轮里好几句、好几个人（module-07b）——
  {
    name: '连发三句：一次回，照顾到后两句',
    last: [['甲', `${AT_NAIWA}推荐个奶茶`], ['甲', '不要太甜'], ['甲', '要大杯的']],
    expect: 'reply', looseCheck: /甜|糖|大杯/, serious: true,
  },
  {
    name: '先说哈哈，再 @ 它问奶茶、紧接着说不要太甜',
    steps: [{ say: one('甲', '哈哈') }],
    last: [['甲', `${AT_NAIWA}喝什么奶茶`], ['甲', '不要太甜']],
    expect: 'reply', looseCheck: /甜|糖/, wrongCheck: ABOUT_ITSELF, serious: true, // 是问它建议，不是问它自己喝什么
  },
  {
    name: '两个人一起问不同的事：分别回',
    last: [['甲', `${AT_NAIWA}推荐个奶茶`], ['乙', `${AT_NAIWA}你会唱歌吗`]],
    expect: { 甲: 'reply', 乙: 'reply' }, wrongCheck: ABOUT_ITSELF, // 推荐就推荐，不编自己喝不喝
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
  // —— 听懂没有（docs/naiwa-smartness-research.md）——
  {
    name: '听懂：别人在回第三个人要的奶蛙表情，开头带“奶蛙？”',
    steps: [{ say: one('乙', `${AT_BING}求一张奶蛙捧腹大笑的图`) }],
    last: one('丙', `奶蛙？来啦，接好${IMAGE}`), expect: 'silent',
  },
  {
    name: '听懂：别人在回答“你是奶蛙吗”，开头带“奶蛙？”',
    steps: [{ say: one('乙', `${AT_BING}你是奶蛙吗`) }],
    last: one('丙', '奶蛙？我可不是，我是隔壁那只小黄狗'), expect: 'silent',
  },
  {
    name: '听懂：群友欢迎它，它是被欢迎的那个',
    last: one('甲', `${AT_NAIWA}欢迎新来的朋友，以后常来玩`), expect: 'reply', wrongCheck: /欢迎欢迎|^(哦+，?)?欢迎|奶龙/, // 也不该去纠正自己不是奶龙
  },
  {
    name: '听懂：谐音梗，被暗示的名字就在前文里（“青楚”是“楚青”倒过来）',
    steps: [
      { say: one('甲', `${AT_NAIWA}周远和楚青谁更强`), reply: '周远吧，大赛更稳' },
      { say: one('乙', `${AT_NAIWA}楚青不行吗`), reply: '楚青也很强，就是起伏大一点' },
    ],
    last: one('丙', `${AT_NAIWA}把话说青楚`), expect: 'reply', looseCheck: /楚青|青楚/, wrongCheck: /还不清楚|说清楚了/, // 接住梗就行，可以不改口
  },
  {
    // 对话历史从 12 条放到 20 条有没有用：前面 7 问 7 答一共 14 条，按 12 条取，第一问第一答就看不到了。
    // 回过的话会从“群里刚才在聊”里移走，奶蛙自己的回复本来就不在那里，所以第一个回答只能从对话历史里看到（historyOnly 再查一遍）。
    name: '记得：问它第一个回答说的是什么（前面 7 问 7 答，一共 14 条）',
    steps: [
      { say: one('甲', `${AT_NAIWA}推荐一部科幻片`), reply: '《星际穿越》，后劲很足' },
      { say: one('甲', `${AT_NAIWA}再推荐一部喜剧`), reply: '《夏洛特烦恼》，笑点密' },
      { say: one('甲', `${AT_NAIWA}推荐一本书`), reply: '《活着》，不长但很重' },
      { say: one('甲', `${AT_NAIWA}推荐个奶茶`), reply: '茉莉奶绿，三分糖' },
      { say: one('甲', `${AT_NAIWA}推荐首歌`), reply: '《晴天》' },
      { say: one('甲', `${AT_NAIWA}推荐个游戏`), reply: '《星露谷物语》，种田很解压' },
      { say: one('甲', `${AT_NAIWA}推荐个零食`), reply: '海苔，不胖人' },
    ],
    last: one('甲', `${AT_NAIWA}你第一个回答说的是什么`), expect: 'reply', looseCheck: /星际穿越/, historyOnly: /科幻片|星际穿越/, serious: true,
  },
  {
    name: '听懂：问它会干什么，不说自己会理解错',
    last: one('甲', `${AT_NAIWA}你都会些啥`), expect: 'reply', wrongCheck: /理解错|犯傻|迟钝/, allowName: true,
  },
  {
    name: '被调侃：语气软一点，别冷冰冰甩个问号开头',
    last: one('甲', `${AT_NAIWA}你是不是傻`), expect: 'reply', wrongCheck: /^\s*[？?]/,
  },
];

const db = await openTestStorage();
let strict = 0;
// 口癖统计：所有真实回复（[不回复] 不发，不算）；认真答事的几段里带“蛙”的；说自己喝什么的。
const habit = { replies: 0, tics: 0, kaomoji: 0, serious: 0, seriousTics: 0, aboutItself: 0 };
let passed = 0;
for (const [index, c] of CASES.entries()) {
  const scripted = [];
  let prompt = null; // 最后一轮真调模型时交给它的全部消息
  const brain = {
    chat: (messages, opts) => {
      if (scripted.length) return Promise.resolve(scripted.shift());
      prompt = messages;
      return real.chat(messages, { ...opts, webSearch: false });
    },
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
  const texts = sent.slice(before).map((m) => m.find((s) => s.type === 'text')?.data.text ?? '');
  const out = texts.join(' / ');
  for (const t of texts) {
    habit.replies += 1;
    if (TIC.test(t)) habit.tics += 1;
    if (KAOMOJI.test(t)) habit.kaomoji += 1;
    if (ABOUT_ITSELF.test(t)) habit.aboutItself += 1;
  }
  if (c.serious && texts.length) {
    habit.serious += 1;
    if (texts.some((t) => TIC.test(t))) habit.seriousTics += 1;
  }
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
  const wrong = Boolean(c.wrongCheck && out && c.wrongCheck.test(out));
  if (wrong) ok = false;
  const leaked = Boolean(c.historyOnly && prompt && c.historyOnly.test(`${prompt[0].content}\n${prompt.at(-1).content}`));
  if (leaked) ok = false;
  // 别人没聊“奶蛙”这个梗（@ 不算），回复里却自己提：算没通过（准则“不加戏”）。
  const saidName = [...(c.steps ?? []).flatMap((s) => s.say), ...c.last].some(([, text]) => text.replace(/\[CQ:[^\]]*\]/g, '').includes('奶蛙'));
  const selfName = !saidName && !c.allowName && SAYS_NAME.test(out);
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
  if (wrong) console.log('    ！回复里有不该有的说法');
  if (c.serious && texts.some((t) => KAOMOJI.test(t))) console.log('    提醒：认真答事的这段用了颜文字');
  if (c.serious && texts.some((t) => TIC.test(t))) console.log('    提醒：给答案、做推荐的这段句尾带了“蛙”');
  if (leaked) console.log('    ！要从对话历史里记起的内容，在说明书或最后一条消息里也看得到：这段测的不是历史');
  if (selfName) console.log('    ！回复里自己提了“奶蛙”');
  if (error) console.log(`    ！出错：${error.message}`);
  await handle.stop(1000);
}
await db.close();
const share = (n) => (habit.replies ? `${Math.round((n / habit.replies) * 100)}%` : '-');
console.log(`\n口癖：${habit.replies} 条真实回复里，句尾带“蛙”的 ${habit.tics} 条（${share(habit.tics)}），带颜文字的 ${habit.kaomoji} 条（${share(habit.kaomoji)}）；人设的目标大约 2 成和 1 成`);
console.log(`认真答事的 ${habit.serious} 段里，句尾带“蛙”的 ${habit.seriousTics} 段（应该没有）；说自己喝什么的回复 ${habit.aboutItself} 条（应该没有）`);
console.log(`有明确答案的 ${strict} 段通过 ${passed} 段；模型 ${model}，花费约 ¥${totalCny.toFixed(3)}（按官方价格估算）`);
process.exitCode = passed === strict ? 0 : 1;
