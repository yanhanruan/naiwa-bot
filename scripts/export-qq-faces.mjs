// 导出 QQ 自带小表情（小黄脸）的“编号 → 名字”对照表，写进 src/qq-faces.js（docs/image-understanding-design.md 6.3 节）。
// 数据来自 SnowLuma 的 fetch_sys_faces：QQ 官方的系统表情目录。只读，不发消息、不调用模型。
// QQ 出了新表情时重新跑一次：node --env-file=.env scripts/export-qq-faces.mjs
// 只打印条数，不打印 token。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OneBotClient } from '../src/adapters/onebot.js';

const url = process.env.ONEBOT_WS ?? 'ws://127.0.0.1:3001';
const token = process.env.ONEBOT_TOKEN ?? '';
const out = fileURLToPath(new URL('../src/qq-faces.js', import.meta.url));

const client = new OneBotClient({ url, token, onEvent: () => {} });
client.start();
try {
  if (!(await client.waitForConnection(10_000))) throw new Error('10 秒内没连上 OneBot');
  const data = await client.call('fetch_sys_faces', { refresh: false }, { timeoutMs: 30_000 });
  const faces = new Map();
  let entries = 0;
  for (const pack of data?.packs ?? []) {
    for (const face of pack?.emojis ?? []) {
      entries += 1;
      const id = String(face?.q_sid ?? '');
      // 目录里的描述写作“/流泪”，去掉开头的“/”就是名字。编号不是数字的是 Unicode emoji，消息里不会以小黄脸的编号出现。
      const name = String(face?.q_des ?? '').replace(/^\//, '').trim();
      if (/^\d+$/.test(id) && name && !faces.has(id)) faces.set(id, name);
    }
  }
  if (!faces.size) throw new Error('目录里没有可用的小表情');
  const lines = [...faces].sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([id, name]) => `  ${JSON.stringify(id)}: ${JSON.stringify(name)},`);
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(out, [
    '// QQ 自带小表情（小黄脸）的“编号 → 名字”对照表（docs/image-understanding-design.md 6.3 节）。',
    `// 由 scripts/export-qq-faces.mjs 从 SnowLuma 的 fetch_sys_faces（QQ 官方系统表情目录）导出，${day}。不要手改，重新导出即可。`,
    'export const QQ_FACES = Object.freeze({',
    ...lines,
    '});',
    '',
    '// 小表情的名字；表里没有的返回 null（显示成“[QQ表情]”）。',
    'export function faceName(id) {',
    '  const key = String(id ?? \'\');',
    '  return Object.hasOwn(QQ_FACES, key) ? QQ_FACES[key] : null;',
    '}',
    '',
  ].join('\n'));
  console.log(`目录里 ${entries} 个表情，导出数字编号的 ${faces.size} 个`);
} finally {
  client.stop();
}
