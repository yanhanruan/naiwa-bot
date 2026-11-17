#!/usr/bin/env node
import { Fish, OPERATOR } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';

// CLI 是运维工具：查看、导出、删除记忆时以运维身份（OPERATOR）操作，能看到全部记录。

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help') return run(null, 'help', args); // 看帮助不需要连数据库
  const db = await openStorage();
  try {
    await run(await Fish.open({ db }), cmd, args);
  } finally {
    await db.close();
  }
}

async function run(fish, cmd, args) {
  const out = (o) => console.log(JSON.stringify(o, null, 2));

  switch (cmd) {
    case 'status':
      out(await fish.bridge.getStatus());
      break;
    case 'state':
      out(await fish.bridge.getCharacterState());
      break;
    case 'remember': {
      const type = args[0] ?? 'episodic';
      let content = args.slice(1).join(' ');
      if (!content) content = await readStdin();
      if (!content) {
        console.error('remember 需要内容：fish remember episodic "发生了什么"');
        process.exitCode = 1;
        return;
      }
      out(await fish.remember({ type, content }));
      break;
    }
    case 'recall':
      out(await fish.recall({ query: args.join(' ') || '', requester: OPERATOR }));
      break;
    case 'export':
      out(await fish.memory.export({ requester: OPERATOR }));
      break;
    case 'forget':
      out(await fish.memory.forget(args[0], OPERATOR));
      break;
    case 'delete':
      out(await fish.memory.deleteAll(OPERATOR));
      break;
    case 'act':
      out(await fish.bridge.act({ type: args[0] ?? 'publish', platform: 'fish-os', text: args.slice(1).join(' ') }));
      break;
    case 'approve':
      out(await fish.bridge.approve(args[0]));
      break;
    case 'deny':
      out(await fish.bridge.deny(args[0]));
      break;
    case 'proactive-on':
      out({ proactiveEnabled: fish.policy.setProactiveEnabled(true) });
      break;
    case 'proactive-off':
      out({ proactiveEnabled: fish.policy.setProactiveEnabled(false) });
      break;
    case 'browse': {
      const [platform, sub, ...rest] = args;
      if (platform !== 'bilibili') {
        console.error('目前只支持：fish browse bilibili popular [条数] / fish browse bilibili search <关键词> [条数]');
        process.exitCode = 1;
        return;
      }
      const { BilibiliAdapter } = await import('../src/adapters/bilibili.js');
      const adapter = new BilibiliAdapter();
      let items;
      if (sub === 'popular') {
        items = await adapter.popular({ ps: Number(rest[0]) || 5 });
      } else if (sub === 'search') {
        const kw = rest.slice(0, -1).join(' ') || rest[0];
        const ps = Number(rest[rest.length - 1]) || 5;
        items = await adapter.search(kw, { pageSize: ps });
      } else {
        console.error('用法：fish browse bilibili popular [条数] 或 fish browse bilibili search <关键词> [条数]');
        process.exitCode = 1;
        return;
      }
      const evs = await fish.ingestContent(items);
      console.log(`已摄取 ${items.length} 条 B站内容（event ${evs.length} 条）：`);
      for (const it of items) console.log(`- ${it.title} ｜ UP: ${it.author} ｜ 播放 ${it.stats.view}`);
      break;
    }
    default:
      console.log(`fish-os 数字生命 CLI
用法: fish <command> [args]

  status                      结构化运行状态（Character OS Bridge）
  state                       角色当前情绪与状态
  remember <type> <内容>       写入记忆（type: episodic|semantic|relational|interest|self）
  recall <关键词>              检索记忆
  export                      导出全部记忆
  forget <id>                 删除单条记忆
  delete                      删除全部记忆
  act publish <文本>           发起一次发布意图（默认需审批，返回待审批 id）
  approve <id>                批准某次审批
  deny <id>                   拒绝某次审批
  browse bilibili popular [n]  B站热门（只读）
  browse bilibili search <kw> [n]  B站搜索（只读）
  proactive-on / proactive-off  打开/关闭主动行为总开关`);
    }
}

main().catch((e) => {
  console.error(`错误：${e?.message ?? e}`);
  if (process.env.DEBUG) console.error(e?.stack);
  process.exit(1);
});
