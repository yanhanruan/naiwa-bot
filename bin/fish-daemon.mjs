#!/usr/bin/env node
import { Fish } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';

// 长驻进程：让数字生命保持在线，周期执行主动行为调度（受总开关门控）。
const tickMs = Number(process.env.FISH_TICK_MS ?? 60000);
const db = await openStorage();
const fish = await (await Fish.open({ db })).start();

console.log(`[fish-daemon] ${fish.character.name} 醒来啦｜存储=PostgreSQL｜tick=${tickMs}ms｜proactive=${fish.policy.proactiveEnabled}`);

let ticking = false;
const timer = setInterval(async () => {
  if (ticking) return; // 上一次还没结束就跳过，避免重叠执行
  ticking = true;
  try {
    const res = await fish.proactiveTick();
    if (res.length) {
      console.log(`[fish-daemon] 执行了 ${res.length} 个主动任务：${JSON.stringify(res)}`);
    }
  } catch (err) {
    console.error(`[fish-daemon] tick error: ${err.message}`);
  } finally {
    ticking = false;
  }
}, tickMs);

async function shutdown(sig) {
  console.log(`[fish-daemon] 收到 ${sig}，准备入睡…`);
  clearInterval(timer);
  try {
    await fish.stop();
    await db.close();
  } catch (err) {
    console.error(`[fish-daemon] stop error: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
