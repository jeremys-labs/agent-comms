import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactForProject } from './audit.js';
import { fetchAgentCard, getTask, sendMessage } from './client.js';
import { tokenFingerprint } from './credentials.js';
import { resolveA2APaths, defaultTokenFile } from './paths.js';
import { appendPendingRow, readPendingRows, expiryFromSentAt } from './pending.js';
import { loadPeerRegistry, savePeerRegistry, seedDefaultPeer, upsertPeer } from './registry.js';
import { sendAndTrack } from './send-and-track.js';
import type { A2APeer } from './types.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-client-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function paths() {
  return resolveA2APaths(tmp);
}

function samplePeer(overrides: Partial<A2APeer> = {}): A2APeer {
  const tokenFile = overrides.tokenFile ?? defaultTokenFile('tomegibson', paths());
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, 'fake-bearer-value-123', { mode: 0o600 });
  return {
    key: 'tomegibson',
    label: 'Tom Egibson Fleet',
    baseUrl: 'https://agents.tomegibson.com',
    tokenFile,
    ...overrides,
  };
}

describe('paths', () => {
  it('honors MCC_TMUX_HOME override', () => {
    const p = resolveA2APaths(tmp);
    expect(p.a2aDir).toBe(path.join(tmp, 'a2a'));
    expect(p.peersFile).toBe(path.join(tmp, 'a2a', 'peers.json'));
    expect(p.secretsDir).toBe(path.join(tmp, 'secrets'));
  });
});

describe('registry', () => {
  it('returns an empty registry when the file does not exist', () => {
    const reg = loadPeerRegistry(paths());
    expect(reg).toEqual({ version: 1, peers: [] });
  });

  it('round-trips through save + load', () => {
    const peer = samplePeer();
    savePeerRegistry({ version: 1, peers: [peer] }, paths());
    expect(loadPeerRegistry(paths()).peers[0]?.key).toBe('tomegibson');
  });

  it('upsertPeer replaces by key', () => {
    const peer = samplePeer();
    const reg = upsertPeer({ version: 1, peers: [] }, peer);
    const updated = upsertPeer(reg, { ...peer, label: 'New label' });
    expect(updated.peers).toHaveLength(1);
    expect(updated.peers[0]?.label).toBe('New label');
  });

  it('seedDefaultPeer creates the file when missing and is a no-op otherwise', () => {
    const peer = samplePeer();
    const created = seedDefaultPeer(peer, paths());
    expect(created.peers[0]?.key).toBe('tomegibson');
    // second call should not overwrite
    const second = seedDefaultPeer({ ...peer, label: 'Should not stick' }, paths());
    expect(second.peers[0]?.label).toBe('Tom Egibson Fleet');
  });
});

describe('credentials', () => {
  it('produces a stable, short fingerprint that never exposes the bearer', () => {
    const fp = tokenFingerprint('totally-secret');
    expect(fp).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(tokenFingerprint('totally-secret')).toBe(fp);
  });
});

describe('pending file', () => {
  it('appends and reads rows; expiry math adds 30 minutes', () => {
    const sentAt = '2026-05-23T18:00:00.000Z';
    appendPendingRow(
      {
        id: 'row-1',
        peer: 'tomegibson',
        baseUrl: 'https://agents.tomegibson.com',
        endpointPath: '/',
        tokenFile: '/tmp/x',
        fromAgent: 'isla',
        skillId: 'code-review',
        taskId: 'task-1',
        project: 'private',
        sentAt,
        expiresAt: expiryFromSentAt(sentAt),
        callbackKind: 'agent-mail',
      },
      paths(),
    );
    const rows = readPendingRows(paths());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.taskId).toBe('task-1');
    expect(rows[0]?.expiresAt).toBe('2026-05-23T18:30:00.000Z');
  });
});

