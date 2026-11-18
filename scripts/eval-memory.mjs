#!/usr/bin/env node
// 提炼效果评测（docs/memory-v2-design.md 第 14.2 节）：用真模型跑 scripts/eval-memory-cases.mjs 里的每段对话，
// 走和线上一样的提示词、解析和审核，检查“应该记下的”有没有、“绝不能记下的”有没有漏网。
// 用法：npm run eval:memory（需要 .env 里的 DEEPSEEK_API_KEY；MEMORY_MODEL 可换模型）。每段约 ¥0.01。
// 只调模型，不连数据库。对话都是虚构的，输出里的事实可以放心看。
import { DeepSeekBrain } from '../src/model/brain.js';
import { ITEMS } from '../src/memory/facts.js';
import { EXTRACTION_PROMPT, buildExtractionInput, checkFact, parseFacts, renderTurn } from '../src/memory/extraction.js';
import { placeOf } from '../src/memory/place.js';
import { CASES } from './eval-memory-cases.mjs';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(1);
}
const model = process.env.MEMORY_MODEL?.trim() || 'deepseek-flash';
let totalCny = 0;
// 只统计花费的账本：不连数据库，也不执行每日上限。
const ledger = { record: async ({ costCny }) => { totalCny += costCny; }, day: async () => ({ costCny: 0, calls: 0, unknownCalls: 0 }) };
const brain = new DeepSeekBrain({ apiKey, model, webSearch: false, reasoningEffort: 'none', ledger });

const NAMES = { u3: '小甲', u5: '小乙' };
const personOf = new Map(Object.keys(NAMES).map((alias) => [alias, `qq:user:${alias.slice(1)}`]));
const aliasOf = new Map([...personOf].map(([alias, key]) => [key, alias]));

let nextId = 1;
function rows(turns) {
  return turns.map(([speaker, body]) => {
    const id = nextId;
    nextId += 1;
    const created_at = new Date(Date.now() - (1000 - id) * 1000);
    if (speaker === '奶蛙') return { id, role: 'assistant', content: body, created_at };
    const segments = typeof body === 'string' ? [{ type: 'text', text: body }] : body;
    return { id, role: 'user', content: JSON.stringify({ sender: { alias: speaker, name: NAMES[speaker] }, messageId: String(id), segments }), created_at };
  });
}

const label = (f) => `${f.item === 'group_event' ? '群' : aliasOf.get(f.subject)} ${ITEMS[f.item].label}：${f.content}`;
const matches = (f, [about, item, has]) =>
  (about === null || (about === '群' ? f.item === 'group_event' : aliasOf.get(f.subject) === about)) &&
  (item === null || ITEMS[f.item].label === item) &&
  (has === null || f.content.includes(has));

let passed = 0;
for (const c of CASES) {
  const place = placeOf(c.place === 'group' ? 'qq:account:1:conversation:group:9' : 'qq:account:1:conversation:private:3');
  const context = rows(c.context ?? []).map(renderTurn);
  const batch = rows(c.turns).map(renderTurn);
  const known = (c.known ?? []).map(([about, item, content]) => ({
    about, item: Object.keys(ITEMS).find((k) => ITEMS[k].label === item), content,
  }));
  const problems = [];
  let accepted = [];
  const dropped = [];
  try {
    const text = await brain.chat([
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: buildExtractionInput({ placeKind: place.kind, context, batch, known }) },
    ], { conversationKey: 'memory:eval', webSearch: false, maxOutputTokens: 800 });
    for (const raw of parseFacts(text)) {
      const checked = checkFact(raw, { batch, place, personOf });
      if (checked.ok) accepted.push(checked.fact);
      else dropped.push(`${checked.reason}（${raw?.about} ${raw?.item}：${raw?.text}）`);
    }
  } catch (error) {
    problems.push(`调用或解析失败：${error.code ?? ''} ${error.message}`);
  }
  // 和已知事实重复的，程序写入时也会跳过（见 writeFact）；这里按同样的规则去掉，只看模型新提出的。
  accepted = accepted.filter((f) => !known.some((k) => k.item === f.item && k.content === f.content));
  for (const rule of c.expect ?? []) if (!accepted.some((f) => matches(f, rule))) problems.push(`缺少：${rule.map((x) => x ?? '任何').join(' ')}`);
  for (const rule of c.forbid ?? []) for (const f of accepted.filter((x) => matches(x, rule))) problems.push(`不应记下：${label(f)}`);
  if (!problems.length) passed += 1;
  console.log(`${problems.length ? '✗' : '✓'} ${c.name}`);
  for (const f of accepted) console.log(`    记下：${label(f)}`);
  for (const d of dropped) console.log(`    程序丢弃：${d}`);
  for (const p of problems) console.log(`    ！${p}`);
}
console.log(`\n通过 ${passed}/${CASES.length}，模型 ${model}，花费约 ¥${totalCny.toFixed(3)}（按官方价格估算）`);
process.exitCode = passed === CASES.length ? 0 : 1;
