import fs from 'node:fs';
import path from 'node:path';
import { resolveA2APaths, type A2APaths } from './paths.js';
import { A2A_SHAREABLE_PROJECTS, type A2AAuditRow, type A2AProjectScope } from './types.js';

/**
 * Append a single audit row. Honors Donna's private-by-default rule:
 * payload is redacted before write for `project: 'private'`, full payload is
 * retained for shareable projects.
 */
export function appendAuditRow(row: A2AAuditRow, paths: A2APaths = resolveA2APaths()): void {
  fs.mkdirSync(path.dirname(paths.auditFile), { recursive: true });
  const safe = redactForProject(row);
  fs.appendFileSync(paths.auditFile, `${JSON.stringify(safe)}\n`, { encoding: 'utf8' });
}

export function redactForProject(row: A2AAuditRow): A2AAuditRow {
  if (isShareable(row.project)) return row;
  // private rows: drop payload contents, keep counts + metadata
  const { payload, ...rest } = row as A2AAuditRow & { payload?: unknown };
  void payload;
  return rest as A2AAuditRow;
}

function isShareable(project: A2AProjectScope): boolean {
  return A2A_SHAREABLE_PROJECTS.has(project);
}