describe('audit redaction', () => {
  it('drops payload for private rows', () => {
    const safe = redactForProject({
      ts: 'now',
      event: 'send',
      peer: 'tomegibson',
      project: 'private',
      tokenFingerprint: 'sha256:abc',
      payload: { text: 'do not log this' },
    } as never);
    expect((safe as { payload?: unknown }).payload).toBeUndefined();
  });

  it('keeps payload for shareable rows', () => {
    const safe = redactForProject({
      ts: 'now',
      event: 'send',
      peer: 'tomegibson',
      project: 'frontdesk',
      tokenFingerprint: 'sha256:abc',
      payload: { text: 'fine to log' },
    } as never);
    expect((safe as { payload?: { text?: string } }).payload?.text).toBe('fine to log');
  });
});

describe('client', () => {
  function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
    return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return responder(url, init);
    }) as typeof fetch;
  }

  it('sendMessage POSTs JSON-RPC and extracts task id', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = fakeFetch((url, init) => {
      captured = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'tsk-1', status: { state: 'submitted' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await sendMessage({
      peer: samplePeer(),
      token: 'fake-bearer',
      skillId: 'code-review',
      text: 'hello',
      requesterId: 'jeremys-fleet:eli',
      fetchImpl,
    });
    expect(result.taskId).toBe('tsk-1');
    expect(captured?.url).toBe('https://agents.tomegibson.com/');
    expect((captured?.body as { method?: string })?.method).toBe('message/send');
  });

  it('sendMessage surfaces JSON-RPC errors', async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'oops' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      sendMessage({
        peer: samplePeer(),
        token: 'fake',
        skillId: 'code-review',
        text: 'hello',
        requesterId: 'jeremys-fleet:eli',
        fetchImpl,
      }),
    ).rejects.toThrow(/JSON-RPC error/);
  });

  it('getTask normalizes terminal states and string-shaped status messages', async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            id: 'tsk-1',
            status: { state: 'failed', message: 'Task timed out waiting for agent reply' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await getTask({ peer: samplePeer(), token: 'fake', taskId: 'tsk-1', fetchImpl });
    expect(result.state).toBe('failed');
    expect(result.text).toBe('Task timed out waiting for agent reply');
  });

  it('fetchAgentCard hits the well-known path', async () => {
    let calledUrl = '';
    const fetchImpl = fakeFetch((url) => {
      calledUrl = url;
      return new Response(JSON.stringify({ name: 'Tom', skills: [{ id: 'code-review' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const card = await fetchAgentCard(samplePeer(), fetchImpl);
    expect(calledUrl).toBe('https://agents.tomegibson.com/.well-known/agent-card.json');
    expect(card['name']).toBe('Tom');
  });
});

describe('sendAndTrack', () => {
  it('writes a pending row + audit row and returns the task id', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'tsk-42', status: { state: 'submitted' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const result = await sendAndTrack({
      peer: samplePeer(),
      fromAgent: 'isla',
      skillId: 'code-review',
      text: 'review this PR diff',
      project: 'private',
      paths: paths(),
      fetchImpl,
    });
    expect(result.taskId).toBe('tsk-42');

    const pending = readPendingRows(paths());
    expect(pending).toHaveLength(1);
    expect(pending[0]?.taskId).toBe('tsk-42');
    expect(pending[0]?.fromAgent).toBe('isla');

    const auditLines = fs.readFileSync(paths().auditFile, 'utf8').trim().split('\n');
    expect(auditLines).toHaveLength(1);
    const audit = JSON.parse(auditLines[0]!);
    expect(audit.project).toBe('private');
    expect(audit.taskId).toBe('tsk-42');
    expect(audit.payload).toBeUndefined(); // private redaction
    expect(audit.tokenFingerprint).toMatch(/^sha256:/);
  });

  it('keeps payload in audit for shareable projects', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'tsk-99', status: { state: 'submitted' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    await sendAndTrack({
      peer: samplePeer(),
      fromAgent: 'isla',
      skillId: 'code-review',
      text: 'shareable payload',
      project: 'frontdesk',
      paths: paths(),
      fetchImpl,
    });
    const audit = JSON.parse(fs.readFileSync(paths().auditFile, 'utf8').trim().split('\n')[0]!);
    expect(audit.payload?.text).toBe('shareable payload');
  });
});
