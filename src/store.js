import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// 极简 JSON 持久化（原子写：先写临时文件再 rename，避免写一半损坏）。
export class JsonStore {
  constructor(file) {
    this.file = file;
  }

  exists() {
    return existsSync(this.file);
  }

  load() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(value) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
