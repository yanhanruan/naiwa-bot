#!/usr/bin/env node
// 把旧版 JSON 数据目录导入 PostgreSQL。可重复执行；原 JSON 不改动。
// 用法：
//   node --env-file=.env scripts/import-json.mjs --from data/naiwa            # 导入到 DATABASE_URL
//   node scripts/import-json.mjs --from data/naiwa --dry-run                  # 演练：导入到临时内存数据库，只看报告
// 选项：--tenant <id>（默认 default）
import { parseArgs } from 'node:util';
import { loadLegacyData, importLegacyData } from '../src/storage/import-json.js';
import { openStorage, openTestStorage } from '../src/storage/index.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    tenant: { type: 'string', default: 'default' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!values.from) {
  console.error('用法：scripts/import-json.mjs --from <旧数据目录> [--tenant default] [--dry-run]');
  process.exit(1);
}

const data = loadLegacyData(values.from);
const db = values['dry-run'] ? await openTestStorage() : await openStorage();
try {
  const report = await importLegacyData(db, data, { tenantId: values.tenant });
  const { memories: m, events: e, character: c } = report;
  console.log(`${values['dry-run'] ? '[演练，未写入真实数据库] ' : ''}导入完成（租户 ${report.tenantId}）`);
  if (report.missingFiles.length) console.log(`  缺少文件（按空处理）：${report.missingFiles.join(', ')}`);
  console.log(`  记忆：源 ${m.source}，新导入 ${m.imported}，之前已导入 ${m.alreadyImported}，同范围重复内容合并 ${m.duplicateContent.length}`);
  console.log(`  事件：源 ${e.source}，新导入 ${e.imported}，之前已导入 ${e.alreadyImported}`);
  console.log(`  角色状态：${c.state === 'imported' ? '已导入' : c.state === 'kept-existing' ? '库中已有，保持不变' : '无'}`);
  console.log(`  兴趣：源 ${c.interests.source}，新导入 ${c.interests.imported}，保留库中已有 ${c.interests.kept}`);
  console.log(`  关系：源 ${c.relationships.source}，新导入 ${c.relationships.imported}，保留库中已有 ${c.relationships.kept}`);
  console.log('  核对通过：每条源记录都在库中（或按去重规则合并）。');
} finally {
  await db.close();
}
