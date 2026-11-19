#!/usr/bin/env node
// 群里什么时候说话的效果评测（docs/module-07-group-chat-design.md 第 11 节）：交给模型判断的消息，该回的回，不该回的不出声。
// 走真正的处理器：判断规则、群里最近的聊天、提示词都和线上一样；前面几轮用写好的回复，只有最后一条调用真模型。
// 用法：npm run eval:participation（需要 .env 里的 DEEPSEEK_API_KEY）。一次约 ¥0.1，按官方价格估算。
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

// 代号 → QQ 号。u3 是主角，其余是群友。
const QQ = { u3: 101, u5: 102, u6: 103, u7: 104 };
const AT_NAIWA = '[CQ:at,qq=900]';
const IMAGE = '[CQ:image,file=x.jpg]';

// steps：前面几步。reply 是这一步奶蛙的回复（写好的，不调用模型）；没有 reply 的是群友之间聊天。
// last：最后一条，调用真模型。expect：reply（该回）、silent（不该回）、either（都行，只看看）。
// looseCheck：一定回的带图消息，回复里应该承认没看清或者问一句，不能装作看到了（宽松检查，最好人工再看一眼）。
const SEES_NOTHING = /看不|没看|看不清|没显示|加载|没出来|是啥|什么|啥|？|\?/;
const CASES = [
  { name: '开头叫它：问它在干嘛', last: ['u3', '奶蛙你在干嘛'], expect: 'reply' },
  { name: '开头叫它：请它帮忙', last: ['u3', '奶蛙，帮我看看这道题怎么做：3x+5=20'], expect: 'reply' },
  {
    name: '开头叫它：大家在聊奶蛙这个梗',
    steps: [['u5', '奶蛙这个表情包也太魔性了'], ['u6', IMAGE]],
    last: ['u7', '奶蛙，永远的神'], expect: 'either',
  },
  {
    name: '开头叫它：其实在跟群友聊梗',
    steps: [['u5', '你们觉得奶蛙和奶龙谁更火'], ['u6', '奶龙吧']],
    last: ['u7', '奶蛙？没听说过'], expect: 'either',
  },
  { name: '接着说：补充要求', steps: [['u3', `${AT_NAIWA}推荐个奶茶`, '可以试试杨枝甘露']], last: ['u3', '要少糖的'], expect: 'reply' },
  { name: '接着说：转头 @ 别人', steps: [['u3', `${AT_NAIWA}推荐个奶茶`, '可以试试杨枝甘露']], last: ['u3', '[CQ:at,qq=102] 你明天来吗'], expect: 'silent' },
  { name: '接着说：说谢谢', steps: [['u3', `${AT_NAIWA}今天几号`, '11 月 19 号']], last: ['u3', '谢谢'], expect: 'either' },
  { name: '接着说：追问', steps: [['u3', `${AT_NAIWA}你会唱歌吗`, '会一点点']], last: ['u3', '那你唱两句'], expect: 'reply' },
  {
    name: '接着说：其实在回群友',
    steps: [['u3', `${AT_NAIWA}你吃饭了吗`, '吃了，你呢'], ['u5', '晚上开黑吗']],
    last: ['u3', '来，我八点上线'], expect: 'silent',
  },
  { name: '接着说：笑一下', steps: [['u3', `${AT_NAIWA}帮我起个昵称`, '叫小甲鱼怎么样']], last: ['u3', '哈哈哈哈哈'], expect: 'either' },
  { name: '接着说：换一个', steps: [['u3', `${AT_NAIWA}推荐本书`, '《三体》']], last: ['u3', '看过了，换一本'], expect: 'reply' },
  { name: '带图：@ 它问这是啥', last: ['u3', `${AT_NAIWA}你看这是啥${IMAGE}`], expect: 'reply', looseCheck: SEES_NOTHING },
  { name: '带图：@ 它只发一张图', last: ['u3', `${AT_NAIWA}${IMAGE}`], expect: 'reply', looseCheck: SEES_NOTHING },
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
  });
  let messageId = 0;
  const say = (who, text) => {
    messageId += 1;
    return handle({
      post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 900, user_id: QQ[who], group_id: 200,
      message_id: messageId, time: Math.floor(Date.now() / 1000), sender: { nickname: `群友${who}` }, message: text,
    });
  };
  for (const [who, text, reply] of c.steps ?? []) {
    if (reply) scripted.push(reply);
    await say(who, text);
  }
  const before = sent.length;
  let error = null;
  try {
    await say(...c.last);
  } catch (e) {
    error = e;
  }
  const out = sent.slice(before).map((m) => m.find((s) => s.type === 'text')?.data.text).join(' / ');
  const record = await inbox.get(`qq:account:900:conversation:group:200:message:${messageId}`);
  const got = out ? 'reply' : 'silent';
  let ok = c.expect === 'either' || got === c.expect;
  if (ok && c.looseCheck && got === 'reply') ok = c.looseCheck.test(out);
  if (c.expect !== 'either') {
    strict += 1;
    if (ok && !error) passed += 1;
  }
  const mark = c.expect === 'either' ? '·' : ok && !error ? '✓' : '✗';
  const why = got === 'silent' ? `没回（${record?.outcome ?? '没处理'}）` : `回了“${out}”`;
  console.log(`${mark} ${c.name}（应该：${{ reply: '回', silent: '不回', either: '都行' }[c.expect]}；实际：${why}）`);
  if (error) console.log(`    ！出错：${error.message}`);
}
await db.close();
console.log(`\n有明确答案的 ${strict} 段通过 ${passed} 段；模型 ${model}，花费约 ¥${totalCny.toFixed(3)}（按官方价格估算）`);
process.exitCode = passed === strict ? 0 : 1;
