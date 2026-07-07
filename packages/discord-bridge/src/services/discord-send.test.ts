import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs, splitDiscordContent } from './discord-send.js';

describe('splitDiscordContent', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(splitDiscordContent('hello world', 2000)).toEqual(['hello world']);
  });

  it('splits a 4500-char single-line message into <=2000-char parts', () => {
    const text = 'x'.repeat(4500);
    const parts = splitDiscordContent(text, 2000);

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.length)).toEqual([2000, 2000, 500]);
    expect(parts.every((part) => part.length <= 2000)).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  it('breaks on newline boundaries when possible', () => {
    const line = 'a'.repeat(1200);
    const other = 'b'.repeat(1200);
    const parts = splitDiscordContent(`${line}\n${other}`, 2000);

    expect(parts).toEqual([line, other]);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads retry_after seconds from the JSON body and converts to ms', () => {
    expect(parseRetryAfterMs({}, '{"retry_after":1.5,"message":"rate limited"}')).toBe(1500);
  });

  it('falls back to the retry-after header when the body has none', () => {
    expect(parseRetryAfterMs({ 'retry-after': '2' }, 'not-json')).toBe(2000);
  });

  it('returns null when neither source is parseable', () => {
    expect(parseRetryAfterMs({}, 'not-json')).toBeNull();
  });
});
