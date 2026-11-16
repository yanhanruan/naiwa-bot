// 生成架构流程图 SVG → docs/architecture.svg
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'docs');
mkdirSync(outDir, { recursive: true });

const W = 1160;
const H = 1150;
const FONT = "PingFang SC, Microsoft YaHei, 'Noto Sans SC', sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const T = (x, y, s, o = {}) => {
  const { size = 14, weight = 'normal', fill = '#222', anchor = 'middle' } = o;
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
};
const R = (x, y, w, h, fill, stroke = '#b5b5b0') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
const L = (x1, y1, x2, y2) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#666" stroke-width="2" marker-end="url(#arrow)"/>`;
const D = (x1, y1, x2, y2) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#666" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#arrow)"/>`;
const P = (d) =>
  `<path d="${d}" fill="none" stroke="#666" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#arrow)"/>`;

function card(x, y, w, h, title, lines, fill) {
  let s = R(x, y, w, h, fill);
  s += T(x + w / 2, y + 28, title, { size: 17, weight: 'bold' });
  lines.forEach((ln, i) => {
    s += T(x + w / 2, y + 54 + i * 21, ln, { size: 13, fill: '#444' });
  });
  return s;
}

const cx = 560;
const p = [];
p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
p.push(
  `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#666"/></marker></defs>`,
);
p.push(`<rect width="${W}" height="${H}" fill="#fbfbfa"/>`);
p.push(T(W / 2, 42, '奶蛙 QQ 数字生命 · 架构与消息流', { size: 24, weight: 'bold' }));
p.push(
  T(W / 2, 68, 'QQ → SnowLuma(Docker) → fish-bot(Node) → DeepSeek Responses API（服务端 web_search）', {
    size: 13,
    fill: '#666',
  }),
);

// 主流程
p.push(card(cx - 200, 95, 400, 75, 'QQ（用户 / 群友）', ['QQ 小号已登录', '私聊 / 群聊消息'], '#e8f0ff'));
p.push(L(cx, 170, cx, 215));
p.push(card(cx - 260, 215, 520, 120, 'SnowLuma（Docker 容器 · 127.0.0.1）', [
  'Linux QQ + Hook 注入 → OneBot v11',
  '6081 noVNC 扫码 · 5099 WebUI',
  '3000 HTTP · 3001 WebSocket',
], '#fff4e5'));
p.push(L(cx, 335, cx, 380));
p.push(card(cx - 320, 380, 640, 195, 'fish-bot.mjs（Node 常驻进程）', [
  '收消息 → 检索记忆 → 拼 system prompt',
  '人设 · 社交准则 · 长期记忆 · 当前时间 · 短期历史',
  '→ DeepSeek → 写记忆 → 经 OneBot 发回 QQ',
], '#e8f7ee'));
p.push(L(cx, 575, cx, 625));
p.push(card(cx - 230, 625, 460, 125, 'DeepSeek Responses API', [
  'POST /v1/responses · model: deepseek-v4-pro',
  'tools: [{ type: "web_search" }]（服务端自动搜）',
], '#f3e8ff'));

// 标注
p.push(T(cx + 8, 360, 'OneBot v11 事件', { size: 12, fill: '#888', anchor: 'start' }));
p.push(T(cx + 8, 605, 'HTTP （Responses）', { size: 12, fill: '#888', anchor: 'start' }));

// 侧栏：存储
p.push(card(30, 410, 180, 135, '存储（data/naiwa）', ['memory.json', 'character.json', 'events.json'], '#f3f4f6'));
p.push(D(210, 477, 240, 477));

// 侧栏：prompt 组成
p.push(card(900, 410, 200, 165, 'system prompt', [
  'persona/naiwa.md',
  'social-rules.md',
  '长期记忆',
  '当前时间',
  '短期历史 6 条',
], '#fdf2f8'));
p.push(D(900, 492, 880, 492));

// 回复路径（右侧）
p.push(P('M 790 685 L 1120 685 L 1120 130 L 760 130'));
p.push(T(1108, 400, '回复', { size: 12, fill: '#888', anchor: 'end' }));

// 图例
p.push(T(40, 1080, '实线 = 请求流向', { size: 12, fill: '#888', anchor: 'start' }));
p.push(T(40, 1100, '虚线 = 存储 / prompt 注入 / 回复', { size: 12, fill: '#888', anchor: 'start' }));

p.push('</svg>');

writeFileSync(join(outDir, 'architecture.svg'), p.join('\n'), 'utf8');
console.log('written:', join(outDir, 'architecture.svg'));
