import fs from 'node:fs';
import path from 'node:path';

export type DiscordPostInventory = {
  version: 1;
  roots: Array<{ name: string; path: string }>;
  allowlist: Array<{
    root: string;
    path: string;
    disposition: 'canonical_transport' | 'live_noninteractive_bypass' | 'dormant_bypass';
    reason: string;
  }>;
};

export type DiscordPostFinding = {
  root: string;
  path: string;
};

export type DiscordPostBoundaryResult = {
  ok: boolean;
  findings: DiscordPostFinding[];
  unexpected: DiscordPostFinding[];
  staleAllowlist: Array<{ root: string; path: string }>;
};

const SOURCE_EXTENSIONS = new Set(['.bash', '.cjs', '.js', '.mjs', '.sh', '.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set([
  '.claude',
  '.codex',
  '.git',
  'archive',
  'archives',
  'build',
  'coverage',
  'dist',
  'memory',
  'node_modules',
  'sessions',
]);

function parseInventory(value: unknown): DiscordPostInventory {
  if (!value || typeof value !== 'object') throw new Error('inventory must be an object');
  const raw = value as Partial<DiscordPostInventory>;
  if (raw.version !== 1) throw new Error('inventory version must be 1');
  if (!Array.isArray(raw.roots) || !Array.isArray(raw.allowlist)) {
    throw new Error('inventory roots and allowlist must be arrays');
  }

  const rootNames = new Set<string>();
  for (const root of raw.roots) {
    if (!root || typeof root.name !== 'string' || typeof root.path !== 'string' || !path.isAbsolute(root.path)) {
      throw new Error('each inventory root needs a name and absolute path');
    }
    if (rootNames.has(root.name)) throw new Error(`duplicate inventory root ${root.name}`);
    rootNames.add(root.name);
  }
  for (const entry of raw.allowlist) {
    if (!entry || !rootNames.has(entry.root) || typeof entry.path !== 'string' || path.isAbsolute(entry.path)) {
      throw new Error('each allowlist entry must name a known root and relative path');
    }
    if (!['canonical_transport', 'live_noninteractive_bypass', 'dormant_bypass'].includes(entry.disposition)) {
      throw new Error(`invalid disposition for ${entry.root}:${entry.path}`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      throw new Error(`allowlist reason is missing for ${entry.root}:${entry.path}`);
    }
  }
  return raw as DiscordPostInventory;
}

export function loadDiscordPostInventory(filePath: string): DiscordPostInventory {
  return parseInventory(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function isCandidateFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.includes('.test.') || base.includes('.spec.') || base.includes('.bak-')) return false;
  return SOURCE_EXTENSIONS.has(path.extname(base));
}

function walkSourceFiles(rootPath: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(fullPath);
      } else if (entry.isFile() && isCandidateFile(fullPath)) {
        files.push(fullPath);
      }
    }
  };
  visit(rootPath);
  return files;
}

export function containsRawDiscordMessagePost(source: string): boolean {
  const discordHost = new RegExp(['discord', '\\.com'].join(''), 'i');
  const messageEndpoint = /\/api\/v\d+\/channels\/[\s\S]{0,160}?\/messages\b/i;
  const postMethod = /(?:method\s*:\s*['"]POST['"]|(?:^|\s)-X\s+POST\b)/im;
  return discordHost.test(source) && messageEndpoint.test(source) && postMethod.test(source);
}

export function checkDiscordPostBoundary(inventory: DiscordPostInventory): DiscordPostBoundaryResult {
  const findings: DiscordPostFinding[] = [];
  for (const root of inventory.roots) {
    if (!fs.existsSync(root.path) || !fs.statSync(root.path).isDirectory()) {
      throw new Error(`inventory root is unavailable: ${root.name} (${root.path})`);
    }
    for (const filePath of walkSourceFiles(root.path)) {
      if (containsRawDiscordMessagePost(fs.readFileSync(filePath, 'utf8'))) {
        findings.push({ root: root.name, path: path.relative(root.path, filePath) });
      }
    }
  }

  const findingKeys = new Set(findings.map((finding) => `${finding.root}:${finding.path}`));
  const allowlistKeys = new Set(inventory.allowlist.map((entry) => `${entry.root}:${entry.path}`));
  const unexpected = findings.filter((finding) => !allowlistKeys.has(`${finding.root}:${finding.path}`));
  const staleAllowlist = inventory.allowlist
    .filter((entry) => !findingKeys.has(`${entry.root}:${entry.path}`))
    .map(({ root, path: relativePath }) => ({ root, path: relativePath }));

  return {
    ok: unexpected.length === 0 && staleAllowlist.length === 0,
    findings,
    unexpected,
    staleAllowlist,
  };
}
