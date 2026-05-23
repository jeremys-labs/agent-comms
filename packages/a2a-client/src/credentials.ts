import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Read a bearer token from disk. Trims trailing whitespace/newline so editor
 * autosaves don't corrupt the value.
 */
export function readTokenFile(tokenFile: string): string {
  const raw = fs.readFileSync(tokenFile, 'utf8');
  return raw.replace(/[\r\n\s]+$/, '');
}

/**
 * Short, non-reversible identifier we can put in audit rows and log lines
 * without leaking the bearer itself.
 */
export function tokenFingerprint(token: string): string {
  const full = crypto.createHash('sha256').update(token).digest('hex');
  return `sha256:${full.slice(0, 12)}`;
}
