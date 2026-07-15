import { describe, expect, it } from 'vitest';
import { displayConnection, joinDbUrl, maskDbUrl, sanitizeErrorMessage, splitDbUrl } from '../src/shared/url.js';

describe('splitDbUrl / joinDbUrl', () => {
  it('round-trips a URL with a password', () => {
    const raw = 'postgresql://app:s3cr3t@db.example.com:5432/prod';
    const { sansPassword, password } = splitDbUrl(raw);
    expect(password).toBe('s3cr3t');
    expect(sansPassword).not.toContain('s3cr3t');
    expect(joinDbUrl(sansPassword, password)).toBe(raw);
  });

  it('handles URL-encoded passwords', () => {
    const raw = 'postgresql://app:p%40ss%2Fword@localhost:5432/db';
    const { sansPassword, password } = splitDbUrl(raw);
    expect(password).toBe('p@ss/word');
    const rejoined = joinDbUrl(sansPassword, password);
    expect(splitDbUrl(rejoined).password).toBe('p@ss/word');
  });

  it('treats a password-less URL as having no secret', () => {
    const raw = 'postgresql://app@localhost:5432/db';
    const { sansPassword, password } = splitDbUrl(raw);
    expect(password).toBeNull();
    expect(joinDbUrl(sansPassword, null)).toBe(sansPassword);
  });

  it('rejects non-postgres URLs', () => {
    expect(() => splitDbUrl('https://example.com')).toThrow(/unsupported protocol/);
    expect(() => splitDbUrl('not a url')).toThrow(/invalid connection URL/);
  });

  it('gives an actionable error for a raw % in the password', () => {
    expect(() => splitDbUrl('postgresql://app:100%pass@localhost:5432/db')).toThrow(/percent-escape/);
  });
});

describe('maskDbUrl', () => {
  it('masks the password', () => {
    const masked = maskDbUrl('postgresql://app:s3cr3t@localhost:5432/db');
    expect(masked).not.toContain('s3cr3t');
    expect(masked).toContain('•••');
    expect(masked).toContain('app');
    expect(masked).toContain('localhost:5432/db');
  });

  it('masks correctly even when the username itself contains asterisks', () => {
    // Regression guard: a first-occurrence replace() would hit the username.
    const masked = maskDbUrl('postgresql://a***b:s3cr3t@h:5432/db');
    expect(masked).not.toContain('s3cr3t');
    expect(masked).toContain('a***b:•••@');
  });

  it('leaves a password-less URL unchanged', () => {
    expect(maskDbUrl('postgresql://app@h:5432/db')).toBe('postgresql://app@h:5432/db');
  });
});

describe('displayConnection', () => {
  it('shows host:port/db without scheme or username', () => {
    expect(displayConnection('postgresql://app@db.example.com:5432/prod')).toBe('db.example.com:5432/prod');
  });
});

describe('sanitizeErrorMessage', () => {
  it('scrubs full URL and bare password occurrences', () => {
    const url = 'postgresql://app:s3cr3t@localhost:5432/db';
    const msg = `connect failed for ${url} (password "s3cr3t" rejected)`;
    const out = sanitizeErrorMessage(msg, url);
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('(connection URL)');
  });

  it('scrubs the percent-encoded password form too', () => {
    const url = 'postgresql://app:p%40ss@localhost:5432/db';
    const out = sanitizeErrorMessage('auth failed for token p%40ss (decoded p@ss)', url);
    expect(out).not.toContain('p%40ss');
    expect(out).not.toContain('p@ss');
  });
});
