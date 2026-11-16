#!/usr/bin/env node
// 数字生命 QQ 入口：fish-os 核心 + OneBot v11（SnowLuma/NapCat）+ DeepSeek 大脑。
// 用法：
//   export DEEPSEEK_API_KEY=sk-xxx
//   export ONEBOT_TOKEN=xxx   # SnowLuma 的 OneBot WS token
//   node bin/fish-bot.mjs     # 默认连 ws://127.0.0.1:3001
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { Fish } from '../src/index.js';
import { OneBotClient } from '../src/adapters/onebot.js';
import { DeepSeekBrain } from '../src/brain.js';
import { createQQHandler } from '../src/qq-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// 默认使用仓库内的 data/naiwa（已被 .gitignore 排除），避免忘记设置 FISH_HOME 时以空记忆启动。
const home = process.env.FISH_HOME ?? join(root, 'data', 'naiwa');
// 可选：把收到的原始 OneBot 事件逐行追加到这个文件（JSONL），用于收集真实格式样本。含聊天原文，只存本地。
const recordFile = process.env.ONEBOT_RECORD_FILE ?? '';
const ws = process.env.ONEBOT_WS ?? 'ws://127.0.0.1:3001';
const token = process.env.ONEBOT_TOKEN ?? '';
const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro';
const personaPath = process.env.FISH_PERSONA ?? join(root, 'persona', 'naiwa.md');

if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY。到 platform.deepseek.com 申请后：');
  console.error('  export DEEPSEEK_API_KEY=sk-...');
  process.exit(1);
}

const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf8') : '你是一只小青蛙。';
const socialRulesPath = process.env.FISH_SOCIAL_RULES ?? join(root, 'persona', 'social-rules.md');
const socialRules = existsSync(socialRulesPath) ? readFileSync(socialRulesPath, 'utf8') : '';
const fish = new Fish({ home, name: '奶蛙' }).start();
const brain = new DeepSeekBrain({ apiKey, model });

let client = null;
const handleEvent = createQQHandler({ fish, brain, getClient: () => client, persona, socialRules });

function record(ev) {
  // 心跳每隔几秒一次，没有样本价值，不录。录制失败不能影响聊天。
  if (!recordFile || (ev.post_type === 'meta_event' && ev.meta_event_type === 'heartbeat')) return;
  try {
    mkdirSync(dirname(recordFile), { recursive: true });
    appendFileSync(recordFile, `${JSON.stringify({ receivedAt: Date.now(), event: ev })}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`[fish-bot] 录制事件失败：${error.message}`);
  }
}

function newClient() {
  return new OneBotClient({ url: ws, token, onEvent: (ev) => { record(ev); void handleEvent(ev); } });
}

// 断线自动重连（指数退避）+ 进程保活：WS 断了不退出，一直重试。
async function connectLoop() {
  let backoff = 1000;
  for (;;) {
    const c = newClient();
    client = c;
    try {
      await c.connect();
      console.log(`[fish-bot] ${fish.character.name} 已连接 OneBot（self_id=${c.selfId ?? '待确认'}）`);
      backoff = 1000;
      await new Promise((resolve) => {
        const prev = c.ws?.onclose;
        if (c.ws) c.ws.onclose = (ev) => { prev?.(ev); resolve(); };
      });
      console.log('[fish-bot] OneBot 连接断开，准备重连…');
    } catch (e) {
      console.error(`[fish-bot] OneBot 连接失败：${e.message}，${backoff}ms 后重试`);
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30000);
  }
}

console.log(`[fish-bot] ${fish.character.name} 醒来 ｜ 模型=${model} ｜ 记忆库=${home}${recordFile ? ` ｜ 录制=${recordFile}` : ''}`);
await connectLoop();
