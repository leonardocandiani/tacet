import { describe, expect, test } from 'bun:test';
import { redact } from './redact';

describe('masking credentials on the way to the log', () => {
  test('masks the shapes that actually leak', () => {
    const cases = [
      'openai http 401: {"error":"invalid key sk-proj-abcdefghijklmnopqrstuvwx"}',
      'gemini refused AIzaSyD-EXAMPLEKEY1234567890abcdefg',
      'git failed with ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      "curl -H 'Authorization: Bearer eyJhbGciOi.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4f',",
    ];
    for (const line of cases) {
      const masked = redact(line);
      expect(masked, line).toContain('[redacted]');
      expect(masked).not.toContain('sk-proj-abcdefghijklmnopqrstuvwx');
      expect(masked).not.toContain('AIzaSyD-EXAMPLEKEY1234567890abcdefg');
      expect(masked).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    }
  });

  test('keeps the label so the message still says what failed', () => {
    // Losing the label would leave "[redacted] https://api" and an operator with
    // no idea which header was rejected.
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]');
  });

  test('leaves ordinary text alone', () => {
    const line = 'anthropic http 529: overloaded, retrying in 2s';
    expect(redact(line)).toBe(line);
  });
});
