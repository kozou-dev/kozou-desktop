// Database identity for duplicate-connection detection: one normalized key
// per (host, port, database).
//
// Schemas and user are deliberately NOT part of the key. The check asks "is
// this the same database?" — including schemas would let overlapping but
// unequal schema sets ([public] vs [public, sales]) slip through, and
// including the user would miss the same database reached via two roles.
//
// Best-effort by design, with an asymmetric contract: a MISS is acceptable
// (DNS aliases and connection poolers are not resolved), but a MATCH must be
// reliable — callers warn on matches. URL forms whose effective identity
// this function cannot model therefore return null ("skip the check")
// rather than risk a false duplicate warning.

// WHATWG URL always serializes IPv6 hostnames bracketed ("[::1]").
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_PG_PORT = 5432;

/** libpq allows identity-bearing connection parameters in the query string;
 *  a URL using them cannot be keyed from its authority/path alone. */
const IDENTITY_QUERY_KEYS = ['host', 'hostaddr', 'port', 'dbname'];

/** Normalized identity key for a connection URL (password-free or not).
 *  Returns null for URLs it cannot key reliably: unparseable/non-postgres
 *  input, an empty host, identity-bearing query params, or an empty dbname
 *  (libpq then defaults the database to the *username*, which is
 *  deliberately not part of the key). */
export function dbIdentityKey(connectionUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return null;
  if (url.hostname === '') return null;
  if (IDENTITY_QUERY_KEYS.some((key) => url.searchParams.has(key))) return null;
  let database = url.pathname.replace(/^\//, '');
  if (database === '') return null;
  try {
    // libpq percent-decodes the dbname; key the decoded form so
    // "db%41" and "dbA" compare equal.
    database = decodeURIComponent(database);
  } catch {
    return null;
  }
  // WHATWG does not lowercase opaque hosts for non-special schemes, so this
  // toLowerCase() is load-bearing.
  const rawHost = url.hostname.toLowerCase();
  const host = LOOPBACK_HOSTS.has(rawHost) ? 'loopback' : rawHost;
  const port = url.port === '' ? DEFAULT_PG_PORT : Number(url.port);
  return `${host}:${port}/${database}`;
}

/** Names of profiles whose declared remote MCP serves the same database as
 *  `targetUrl`. Used to warn before starting a local server that would
 *  duplicate a declared remote one. */
export function findRemoteDuplicates(
  profiles: ReadonlyArray<{ name: string; url: string; remoteMcp?: { declared: boolean } }>,
  targetUrl: string,
): string[] {
  const key = dbIdentityKey(targetUrl);
  if (key === null) return [];
  return profiles
    .filter((p) => p.remoteMcp?.declared === true && dbIdentityKey(p.url) === key)
    .map((p) => p.name);
}
