# kozou Desktop

**Status: experimental — validation-first MVP, past its first external trial. Pre-releases (`v0.3.0-alpha.1`) are run from source; no binaries are distributed.**

A desktop app that renders the **semantic model** [kozou](https://kozou.org) compiles from your PostgreSQL schema — table/column COMMENTs with `@ai`/`@policy` tags, views and their lineage, foreign-key relationships and their documented meaning — as a human-facing visual map, across multiple databases. It is **read-only by default**: row browsing and row editing are per-profile opt-ins, and the introspection and MCP surfaces stay read-only whether or not you enable them. (A database's row-access level is shown wherever the database is described — the bar above the map when it is selected, and its card in the **All databases** view — and each opt-in is offered separately, browsing first, editing as its own approval; a **Data** tab then appears on the detail pane.) Comments can be **edited into `COMMENT ON` statements the app hands back to you** — it applies none of them, so that path needs no grant and reaches no database.

AI agents already see this model through kozou's MCP describe surface. Generic DB clients show raw tables and none of the semantics. This app is the missing human-facing side: *see what your AI sees.*

## What it is (and isn't)

- **Is**: a local visual surface for compiled schema semantics — read-only unless you opt a profile in — with named per-database profiles:
  - **Semantic map** — tables, views, FK relationships (with their documented meaning), view lineage, and `@ai`/`@policy`/RLS badges, laid out as a graph.
  - **Detail pane** — the full compiled semantics of a relation, including join suggestions and example queries.
  - **AI view** — the payload an AI agent receives from the MCP describe tools of a **default-configured** kozou server for that relation: same functions, same serialization. Server-side opt-ins (RPC exposure config, privilege-aware annotations) are not reproduced yet.
  - **Cross-database overview** — the **All databases** view at the top of the rail: a card per database with relation counts and annotation coverage, side by side.
  - **Cross-database search** — find a table/view by name, comment, or `@ai` note across every open database and jump to it.
  - **Row browsing (opt-in, off by default)** — once a profile is opted in through a native approval dialog, the detail pane gains a **Data** tab: rows of the selected table or view, sorted by column, walked with keyset cursors. Reads run inside a `READ ONLY` transaction; a relation without a primary key has no total order, so it shows a single page and says so. (Sorting covers every column whose name the REST layer's comma-separated sort grammar can express — a name containing a comma is left out of the control rather than offered and rejected.) The pager counts the steps of the walk rather than naming an absolute page: there is no row count behind it, so nothing there licenses arithmetic about how many rows lie before the ones on screen. This pane is a **preview, not a viewer** — large values are cut before the rows leave the database connection (1024 characters or bytes; a larger json value is dropped) and every cut is marked in the cell rather than passed off as the value. The same limit applies to the page cursors, which carry the sort values of the row they stop at: sorting by a column whose values are too large to fit a cursor ends the walk, and the pane says so instead of offering a hop it cannot make. A database's current row-access level is shown whether or not anything is granted — on the bar above the map while it is selected, and on its card in the **All databases** view — and says in words what the level means: while off, that no row query runs at that level and that editing carries an approval of its own; once granted, that the Data tab is where the grant is used and that your database decides what that connection may see or change. A profile edit that repoints it at a different database, different schemas, or a different credential state drops the grant back to off, so the next browse asks for approval again.
  - **Row editing (a second opt-in, also off by default)** — a browsing grant does not carry it: editing is its own level, approved through its own native dialog, and the Data tab gains write controls only once it is in force. A row is inserted, edited or deleted one statement at a time, each in its own transaction. Every field answers one of three ways — leave it to the database, send a value, or send null — so a generated key can be generated and a nullable column can be cleared, and an edit sends only the fields you changed. Editing starts by re-reading the row in full, so a value the browse pane had to shorten is never written back shortened. What can be edited is deliberately narrow: a view is not offered write controls (kozou refuses a write to one), and neither is a table without a primary key or a row whose key this app cannot put in a request — including a key too large to have travelled in full, where what is on screen is only its beginning and could belong to another row. A field whose stored value has no text form this app can write back (a byte array, an array, a geometric type) is shown as read-only rather than as a rendering you could accidentally save. Refusals come back as fixed sentences (permission denied, no matching row, conflicts with existing data), which is also why they never quote the values involved; the database has the final say on all of it, and a value's type is checked by kozou before any statement runs. There is no optimistic concurrency: if someone else changes a field between your opening the editor and saving, your value wins.
  - **Comment drafting (no opt-in, because it touches no database)** — the Semantics tab can edit the COMMENT of a relation or a column and hand you back the `COMMENT ON` statement. It never runs one: the statements collect in a panel you copy or save as a `.sql` file, and you apply them the way you apply any other schema change. The text box is seeded with the comment **exactly as it stands in the database**, not with the rendered description above it — kozou lifts `@widget:`/`@example:` blocks out of that field, so editing what you see there would silently delete them (there is a test that performs that mistake against a real database and watches the tag disappear). A materialized view is named as one, because `COMMENT ON VIEW` is an error against it; if the app cannot read which kind a view is, it offers no statement for the view rather than guessing. Drafts live for the session and belong to the profile they were written against.
- **Is not**: a chat client (bring your own — Claude Desktop, Cursor, etc. connect to kozou over MCP), a migration tool, or a general DB client. It is not a schema editor either: schema and COMMENTs stay in SQL/Git, which is why the comment editor hands you a statement instead of applying one.

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
press **Save profile**. Add a second database the same way.

Databases are listed in the rail down the left, one line each, and clicking one
opens it: a bar describing that database — its connection, its row-access level,
its MCP row — above the map and the detail pane. **All databases** at the top of
the rail switches to a card per database side by side, which is where annotation
coverage is comparable across them. The search box above spans every database
that has been introspected, whichever of the two you are looking at.

The map and the detail pane share the workspace, except when they cannot
usefully: opening the **Data** tab collapses the map and gives the pane the
whole width, because a row grid in a side column is mostly horizontal scrolling.
**full width** / **show map** in the tab row switches that by hand on any tab —
so getting back to the map after browsing is one click, and reading semantics
wide is available without going through Data.

**Databases** in the header stows the rail. Between switches it is a list nobody
is reading, and the database you are in is named in the bar above the workspace
anyway; the width it gives up goes to the map, which is the pane that wanted it
(measured at a 1280px window: the map goes from 529px to 751px, and the detail
column does not move). The button stays in the header while it is stowed, because
a control that hides something cannot live inside what it hides.

**Enum types**, **Functions** and **Drafts** share one row along the bottom of
the workspace. Shut, that row is the whole of what they cost; opening one gives
it the workspace and collapses the map and the pane, the same switch the Data tab
makes, and the row stays below it to shut again. Drafting a `COMMENT ON`
statement opens the drafts panel, since a statement you have to go looking for is
one you have no reason to think exists.

Connect with a **least-privilege role**. On Supabase, do **not** use
`service_role`/`postgres` (they bypass row-level security). A read-only role is
enough for everything this build does: it introspects inside a `READ ONLY`
transaction, and row data is reached only for a profile you explicitly opt in
(a native dialog has to approve it). Row browsing runs inside a `READ ONLY`
transaction too, so a read-only role covers it as well. Row editing is a further
opt-in with its own dialog: grant write privileges only if you mean to use it,
and remember that the database, not this app, has the final say on what your role
may change.

If you are trying this at our request, see [TRIAL.md](TRIAL.md) for what
feedback is most useful.

## Serve it to an AI client (local MCP hub, off by default)

The app can also serve the same compiled semantics to AI clients on your
machine, so you and an agent read one model instead of two. It is **off by
default**, and read-only regardless of anything else you have opted into.

1. In **Settings**, tick **Allow profiles to serve MCP on loopback**. Ticking it
   starts nothing — it lets a profile be started.
2. On the database's own row — the bar above the map when it is selected, or its
   card in the **All databases** view — click **start**; the badge becomes
   `MCP on :<port>`.
3. Click **AI client config** and copy the form your client wants — the panel
   offers three. The URL it holds is one database's, so moving to a different
   database closes it; it stays while you are in **All databases**, where every
   database is on screen.

`mcpServers` JSON, for Cursor:

```json
{
  "mcpServers": {
    "kozou-local-<profile>": {
      "type": "http",
      "url": "http://127.0.0.1:3335/mcp-<random>"
    }
  }
}
```

a one-liner, for Claude Code:

```sh
claude mcp add --transport http kozou-local-<profile> http://127.0.0.1:3335/mcp-<random>
```

and the bare URL, for any client that takes one directly:

```text
http://127.0.0.1:3335/mcp-<random>
```

**Claude Desktop does not connect to a URL.** Its custom connectors are opened
from Anthropic's cloud rather than from your machine and require a publicly
reachable `https` address, so `127.0.0.1` is not something they can resolve to
your Mac — adding TLS would not help, and exposing the hub publicly is the
opposite of what it is for. Its own configuration file launches local commands
(stdio) instead. Reaching the hub from there needs a local stdio-to-HTTP bridge
process, and this build both **contains** one (`EGRESS.md` item 16 describes what
it may and may not do) and **offers** it — the same panel hands you a fourth
shape, an entry that starts it:

```json
{
  "mcpServers": {
    "kozou-local-<profile>": {
      "command": "/Applications/Kozou.app/Contents/MacOS/Kozou",
      "args": [
        "/Applications/Kozou.app/Contents/Resources/app.asar/out/main/stdioBridge.js",
        "--id",
        "<locator id>"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Three things to know about it. It names a **locator**, not a URL, so unlike the
three shapes above it leaves the capability path out of another application's
configuration file — the bridge reads the port and the path from a file this app
owns and keeps to itself. Claude Desktop keeps every server it launches in one
file, so add this **inside** the `mcpServers` object already there rather than
replacing the file, and restart it afterwards (it reads that file at startup).

And its paths are **absolute**, naming this app where it is now. Two failure
modes follow, and only one of them this app can speak to: move the app and your
client's launch fails with nothing to explain it — that happens in the client,
before any code here runs. What the bridge does report is the *server*: with no
server published for that profile it says so and starts nothing (`EGRESS.md`
item 16, property (d)). Rebuilding the app in place changes neither path.

What has actually been run, by hand: on **2026-08-09**, Claude Desktop 1.26832.0 was
given the entry **this app produced**, spawned the bridge from it, completed the MCP
handshake, and then **answered from its own chat** over that entry — the client's log
records two `tools/call` requests, each answered, and the chat's replies carried the
database's compiled semantics. Stopping the app and calling again over the same entry
produced the explicit failure it is supposed to: a JSON-RPC error naming a refused
connection, with nothing started on its own.

An earlier run (2026-08-07) reached the same point with an entry written by hand;
the relay has changed since then. One machine, one client version, one run;
`EGRESS.md` keeps the full scope of what that does and does not establish.

One server per profile, so several databases can be served at once — each under
its own name, port and path. What is in one place is the managing of them: you
start and stop them here, and this app hands you the client config for each. Your
client still lists them one by one. A single endpoint that routes to several
databases is not what this builds.

What it serves is the **describe surface only**: `list_tables`,
`describe_table`, `list_views`, `describe_view`, `list_concepts`,
`get_concept_context`, `describe_functions`, `search_schema`. There is no
execution tool — it is neither advertised nor dispatchable, and a forced call
is refused (pinned by an integration test against a real database). Row data
never reaches this surface, whatever a profile's row-access grant says.

Worth knowing before you paste:

- **The app bounds the listener's lifetime.** Quitting closes the port. A
  profile you started comes back on the next launch until you press **stop** —
  with three exceptions. Repointing a profile at another database drops that
  intent along with the allocation it lives in, so a repointed profile does not
  auto-start against a database you have not started it for. **Adding a schema**
  drops the intent too while keeping the allocation: what you pasted still names
  this database, but it would reach the added schemas on the next launch without
  you doing anything, so starting it again is how you say yes to that. Narrowing
  the schema list, rotating or removing the stored password, and changing the role
  are none of those: they stop the running server — it was connected with the old
  ones — and the profile comes back on the next launch as before. (The row-access
  grant is a different matter and drops on all of them — see above.) And a profile
  you started over the duplicate-declaration warning is left at
  `MCP blocked (duplicate)` at launch instead, because restoring one would mean
  re-asking, and the app raises no dialogs while starting up. Any edit that
  changes what the connection reaches — the database, the schema list, the stored
  password — stops the server rather than serving the old one under the same name,
  and the badge says so.
- **The port is sticky while the profile names the same database** — assigned
  once from 3335 upward (3334 is skipped: it is the kozou CLI's own default) and
  never silently renumbered, because the configs you pasted name it. A bind
  conflict is reported as `MCP port busy` with a **move port** control instead of
  being resolved behind your back, and while that lasts the database's MCP row
  stops offering to open the config panel (a panel you already had open keeps
  showing the snippet, and says the server is not running). The other thing that
  replaces it is an edit that points the profile at **another database**, and
  there the invalidation is the point: a config you pasted for one database
  stops resolving rather than quietly serving the new one under the old name.
  Only the database does this, and "the same database" means the same host, port
  and database name — the app's own definition, the one behind the duplicate
  warning, so `:5432` and the default port are not two databases. Changing the
  schema list, the stored password or the role stops the running server — it was
  connected with the old ones — but the port, the path and the locator id survive,
  so what you pasted still names the same database and resolves again as soon as
  the server is back.
  The bridge entry fails immediately, on a locator id nothing answers for; a
  pasted URL stops resolving once the old server is actually down, which is
  normally at once and takes up to three seconds if that worker ignores the
  request to stop.
- **The path is a capability, not authentication.** Any process on your machine
  that can read your AI client's config files can read schema *metadata*
  through it — never row data. Moving the port keeps the same path, so a config
  you pasted stays valid for the profile it named. See [EGRESS.md](EGRESS.md)
  item 10 for the exact local exposure.
- **Claude Code, project scope**: a server pasted into a project `.mcp.json`
  sits at `Pending approval` until you approve it once inside `claude`. The
  copied command adds no `--scope`, so it lands in whatever scope your CLI
  defaults to — local at the time of writing, which connects immediately.
- **A database already served from elsewhere** can be marked as such on the
  profile: *a remote MCP server already serves this database*. That declaration
  does two things, and neither one depends on the permission above. That
  database's own row carries `served remotely (declared)` whether or not this app
  is allowed to serve — what you recorded is about another server, so our own setting does not
  change it. And starting a local server for a database a declared remote one
  appears to cover stops to warn you first: two servers could then answer the
  same question differently, since this app does not reproduce a server's own
  opt-ins. You can start past that warning, because the declaration is something
  you told us and not something we checked: the app never contacts that server,
  a declaration is valid with no URL at all, and a remote server that has since
  stopped would otherwise leave you unable to start a local one without first
  deleting the record saying it exists. The word *declared* is in the badge for
  the same reason — it reports what you entered, not a reachability check.
- **What the duplicate check actually compares** is host, port and database name
  as the connection URL spells them (default port filled in, database name
  percent-decoded). It is deliberately one-sided — a miss is accepted, a match
  is meant to be reliable — so it resolves no DNS aliases and looks through no
  pooler, and it skips the comparison altogether for a URL carrying `host`,
  `hostaddr`, `port` or `dbname` in its query string rather than guess at what
  such a URL resolves to. In one direction it is looser than "reliable"
  suggests, which is worth knowing before you trust a match: `localhost`,
  `127.0.0.1` and `[::1]` are treated as one host, so two *different* servers
  bound separately to IPv4 and IPv6 on the same port, with the same database
  name, count as the same database.

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

- **Read-only by default; write is a separate, opt-in surface**: introspection always runs inside a `READ ONLY` transaction, and so does every row read. Row browsing and row editing are off for every profile until you turn them on, per profile, through a dialog drawn by the app's main process (never by the UI, which can only ask). The introspection and MCP surfaces stay read-only regardless of that grant. What enforces the split is structural, and CI checks it (`scripts/check-treeshake.mjs`): the write path may only be *reachable* from the row-data worker's bundle — the introspection worker, the MCP server worker and the main process are each bundled and scanned for it; no source anywhere may name `@kozou/api`'s HTTP-server entry points; and no source outside the worker directory may import a database driver, so a hand-written statement is confined to the same process as the generated ones. Reachability, not absence: the packaged app ships `node_modules` whole, so the code is present in the artifact whether or not anything can call it. `READ ONLY` is the database's own enforcement of what PostgreSQL classifies as a write — a view or function that calls out to something external is beyond what any transaction mode can undo. The optional local MCP hub serves the describe tools only — the execution tool is neither advertised nor dispatchable, pinned by an integration test against a real database.
- **What a row-editing grant really costs**: for a profile you opted in to editing, a compromised renderer can write to that database with your stored credentials. That is the one genuinely new risk here, and the mitigations stop at "off by default", "per profile", and "the grant needs a native approval" — see `EGRESS.md` for why nothing stronger is available inside Electron's trust model.
- **Zero egress, loopback-only serving**: outbound, the only network peer is your own database. No telemetry, no crash upload, no update checks, spellchecker disabled (CI-checked: `scripts/check-egress-static.mjs`). By default the app opens no server and no port; the opt-in local MCP hub (which needs the app-wide permission, off by default, and then a per-profile start) listens on `127.0.0.1` only, behind a per-profile secret path and a DNS-rebinding guard — see `EGRESS.md` for the exact local exposure.
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
