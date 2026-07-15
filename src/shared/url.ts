// Connection-URL handling: split the password out for encrypted storage,
// rejoin it for the worker, and mask it for logs / error surfaces.
//
// Invariant: the full URL with password exists only (a) transiently in the
// main process while saving or spawning a worker and (b) in the worker's env.
// It never reaches profiles.json, argv, logs, or the renderer.

/** Parse a postgres connection URL; throws on malformed input. */
function parse(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid connection URL (expected postgresql://user:password@host:port/database)');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(`unsupported protocol "${url.protocol}" (expected postgresql://)`);
  }
  return url;
}

/** Split a URL into its password-free form + the password (null if none). */
export function splitDbUrl(raw: string): { sansPassword: string; password: string | null } {
  const url = parse(raw);
  const password = url.password === '' ? null : decodeURIComponent(url.password);
  url.password = '';
  return { sansPassword: url.toString(), password };
}

/** Rejoin a password-free URL with its password for actual connection use. */
export function joinDbUrl(sansPassword: string, password: string | null): string {
  if (password === null) return sansPassword;
  const url = parse(sansPassword);
  url.password = encodeURIComponent(password);
  return url.toString();
}

/** Mask any password in a URL for display / logging. */
export function maskDbUrl(raw: string): string {
  try {
    const url = parse(raw);
    if (url.password !== '') url.password = '***';
    return url.toString().replace('***', '•••');
  } catch {
    return '(unparseable connection URL)';
  }
}

/** Scrub a free-form error message of connection secrets. */
export function sanitizeErrorMessage(message: string, fullUrl: string | undefined): string {
  if (!fullUrl) return message;
  let out = message.split(fullUrl).join('(connection URL)');
  try {
    const { password } = splitDbUrl(fullUrl);
    if (password !== null && password.length > 0) {
      out = out.split(password).join('•••');
    }
  } catch {
    // fullUrl unparseable — the literal replacement above already covered it.
  }
  return out;
}
