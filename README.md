# kozou Desktop

**Status: experimental — validation-first MVP (M2: semantic map). Not released; no builds are distributed yet.**

A desktop app that renders the **semantic model** [kozou](https://kozou.org) compiles from your PostgreSQL schema — table/column COMMENTs with `@ai`/`@policy` tags, views and their lineage, foreign-key relationships and their documented meaning — as a human-facing visual map, across multiple databases. It is **read-only by default**: row browsing and row editing are per-profile opt-ins, and the introspection and MCP surfaces stay read-only whether or not you enable them.

AI agents already see this model through kozou's MCP describe surface. Generic DB clients show raw tables and none of the semantics. This app is the missing human-facing side: *see what your AI sees.*

## What it is (and isn't)

- **Is**: a local visual surface for compiled schema semantics — read-only unless you opt a profile in — with named per-database profiles:
  - **Semantic map** — tables, views, FK relationships (with their documented meaning), view lineage, and `@ai`/`@policy`/RLS badges, laid out as a graph.
  - **Detail pane** — the full compiled semantics of a relation, including join suggestions and example queries.
  - **AI view** — the payload an AI agent receives from the MCP describe tools of a **default-configured** kozou server for that relation: same functions, same serialization. Server-side opt-ins (RPC exposure config, privilege-aware annotations) are not reproduced yet.
  - **Cross-database overview** — per-profile cards with relation counts and annotation coverage.
  - **Cross-database search** — find a table/view by name, comment, or `@ai` note across every open database and jump to it.
- **Is not**: a chat client (bring your own — Claude Desktop, Cursor, etc. connect to kozou over MCP), a schema editor (schema and COMMENTs stay in SQL/Git), or a general DB client.

## Try it (trial build)

No installer yet — run it from source (Node 22+ and [pnpm](https://pnpm.io) required):

```sh
git clone https://github.com/kozou-dev/kozou-desktop.git
cd kozou-desktop
pnpm install
pnpm start
```

`pnpm start` builds and launches the packaged app, so you run it under the
same strict Content-Security-Policy the shipped build enforces (see Security
posture below). `pnpm dev` also works but uses a looser, localhost-only dev
CSP for hot reload — prefer `pnpm start` for a trial.

Then click **+ Add database**, paste a read-only PostgreSQL connection URL
(`postgresql://user:password@host:5432/db`), list the schemas to include, and
press **Save profile**. Add a second database the same way and use the search
box to move between them.

Connect with a **least-privilege role**. On Supabase, do **not** use
`service_role`/`postgres` (they bypass row-level security). A read-only role is
enough for everything the app does by default: it introspects inside a
`READ ONLY` transaction, and it reads or writes row data only for a profile you
explicitly opt in (a native dialog has to approve it). Grant write privileges
only if you mean to edit rows from here — the database, not this app, has the
final say on what your role may change.

If you are trying this at our request, see [TRIAL.md](TRIAL.md) for what
feedback is most useful.

## Local unsigned build

To run it as a real `.app` instead of from a terminal, build one locally.
The build is **unsigned** (no Apple Developer ID, no notarization) and
**Apple-silicon only** (`arm64`):

```sh
pnpm install
pnpm dist
```

This produces `dist/mac-arm64/Kozou.app`. Drag it into `/Applications`
(or run it in place). Since you built it locally it launches directly — a
self-built app carries no Gatekeeper quarantine — and appears as **Kozou**
in the Dock and Spotlight.

If you instead copy `Kozou.app` to *another* Mac, macOS quarantines it
(it is unsigned): open it once with **right-click → Open**, or clear the
flag with `xattr -dr com.apple.quarantine /Applications/Kozou.app`.

This is a convenience build for local validation. Nothing is distributed:
no signing, notarization, auto-update, or published binaries are in scope.

## Security posture

- **Read-only by default; write is a separate, opt-in surface**: introspection always runs inside a `READ ONLY` transaction, and so does every row read. Row browsing and row editing are off for every profile until you turn them on, per profile, through a dialog drawn by the app's main process (never by the UI, which can only ask). The introspection and MCP surfaces stay read-only regardless of that grant. What enforces the split is structural, and CI checks it (`scripts/check-treeshake.mjs`): the write path may only be *reachable* from the row-data worker's bundle — the introspection worker, the MCP server worker and the main process are each bundled and scanned for it, and no source anywhere may start `@kozou/api`'s HTTP server. Reachability, not absence: the packaged app ships `node_modules` whole, so the code is present in the artifact whether or not anything can call it. The optional local MCP mode serves the describe tools only — the execution tool is neither advertised nor dispatchable, pinned by an integration test against a real database.
- **What a row-editing grant really costs**: for a profile you opted in to editing, a compromised renderer can write to that database with your stored credentials. That is the one genuinely new risk here, and the mitigations stop at "off by default", "per profile", and "the grant needs a native approval" — see `EGRESS.md` for why nothing stronger is available inside Electron's trust model.
- **Zero egress, loopback-only serving**: outbound, the only network peer is your own database. No telemetry, no crash upload, no update checks, spellchecker disabled (CI-checked: `scripts/check-egress-static.mjs`). By default the app opens no server and no port; the opt-in local MCP mode (default off) listens on `127.0.0.1` only, behind a per-profile secret path and a DNS-rebinding guard — see `EGRESS.md` for the exact local exposure.
- **Secrets**: database passwords are stored via Electron `safeStorage` (OS keychain-backed), passed to workers via environment only — never argv, logs, or config files. On Linux this additionally requires a real keyring backend: the `basic_text` fallback (a hardcoded key) is rejected rather than silently accepted.
- **Least privilege**: connect with a minimal read role. On Supabase, do **not** use `service_role`/`postgres` (they bypass RLS).

## Development

```sh
pnpm install
pnpm dev          # launch the app (electron-vite)
pnpm typecheck
pnpm test:unit
```

Integration checks need a PostgreSQL (any database works; CI uses `fixtures/contract.sql`):

```sh
export KOZOU_TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db
pnpm test:contract   # worker output ≡ `kozou inspect` output
pnpm build && pnpm test:e2e
```

## License

Apache-2.0. Part of the kozou project (<https://github.com/kozou-dev/kozou>).
