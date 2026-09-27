import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDiscordPostBoundary,
  containsRawDiscordMessagePost,
  type DiscordPostInventory,
} from './discord-post-boundary.js';

const roots: string[] = [];

function fixtureInventory(rootPath: string): DiscordPostInventory {
  return {
    version: 1,
    roots: [{ name: 'fixture', path: rootPath }],
    allowlist: [{
      root: 'fixture',
      path: 'canonical.ts',
      disposition: 'canonical_transport',
      reason: 'Fixture canonical transport is the only accepted raw sender.',
    }],
  };
}

function rawPost(): string {
  return [
    "fetch('https://discord.com/api/v10/channels/123/messages', {",
    "  method: 'POST',",
    '});',
  ].join('\n');
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Discord raw POST boundary', () => {
  it('recognizes message POSTs but not Discord history reads', () => {
    expect(containsRawDiscordMessagePost(rawPost())).toBe(true);
    expect(containsRawDiscordMessagePost(
      "fetch('https://discord.com/api/v10/channels/123/messages?limit=10', { method: 'GET' });",
    )).toBe(false);
  });

  it('passes with only the inventoried canonical transport', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-post-boundary-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'canonical.ts'), rawPost());
    expect(checkDiscordPostBoundary(fixtureInventory(root))).toMatchObject({
      ok: true,
      unexpected: [],
      staleAllowlist: [],
    });
  });

  it('fails when a new raw Discord message POST appears outside the inventory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-post-boundary-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'canonical.ts'), rawPost());
    fs.writeFileSync(path.join(root, 'new-bypass.ts'), rawPost());
    const result = checkDiscordPostBoundary(fixtureInventory(root));
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([{ root: 'fixture', path: 'new-bypass.ts' }]);
  });

  it('fails if an allowlisted sender disappears so inventory cannot go stale', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-post-boundary-'));
    roots.push(root);
    const result = checkDiscordPostBoundary(fixtureInventory(root));
    expect(result.ok).toBe(false);
    expect(result.staleAllowlist).toEqual([{ root: 'fixture', path: 'canonical.ts' }]);
  });
});
