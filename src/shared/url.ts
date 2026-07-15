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
  let password: string | null = null;
  if (url.password !== '') {
    try {
      password = decodeURIComponent(url.password);
    } catch {
      // A raw "%" (or other broken percent-escape) in the password.
      throw new Error(
        'connection URL password contains an invalid percent-escape — ' +
          'URL-encode special characters (e.g. "%" as "%25", "@" as "%40")',
      );
    }
  }
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
    if (url.password === '') return url.toString();
    const auth = url.username !== '' ? `${url.username}:•••@` : ':•••@';
    return `${url.protocol}//${auth}${url.host}${url.pathname}${url.search}`;
  } catch {
    return '(unparseable connection URL)';
  }
}

/** Compact, low-identifier display form for the profile list: host:port/db —
 *  no scheme, no username, never a password. Keeps screenshots of the
 *  profile list from carrying more identifiers than necessary. */
export function displayConnection(sansPassword: string): string {
  try {
    const url = parse(sansPassword);
    return `${url.host}${url.pathname}`;
  } catch {
    return '(unparseable connection URL)';
  }
}

/** Scrub a free-form error message of connection secrets. Covers the full
 *  URL, the decoded password, and the percent-encoded password form. */
export function sanitizeErrorMessage(message: string, fullUrl: string | undefined): string {
  if (!fullUrl) return message;
  let out = message.split(fullUrl).join('(connection URL)');
  const candidates: string[] = [];
  try {
    const url = parse(fullUrl);
    if (url.password !== '') candidates.push(url.password); // encoded form
  } catch {
    // fullUrl unparseable — the literal replacement above already covered it.
  }
  try {
    const { password } = splitDbUrl(fullUrl);
    if (password !== null) candidates.push(password); // decoded form
  } catch {
    // Undecodable password — the encoded form above still gets scrubbed.
  }
  for (const secret of candidates) {
    if (secret.length > 0) out = out.split(secret).join('•••');
  }
  return out;
}
