import fs from 'fs';
import os from 'os';
import path from 'path';
import type { A2ATaskRecord, A2ATaskState } from './types.js';

export function resolveA2AStateDir(): string {
  return process.env.A2A_GATEWAY_STATE_DIR
    ?? path.join(os.homedir(), '.agent-comms', 'a2a-gateway');
}

export interface A2ATaskListOptions {
  agentKey?: string;
  state?: A2ATaskState;
  limit?: number;
}

export class A2ATaskStore {
  private filePath: string;

  constructor(stateDir = resolveA2AStateDir()) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, 'tasks.jsonl');
  }

  append(record: A2ATaskRecord): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
  }

  updateState(id: string, state: A2ATaskState): A2ATaskRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const updated = { ...existing, state, updatedAt: new Date().toISOString() };
    this.append(updated);
    return updated;
  }

  update(record: A2ATaskRecord): A2ATaskRecord {
    const updated = { ...record, updatedAt: new Date().toISOString() };
    this.append(updated);
    return updated;
  }

  get(id: string): A2ATaskRecord | null {
    if (!fs.existsSync(this.filePath)) return null;
    const lines = fs.readFileSync(this.filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = JSON.parse(lines[index]!) as A2ATaskRecord;
      if (record.id === id) return record;
    }
    return null;
  }

  listLatest(options: A2ATaskListOptions = {}): A2ATaskRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    const limit = options.limit && options.limit > 0 ? options.limit : 20;
    const lines = fs.readFileSync(this.filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const records: A2ATaskRecord[] = [];

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = JSON.parse(lines[index]!) as A2ATaskRecord;
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      if (options.agentKey && record.agentKey !== options.agentKey) continue;
      if (options.state && record.state !== options.state) continue;
      records.push(record);
      if (records.length >= limit) break;
    }

    return records;
  }
}
