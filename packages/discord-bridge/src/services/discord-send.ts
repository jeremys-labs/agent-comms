const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/**
 * Splits message content into Discord-safe chunks (<= maxLength chars each),
 * breaking on newline boundaries when a line fits and hard-splitting lines that
 * are longer than the limit on their own.
 */
export function splitDiscordContent(text: string, maxLength = DISCORD_MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (line.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < line.length; index += maxLength) {
        chunks.push(line.slice(index, index + maxLength));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Extracts a Discord rate-limit retry delay (ms) from a 429 response, preferring
 * the JSON body `retry_after` (seconds) and falling back to the `retry-after`
 * header. Returns null when neither source is parseable.
 */
export function parseRetryAfterMs(headers: Record<string, string | string[] | undefined>, body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    if (typeof parsed.retry_after === 'number' && Number.isFinite(parsed.retry_after)) {
      return Math.ceil(parsed.retry_after * 1000);
    }
  } catch {
    // fall through to header
  }

  const header = headers['retry-after'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (headerValue !== undefined) {
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
  }

  return null;
}
