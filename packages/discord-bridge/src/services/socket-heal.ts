import fs from 'fs';

/**
 * Builds a poll callback that watches a unix socket path and invokes reListen
 * once when the file disappears (e.g. a stray `rm -f /tmp/*`). It fires only on
 * the present->absent transition so a slow re-bind isn't hammered every tick.
 */
export function makeSocketHealthCheck(socketPath: string, reListen: () => void): () => void {
  let present = true;
  return () => {
    if (fs.existsSync(socketPath)) {
      present = true;
      return;
    }
    if (present) {
      present = false;
      reListen();
    }
  };
}
