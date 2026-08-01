// Validation for the one path where the renderer causes a file to be written.
//
// The user picks the destination in a native dialog, so this is not a silent
// write — but the renderer still supplies both the bytes and the name the
// dialog opens with, and neither may be taken as given. Kept out of index.ts so
// it can be unit-tested without Electron.

import { MAX_SQL_EXPORT_CHARS } from '../shared/types.js';

const FALLBACK_NAME = 'kozou-comments.sql';

/** The text to write, or a throw. Only a bounded string is acceptable: the
 *  drafts are generated statements, and the ceiling keeps a compromised
 *  renderer from turning a save dialog into an unbounded write. */
export function validateSqlExport(sql: unknown): string {
  if (typeof sql !== 'string') throw new Error('sql must be a string');
  if (sql.length === 0) throw new Error('sql must not be empty');
  if (sql.length > MAX_SQL_EXPORT_CHARS) {
    throw new Error(`sql exceeds ${MAX_SQL_EXPORT_CHARS} characters`);
  }
  return sql;
}

/** A file name safe to hand to the save dialog as its starting point.
 *
 *  `defaultPath` is interpreted as a PATH, so a renderer-supplied name
 *  containing a separator would choose the directory the dialog opens in.
 *  Reducing it to a single flat name keeps the choice with the user: the
 *  dialog then opens wherever the OS last left them. */
export function suggestedFileName(name: unknown): string {
  if (typeof name !== 'string') return FALLBACK_NAME;
  // Everything outside a conservative set — separators and control characters
  // included — becomes a hyphen rather than being dropped, so two distinct
  // relation names cannot collapse into the same suggestion.
  const flattened = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-{2,}/g, '-');
  // A leading dot would propose a hidden file; "." and ".." are not names.
  const trimmed = flattened.replace(/^[.-]+/, '').slice(0, 64);
  if (trimmed === '') return FALLBACK_NAME;
  return trimmed.toLowerCase().endsWith('.sql') ? trimmed : `${trimmed}.sql`;
}
