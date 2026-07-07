import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSocketHealthCheck } from './socket-heal.js';

describe('makeSocketHealthCheck', () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-heal-'));
    socketPath = path.join(tmpDir, 'bridge.sock');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does nothing while the socket file exists (C3)', () => {
    fs.writeFileSync(socketPath, '');
    const reListen = vi.fn();
    makeSocketHealthCheck(socketPath, reListen)();
    expect(reListen).not.toHaveBeenCalled();
  });

  it('re-listens once when the socket file disappears (C3)', () => {
    const reListen = vi.fn();
    const check = makeSocketHealthCheck(socketPath, reListen);

    check();
    expect(reListen).toHaveBeenCalledTimes(1);

    // Simulate the reListen having recreated the socket; no further re-listen.
    fs.writeFileSync(socketPath, '');
    check();
    expect(reListen).toHaveBeenCalledTimes(1);
  });
});
