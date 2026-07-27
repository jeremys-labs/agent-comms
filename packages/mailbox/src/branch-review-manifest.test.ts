import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBranchReviewManifest } from './branch-review-manifest.js';

const temporaryDirectories: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function write(repo: string, relativePath: string, content: string): void {
  const target = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-manifest-'));
  temporaryDirectories.push(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  write(repo, 'README.md', 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['switch', '-c', 'feature']);
  return repo;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('buildBranchReviewManifest', () => {
  it('surfaces multi-subsystem scope, default-on activation, and observed tests', () => {
    const repo = createRepo();
    write(repo, 'src/delivery.ts', 'export const delivery = true;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'add delivery diagnostics']);
    write(
      repo,
      'src/auto-heal.ts',
      "export const enabled = process.env.AGENT_AUTO_HEAL_ENABLED !== 'off';\n",
    );
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'add auto heal actuator']);

    const manifest = buildBranchReviewManifest({
      repoPath: repo,
      baseRef: 'main',
      branchRef: 'feature',
      testCommand: "printf '2 tests passed\\n'",
    });

    expect(manifest).toContain('add delivery diagnostics');
    expect(manifest).toContain('src/delivery.ts');
    expect(manifest).toContain('add auto heal actuator');
    expect(manifest).toContain(
      "src/auto-heal.ts: +export const enabled = process.env.AGENT_AUTO_HEAL_ENABLED !== 'off'",
    );
    expect(manifest).toContain("command: `printf '2 tests passed");
    expect(manifest).toContain('observed exit code: 0');
    expect(manifest).toContain('2 tests passed');
    expect(manifest).not.toContain('owner:');
    expect(manifest).not.toContain('status/blocker:');
  });

  it('emits an explicit no-activation statement and records failing tests', () => {
    const repo = createRepo();
    write(repo, 'src/plain.ts', 'export const value = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'plain change']);

    const manifest = buildBranchReviewManifest({
      repoPath: repo,
      baseRef: 'main',
      branchRef: 'feature',
      testCommand: "printf 'failure detail\\n' >&2; exit 7",
    });

    expect(manifest).toContain('No activation or default flags changed');
    expect(manifest).toContain('observed exit code: 7');
    expect(manifest).toContain('failure detail');
  });

  it('refuses to attribute tests to a branch that is not checked out', () => {
    const repo = createRepo();
    write(repo, 'src/plain.ts', 'export const value = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'plain change']);
    git(repo, ['switch', 'main']);

    expect(() => buildBranchReviewManifest({
      repoPath: repo,
      baseRef: 'main',
      branchRef: 'feature',
      testCommand: "printf 'not actually feature tests\\n'",
    })).toThrow(/Refusing to attribute test output/);
  });
});
