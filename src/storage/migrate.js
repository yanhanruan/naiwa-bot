import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
// 任意固定数字：同一时刻只允许一个进程执行迁移。
const MIGRATION_LOCK = 4_204_201;

// 按文件名顺序执行 migrations/NNN_*.sql 中尚未执行的文件。全部放在一个事务里：任何一个失败，本次都不生效。
export async function migrate(db, { dir = MIGRATIONS_DIR } = {}) {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied = [];
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await tx.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await tx.exec(sql);
      } catch (error) {
        throw new Error(`迁移 ${file} 失败：${error.message}`);
      }
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      applied.push(file);
    }
  });
  return applied;
}
