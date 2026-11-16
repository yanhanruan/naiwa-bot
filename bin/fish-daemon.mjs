#!/usr/bin/env node
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Fish } from '../src/index.js';

// 长驻进程：让数字生命保持在线，周期执行主动行为调度（受总开关门控）。
const home = process.env.FISH_HOME ?? join(homedir(), '.fish-os');
const tickMs = Number(process.env.FISH_TICK_MS ?? 60000);
const fish = new Fish({ home }).start();

console.log(`[fish-daemon] ${fish.character.name} 醒来啦｜home=${home}｜tick=${tickMs}ms｜proactive=${fish.policy.proactiveEnabled}`);

const timer = setInterval(() => {
  try {
    const res = fish.proactiveTick();
    if (res.length) {
      console.log(`[fish-daemon] 执行了 ${res.length} 个主动任务：${JSON.stringify(res)}`);
    }
  } catch (err) {
    console.error(`[fish-daemon] tick error: ${err.message}`);
  }
}, tickMs);

function shutdown(sig) {
  console.log(`[fish-daemon] 收到 ${sig}，准备入睡…`);
  clearInterval(timer);
  try {
    fish.stop();
  } catch (err) {
    console.error(`[fish-daemon] stop error: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
