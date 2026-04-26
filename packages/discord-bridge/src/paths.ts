import fs from 'fs';
import os from 'os';
import path from 'path';

export function resolveContentRoot(): string {
  return process.env.AGENT_COMMS_CONTENT_ROOT
    ?? process.env.CONTENT_ROOT
    ?? path.join(os.homedir(), '.agent-comms', 'discord-bridge');
}

export function ensureBridgeDirs(contentRoot: string): void {
  for (const relative of ['bridge', 'bridge/inbox', 'bridge/runtime-state']) {
    fs.mkdirSync(path.join(contentRoot, relative), { recursive: true });
  }
}
