# kozou Desktop

**Status: experimental — validation-first MVP (M1). Not released; no builds are distributed yet.**

A read-only desktop app that renders the **semantic model** [kozou](https://kozou.org) compiles from your PostgreSQL schema — table/column COMMENTs with `@ai`/`@policy` tags, views and their lineage, foreign-key relationships and their documented meaning — as a human-facing visual map, across multiple databases.

AI agents already see this model through kozou's MCP describe surface. Generic DB clients show raw tables and none of the semantics. This app is the missing human-facing side: *see what your AI sees.*

## What it is (and isn't)

- **Is**: a local, read-only visual surface for compiled schema semantics, with named per-database profiles.
- **Is not**: a chat client (bring your own — Claude Desktop, Cursor, etc. connect to kozou over MCP), a schema editor (schema and COMMENTs stay in SQL/Git), or a general DB client.

## Security posture

- **Read-only by construction**: the app runs introspection only, inside a `READ ONLY` transaction; the write-capable kozou surfaces are not part of the app's production dependency tree (verified in CI: `scripts/check-treeshake.mjs`).
- **Zero egress**: the only network peer is your own database. No telemetry, no crash upload, no update checks, spellchecker disabled (CI-checked: `scripts/check-egress-static.mjs`; see `EGRESS.md`).
- **Secrets**: database passwords are stored via Electron `safeStorage` (OS keychain-backed), passed to introspection workers via environment only — never argv, logs, or config files.
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
