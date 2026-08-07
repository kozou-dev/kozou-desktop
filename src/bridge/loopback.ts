// BR-1: the bridge may only ever talk to a loopback address.
//
// This is the invariant that keeps a stdio->HTTP relay from becoming "a
// remote MCP server without OAuth". The relay is deliberately generic — it
// forwards bytes and interprets no MCP semantics — so the one thing that must
// not be generic is where those bytes go.
//
// The test is exact equality against two values after WHATWG normalization,
// not a range and not a prefix:
//
//   - a range test ("anything in 127/8") would accept 127.0.0.2, which no
//     part of this app ever binds;
//   - a prefix or substring test would accept 127.0.0.1.evil.example;
//   - a name test would accept "localhost", whose resolution is not ours to
//     decide (hosts files and resolvers can point it elsewhere).
//
// Normalization is what makes exact equality safe rather than brittle:
// http://2130706433/ and http://0177.0.0.1/ ARE 127.0.0.1 and the URL parser
// says so, while ::ffff:127.0.0.1 serializes as [::ffff:7f00:1] and is
// therefore refused — an IPv4-mapped IPv6 address is not one of the two
// values, and the refusal is deliberate rather than incidental (measured
// against Node 22's URL implementation; the unit tests pin every case).

/** The complete set of hosts the bridge may connect to. */
export const ALLOWED_LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1'];

/** Validate a relay target, returning the parsed URL. Throws on anything that
 *  is not plain HTTP to one of the two loopback addresses — the bridge fails
 *  rather than connects. */
export function assertLoopbackTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`refusing a target that is not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:') {
    throw new Error(`refusing a non-http target: ${raw}`);
  }
  // Credentials in the target are never legitimate here (the server has no
  // authentication) and are the classic way to make a URL read as loopback
  // while resolving elsewhere: http://127.0.0.1@evil.example/.
  if (url.username !== '' || url.password !== '') {
    throw new Error(`refusing a target carrying credentials: ${raw}`);
  }
  const host = normalizeHost(url.hostname);
  if (!ALLOWED_LOOPBACK_HOSTS.includes(host)) {
    throw new Error(
      `refusing a non-loopback target: host ${host} is not ${ALLOWED_LOOPBACK_HOSTS.join(' or ')} (${raw})`,
    );
  }
  return url;
}

/** WHATWG serializes an IPv6 host with brackets ("[::1]"); compare without. */
function normalizeHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}
