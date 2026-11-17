import { connectPGlite, connectPostgres } from './database.js';
import { migrate } from './migrate.js';

export { connectPGlite, connectPostgres, migrate };

// 打开 PostgreSQL 并执行未完成的迁移。连不上或迁移失败都直接抛错：宁可启动失败，也不以空数据运行。
export async function openStorage({ databaseUrl = process.env.DATABASE_URL, migrateOnOpen = true } = {}) {
  const db = await connectPostgres(databaseUrl);
  try {
    if (migrateOnOpen) await migrate(db);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  return db;
}

// 测试和本地试验用：进程内的 PostgreSQL（PGlite）。不传 dataDir 时数据只在内存里。
export async function openTestStorage({ dataDir } = {}) {
  const db = await connectPGlite(dataDir);
  await migrate(db);
  return db;
}
