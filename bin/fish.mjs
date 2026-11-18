#!/usr/bin/env node
import { Fish } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import { acquireRunLock } from '../src/storage/run-lock.js';
import { FactStore, ITEMS } from '../src/memory/facts.js';
import { countPersonData, deletePersonData } from '../src/memory/forget.js';
import { parsePersonKey } from '../src/memory/place.js';

// CLI 是运维工具。查看事实不按地方隔离，能看到全部；聊天流程只能经 FactStore.inView 读。

function factForOutput(f) {
  return {
    id: f.id,
    item: ITEMS[f.item].label,
    content: f.content,
    about: f.subject,
    place: f.placeKey,
    quote: f.sourceQuote,
    saidAt: f.saidAt.toISOString(),
    expiresAt: f.expiresAt.toISOString(),
  };
}

// 北京时间，例如 11-18 23:20。
function beijingTime(date, { year = false } = {}) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return year ? `${get('year')}-${get('month')}-${get('day')}` : `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

const placeLabel = (f) => (f.placeKind === 'private' ? '私聊' : `群 ${f.placeKey.split(':').pop()}`);
const whoLabel = (f) => (f.item === 'group_event' ? '这个群' : `QQ ${f.subject.split(':').pop()}`);

// 给人看的事实列表。
function printFacts(title, facts) {
  console.log(`${title}：${facts.length ? `共 ${facts.length} 条` : '还没有'}`);
  for (const f of facts) {
    console.log(`  [${f.id}] ${ITEMS[f.item].label}：${f.content}`);
    console.log(`       关于 ${whoLabel(f)} · 出自${placeLabel(f)} · ${beijingTime(f.saidAt)} 说的 · ${beijingTime(f.expiresAt, { year: true })} 删除`);
    console.log(`       原话：“${f.sourceQuote}”`);
  }
}

// 按人删除（docs/memory-v2-design.md 第 8 节）。不加 --yes 只预览条数；加了 --yes 先拿运行锁，拿不到说明机器人还在跑，拒绝。
async function forgetPerson(fish, personKey, yes) {
  if (!parsePersonKey(personKey)) {
    console.error('用法：fish forget-person <人的 key，例如 qq:user:101> --yes');
    process.exitCode = 1;
    return;
  }
  const args = { tenantId: fish.tenantId, personKey };
  if (!yes) {
    const counts = await countPersonData(fish.db, args); // 只读，不删
    console.log(JSON.stringify({ preview: counts }, null, 2));
    console.error('以上是将要删除的条数，没有删除任何数据。确认删除：先停掉机器人，再加 --yes 重新执行。');
    process.exitCode = 1;
    return;
  }
  let lock;
  try {
    lock = await acquireRunLock({ databaseUrl: process.env.DATABASE_URL, heartbeatMs: 0 });
  } catch (error) {
    if (error?.code !== 'RUN_LOCK_BUSY') throw error;
    console.error('机器人正在运行（运行锁被占用），拒绝删除：请先停掉机器人，删完再启动。');
    process.exitCode = 1;
    return;
  }
  try {
    const deleted = await lock.transaction((tx) => deletePersonData(tx, args));
    console.log(JSON.stringify({ deleted }, null, 2));
  } finally {
    await lock.close();
  }
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
    case 'facts': {
      const [target, ...rest] = args;
      if (!target) {
        console.error('用法：fish facts <QQ 号或群号>（也可以写完整的 key，例如 qq:user:101、qq:group:200）；加 --json 输出原始数据');
        process.exitCode = 1;
        return;
      }
      const store = new FactStore({ db: fish.db, tenantId: fish.tenantId });
      // 只写号码时，QQ 号和群号都查一遍（分不清是人还是群）。
      const keys = /^\d+$/.test(target) ? [`qq:user:${target}`, `qq:group:${target}`] : [target];
      const lists = await Promise.all(keys.map((key) => store.list(key)));
      if (rest.includes('--json')) {
        out(lists.flat().map(factForOutput));
        break;
      }
      keys.forEach((key, i) => {
        if (keys.length > 1 && !lists[i].length && i > 0) return; // 号码查群没结果时不多打一行
        const [, kind, id] = key.split(':');
        printFacts(kind === 'group' ? `群 ${id} 里记下的事` : `关于 QQ ${id} 记下的事`, lists[i]);
      });
      break;
    }
    case 'fact-forget': {
      const removed = await new FactStore({ db: fish.db, tenantId: fish.tenantId }).forget(args[0]);
      if (!removed) {
        console.error(`没有编号为 ${args[0] ?? '（空）'} 的事实`);
        process.exitCode = 1;
        return;
      }
      out({ removed: factForOutput(removed) });
      break;
    }
    case 'forget-person':
      await forgetPerson(fish, args.find((a) => a !== '--yes'), args.includes('--yes'));
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
  facts <QQ 号或群号>          列出奶蛙记下的事：内容、出自哪里、原话、什么时候删除（--json 输出原始数据）
  fact-forget <编号>           删除一条事实
  forget-person <key> --yes   删除这个人的数据（事实、原话、关系、代号）；必须先停机器人。不加 --yes 只预览条数
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
