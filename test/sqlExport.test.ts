// The one path where the renderer causes a file to be written. The user picks
// the destination in a native dialog, so nothing here is a silent write — but
// the renderer supplies both the bytes and the name the dialog opens with, and
// neither is taken as given.

import { describe, expect, it } from 'vitest';
import { MAX_SQL_EXPORT_CHARS } from '../src/shared/types.js';
import { suggestedFileName, validateSqlExport } from '../src/main/sqlExport.js';

describe('validateSqlExport', () => {
  it('accepts a bounded string', () => {
    expect(validateSqlExport('COMMENT ON TABLE "a"."b" IS NULL;')).toBe(
      'COMMENT ON TABLE "a"."b" IS NULL;',
    );
    expect(validateSqlExport('x'.repeat(MAX_SQL_EXPORT_CHARS))).toHaveLength(MAX_SQL_EXPORT_CHARS);
  });

  it('refuses anything that is not a non-empty string', () => {
    for (const bad of [undefined, null, 42, {}, [], Buffer.from('x'), '']) {
      expect(() => validateSqlExport(bad)).toThrow();
    }
  });

  it('refuses a payload past the ceiling', () => {
    expect(() => validateSqlExport('x'.repeat(MAX_SQL_EXPORT_CHARS + 1))).toThrow(/exceeds/);
  });
});

describe('suggestedFileName', () => {
  it('keeps an ordinary name and gives it a .sql extension', () => {
    expect(suggestedFileName('shop-comments.sql')).toBe('shop-comments.sql');
    expect(suggestedFileName('shop')).toBe('shop.sql');
    expect(suggestedFileName('SHOP.SQL')).toBe('SHOP.SQL');
  });

  it('flattens a path into a single name', () => {
    // `defaultPath` is read as a PATH: a separator here would choose the
    // directory the dialog opens in, which is the user's call, not the
    // renderer's.
    expect(suggestedFileName('../../etc/passwd')).toBe('etc-passwd.sql');
    expect(suggestedFileName('/absolute/path.sql')).toBe('absolute-path.sql');
    expect(suggestedFileName('C:\\Windows\\x.sql')).toBe('C-Windows-x.sql');
    for (const out of [
      suggestedFileName('../../etc/passwd'),
      suggestedFileName('/absolute/path.sql'),
      suggestedFileName('a/b\\c'),
    ]) {
      expect(out).not.toMatch(/[/\\]/);
      expect(out.startsWith('.')).toBe(false);
    }
  });

  it('never proposes a hidden file, an empty name, or a non-string', () => {
    expect(suggestedFileName('...')).toBe('kozou-comments.sql');
    expect(suggestedFileName('')).toBe('kozou-comments.sql');
    expect(suggestedFileName('---')).toBe('kozou-comments.sql');
    expect(suggestedFileName(undefined)).toBe('kozou-comments.sql');
    expect(suggestedFileName(42)).toBe('kozou-comments.sql');
  });

  it('drops control characters and bounds the length', () => {
    expect(suggestedFileName('a\nb\tc')).toBe('a-b-c.sql');
    expect(suggestedFileName('x'.repeat(200))).toHaveLength(64 + 4);
  });

  it('keeps distinct inputs distinct rather than collapsing them', () => {
    // Substitution, not deletion: two profiles whose names differ only in the
    // characters being replaced must not propose the same file.
    expect(suggestedFileName('shop eu')).not.toBe(suggestedFileName('shop us'));
  });
});
