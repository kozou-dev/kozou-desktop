# kozou Desktop

**Status: experimental — validation-first MVP (M2: semantic map). Not released; no builds are distributed yet.**

A read-only desktop app that renders the **semantic model** [kozou](https://kozou.org) compiles from your PostgreSQL schema — table/column COMMENTs with `@ai`/`@policy` tags, views and their lineage, foreign-key relationships and their documented meaning — as a human-facing visual map, across multiple databases.

AI agents already see this model through kozou's MCP describe surface. Generic DB clients show raw tables and none of the semantics. This app is the missing human-facing side: *see what your AI sees.*

## What it is (and isn't)

- **Is**: a local, read-only visual surface for compiled schema semantics, with named per-database profiles:
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

Connect with a **least-privilege, read-only role**. On Supabase, do **not** use
`service_role`/`postgres` (they bypass row-level security). The app only ever
introspects (`SET TRANSACTION READ ONLY`); it never writes.

If you are trying this at our request, see [TRIAL.md](TRIAL.md) for what
feedback is most useful.

## Security posture

- **Read-only by construction**: the app runs introspection only, inside a `READ ONLY` transaction; the write-capable kozou surfaces are not part of the app's production dependency tree (verified in CI: `scripts/check-treeshake.mjs`).
- **Zero egress**: the only network peer is your own database. No telemetry, no crash upload, no update checks, spellchecker disabled (CI-checked: `scripts/check-egress-static.mjs`; see `EGRESS.md`).
- **Secrets**: database passwords are stored via Electron `safeStorage` (OS keychain-backed), passed to introspection workers via environment only — never argv, logs, or config files. On Linux this additionally requires a real keyring backend: the `basic_text` fallback (a hardcoded key) is rejected rather than silently accepted.
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
