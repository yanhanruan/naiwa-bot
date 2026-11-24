// 心情怎么交给模型、模型怎么告诉程序“这一轮有人让你高兴 / 难受”（docs/module-08-mood-design.md）。
// - 每一档一个本地文件 persona/moods/<档>.md，写这一档的语气和口癖；平常没有文件，就是现在的人设，一个字不加。
// - 模型在输出里单独写一行 [心情 变好 u3] / [心情 变差 u3]；程序把它拿掉，绝不发出去。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOOD_LEVELS, moodName } from './mood.js';

// 读 persona/moods 里每一档的说法。没有的档就是没有（平常本来就没有）。
export function loadMoodTexts(dir) {
  const texts = {};
  for (const { value, name } of MOOD_LEVELS) {
    const file = join(dir, `${name}.md`);
    if (value !== 0 && existsSync(file)) texts[name] = readFileSync(file, 'utf8').trim();
  }
  return texts;
}

// 放进说明书的“现在的心情”：平常、或这一档没有文件时，返回空字符串。
// 起伏让它离开了早上的基调时，补一句（不说是谁、在哪）。
export function moodSection(state, texts) {
  if (!state || state.level === 0) return '';
  const text = texts?.[moodName(state.level)];
  if (!text) return '';
  const since = state.level < state.base ? '刚才被人说了几句，比早上更蔫一点。'
    : state.level > state.base ? '刚才有人让你挺开心的，比早上好一点。' : '';
  return `## 现在的心情\n${text}${since ? `\n${since}` : ''}`;
}

// 写进“消息格式”的一条：什么时候写心情那一行。
export const MOOD_TAG_RULE = '心情：这一轮里有人真让你高兴（夸你、谢你）或难受（骂你、挑衅你），就在最后单独一行写 [心情 变好 u3] 或 [心情 变差 u3]（换成那个人的代号）；这一行不会发出去。开玩笑、反话、跟你无关的不算；大多数时候不写。';

const TAG = /[[【]\s*心情\s*[:：]?\s*(变好|变差)\s*(u\d+)?\s*[\]】]/g;

/**
 * 从模型输出里拿掉心情那一行（写在句子中间的也拿掉），返回剩下的话和心情变化。
 * @returns {{text: string, tags: Array<{direction: 1|-1, alias: string|null}>}}
 */
export function extractMoodTags(output) {
  const text = String(output ?? '');
  const tags = [];
  const kept = [];
  for (const line of text.split('\n')) {
    const rest = line.replace(TAG, (_, word, alias) => {
      tags.push({ direction: word === '变好' ? 1 : -1, alias: alias ?? null });
      return '';
    });
    if (rest !== line && !rest.trim()) continue; // 整行只有心情标记：这一行删掉
    kept.push(rest);
  }
  return tags.length ? { text: kept.join('\n').trim(), tags } : { text, tags };
}
