import fs from 'node:fs';
import path from 'node:path';
import { defaultTokenFile, resolveA2APaths, type A2APaths } from './paths.js';
import type { A2APeer, A2APeerRegistry } from './types.js';

const EMPTY_REGISTRY: A2APeerRegistry = { version: 1, peers: [] };

export function loadPeerRegistry(paths: A2APaths = resolveA2APaths()): A2APeerRegistry {
  if (!fs.existsSync(paths.peersFile)) return EMPTY_REGISTRY;
  const raw = fs.readFileSync(paths.peersFile, 'utf8');
  if (!raw.trim()) return EMPTY_REGISTRY;
  const parsed = JSON.parse(raw) as A2APeerRegistry;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported peers.json version: ${parsed.version}`);
  }
  return parsed;
}

export function savePeerRegistry(registry: A2APeerRegistry, paths: A2APaths = resolveA2APaths()): void {
  fs.mkdirSync(path.dirname(paths.peersFile), { recursive: true });
  fs.writeFileSync(paths.peersFile, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

export function findPeer(registry: A2APeerRegistry, key: string): A2APeer | undefined {
  return registry.peers.find((p) => p.key === key);
}

export function getPeerOrThrow(key: string, paths: A2APaths = resolveA2APaths()): A2APeer {
  const peer = findPeer(loadPeerRegistry(paths), key);
  if (!peer) throw new Error(`Unknown A2A peer "${key}". Known peers: see ${paths.peersFile}.`);
  return peer;
}

export function upsertPeer(registry: A2APeerRegistry, peer: A2APeer): A2APeerRegistry {
  const existing = registry.peers.findIndex((p) => p.key === peer.key);
  const peers = registry.peers.slice();
  if (existing === -1) peers.push(peer);
  else peers[existing] = peer;
  return { version: 1, peers };
}

export function ensureRegistryDir(paths: A2APaths = resolveA2APaths()): void {
  fs.mkdirSync(paths.a2aDir, { recursive: true });
}

/**
 * Seed the registry with a single peer if the file doesn't exist yet. Used by
 * the CLI's `init` command and integration tests.
 */
export function seedDefaultPeer(peer: A2APeer, paths: A2APaths = resolveA2APaths()): A2APeerRegistry {
  ensureRegistryDir(paths);
  if (fs.existsSync(paths.peersFile)) return loadPeerRegistry(paths);
  const registry: A2APeerRegistry = {
    version: 1,
    peers: [
      {
        ...peer,
        tokenFile: peer.tokenFile || defaultTokenFile(peer.key, paths),
      },
    ],
  };
  savePeerRegistry(registry, paths);
  return registry;
}
