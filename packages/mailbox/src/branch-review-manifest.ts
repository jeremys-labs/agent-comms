import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface BranchReviewManifestOptions {
  repoPath: string;
  baseRef: string;
  branchRef: string;
  testCommand: string;
}

interface TestResult {
  exitCode: number;
  output: string;
}

const ACTIVATION_PATTERN =
  /\b(process\.env|Deno\.env|os\.environ|getenv|[A-Z][A-Z0-9_]*(?:ENABLED|DISABLED|ROLLOUT|ALLOWLIST)|(?:on|off) by default|===\s*['"]on['"]|!==\s*['"]off['"])/i;

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function validateRepo(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) throw new Error(`Repository path does not exist: ${resolved}`);
  git(resolved, ['rev-parse', '--is-inside-work-tree']);
  return resolved;
}

function runTest(repoPath: string, command: string): TestResult {
  const result = spawnSync('/bin/zsh', ['-lc', command], {
    cwd: repoPath,
    encoding: 'utf8',
    env: process.env,
  });
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return {
    exitCode: result.status ?? 1,
    output: combined.slice(-4_000) || '(no output)',
  };
}

function commitInventory(repoPath: string, baseRef: string, branchRef: string): string[] {
  const cherry = git(repoPath, ['cherry', baseRef, branchRef]);
  if (!cherry) return [];
  return cherry.split('\n').map((line) => {
    const [state, sha] = line.trim().split(/\s+/, 3);
    const subject = git(repoPath, ['show', '-s', '--format=%s', sha!]);
    const files = git(repoPath, ['show', '--format=', '--name-only', sha!])
      .split('\n')
      .filter(Boolean);
    return `${state} ${sha} ${subject}\n  files: ${files.join(', ') || '(none)'}`;
  });
}

function activationChanges(repoPath: string, baseRef: string, branchRef: string): string[] {
  const diff = git(repoPath, ['diff', '--unified=0', `${baseRef}...${branchRef}`]);
  const changes: string[] = [];
  let currentFile = '(unknown file)';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length);
      continue;
    }
    if (/^[+-](?![+-])/.test(line) && ACTIVATION_PATTERN.test(line)) {
      changes.push(`${currentFile}: ${line}`);
    }
  }
  return changes;
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}

export function buildBranchReviewManifest(options: BranchReviewManifestOptions): string {
  const repoPath = validateRepo(options.repoPath);
  git(repoPath, ['rev-parse', '--verify', options.baseRef]);
  git(repoPath, ['rev-parse', '--verify', options.branchRef]);
  const headCommit = git(repoPath, ['rev-parse', 'HEAD']);
  const branchCommit = git(repoPath, ['rev-parse', options.branchRef]);
  if (headCommit !== branchCommit) {
    throw new Error(
      `Refusing to attribute test output to ${options.branchRef}: `
      + `worktree HEAD is ${headCommit}, target is ${branchCommit}`,
    );
  }

  const commits = commitInventory(repoPath, options.baseRef, options.branchRef);
  const diffStat = git(repoPath, ['diff', '--stat', `${options.baseRef}...${options.branchRef}`])
    || '(no diff)';
  const activation = activationChanges(repoPath, options.baseRef, options.branchRef);
  const test = runTest(repoPath, options.testCommand);

  return [
    '# Branch Review Evidence',
    '',
    '## Git Evidence',
    '',
    `base: ${options.baseRef} (${git(repoPath, ['rev-parse', options.baseRef])})`,
    `branch: ${options.branchRef} (${branchCommit})`,
    '',
    '### Commit Inventory (`git cherry`)',
    '',
    fenced(commits.join('\n') || '(no unlanded commits)'),
    '',
    '### Diffstat',
    '',
    fenced(diffStat),
    '',
    '### Activation / Default Changes',
    '',
    activation.length > 0
      ? fenced(activation.join('\n'))
      : 'No activation or default flags changed (pattern scan found none).',
    '',
    '## Tests Run',
    '',
    `command: \`${options.testCommand}\``,
    `observed exit code: ${test.exitCode}`,
    fenced(test.output),
    '',
  ].join('\n');
}
