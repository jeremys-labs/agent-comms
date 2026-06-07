import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBlueBubblesAdapter,
  createBlueBubblesPolicy,
  extractBlueBubblesAddress,
  loadBlueBubblesConfig,
} from './index.js';

const config = {
  baseUrl: 'http://localhost:1234',
  password: 'secret',
  allowFrom: ['+15551234567'],
};

afterEach(() => vi.restoreAllMocks());

describe('BlueBubbles outbound adapter', () => {
  it('loads credentials and allowlist from channel state', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-adapter-'));
    fs.writeFileSync(path.join(stateDir, '.env'), 'BLUEBUBBLES_URL=http://bb.local\nBLUEBUBBLES_PASSWORD=pw\n');
    fs.writeFileSync(path.join(stateDir, 'access.json'), JSON.stringify({ allowFrom: ['+15551234567'] }));

    expect(loadBlueBubblesConfig({ stateDir })).toEqual({
      baseUrl: 'http://bb.local',
      password: 'pw',
      allowFrom: ['+15551234567'],
    });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('enforces the existing outbound allowlist policy', () => {
    expect(extractBlueBubblesAddress('iMessage;-;+15551234567')).toBe('+15551234567');
    const policy = createBlueBubblesPolicy(config);
    expect(policy({
      id: '1', channel: 'bluebubbles', fromAgent: 'isla',
      destination: 'iMessage;-;+15551234567', text: 'ok',
    }).allowed).toBe(true);
    expect(policy({
      id: '2', channel: 'bluebubbles', fromAgent: 'isla',
      destination: 'iMessage;-;+19999999999', text: 'no',
    }).allowed).toBe(false);
  });

  it('sends allowlisted text through the BlueBubbles REST API', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { guid: 'bb-guid-1' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createBlueBubblesAdapter(config).deliver({
      id: 'delivery-1',
      channel: 'bluebubbles',
      fromAgent: 'isla',
      destination: 'iMessage;-;+15551234567',
      text: 'Hello',
    });

    expect(result.transportMessageId).toBe('bb-guid-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:1234/api/v1/message/text?password=secret',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('refuses non-allowlisted delivery before calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createBlueBubblesAdapter(config).deliver({
      id: 'delivery-2',
      channel: 'bluebubbles',
      fromAgent: 'isla',
      destination: 'iMessage;-;+19999999999',
      text: 'Hello',
    })).rejects.toThrow('not allowlisted');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
