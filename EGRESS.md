# Egress hardening checklist

Design invariant: **outbound, the app's only network peer is the user's own
database.** No telemetry, no crash upload, no update checks, no external
assets. Trials on NDA-covered databases depend on this.

By default the app also opens **no server and no port**. The one deliberate
exception is the opt-in **local MCP mode** (default: off): when the user
enables it and starts a profile's server, the app listens on **127.0.0.1
only** to serve read-only schema-describe tools to AI clients on the same
machine. That is an inbound loopback listener, not egress — outbound traffic
is still only the user's own databases (the server introspects lazily on
tool calls). The listener's local exposure is documented below (item 10).

Row data changes none of that. The app is **read-only by default**: row
browsing and row editing are per-profile opt-ins (item 11), and enabling
either adds no listener and no outbound peer — the row-data worker speaks to
the same database over the same driver. Row values are **displayed only**:
never uploaded, never written to disk, and never logged (item 12). The
introspection and MCP surfaces remain read-only whatever a profile's row-data
grant says. As of this build the UI reaches both halves of that path: a profile
card grants row browsing (native approval) and a Data tab lists rows, and a
second grant — its own level, its own approval — adds insert, edit and delete
controls to the same tab. Browsing never escalates itself: a profile at `read`
stays there until an editing approval is given, and the write controls do not
render below that level.

Comment editing is a third thing again, and it is the reason "read-only" needs
saying carefully rather than loudly: the app **generates** `COMMENT ON`
statements and **runs none of them** (item 15). No grant gates it because there
is nothing to gate — the generator is a pure function in the renderer, which
holds no connection and no driver. What it produces leaves the app only where
you send it: the clipboard, or a `.sql` file you name in a native save dialog.
That dialog is the app's one path to the filesystem on the renderer's behalf,
and it writes nothing until you have chosen a destination.

One scope note on `READ ONLY`, so the guarantee is not read as more than it is:
PostgreSQL refuses what it classifies as a write inside such a transaction. A
selected view or function that reaches outside the database (procedural code,
an extension with an external effect) is beyond what any transaction mode can
classify or undo. Read-only here means "this app issues no writes and the
database refuses them", not "nothing your schema itself does can have effects".

| # | Item | Mechanism | Verified by |
|---|---|---|---|
| 1 | No auto-update | `autoUpdater` never imported | `scripts/check-egress-static.mjs` (CI) |
| 2 | No crash upload | `crashReporter` never imported | same |
| 3 | No outbound app-code network calls | no `fetch`/XHR/WebSocket, no `node:http(s)`/`net`/`tls`/`dgram` imports anywhere under `src/` (the local MCP server gets its listener from `@kozou/mcp`, not from a direct import), no Electron `net`/`session.fetch` | same (token + import scan) |
| 4 | Strict production CSP | `default-src 'self'`; the dev-only localhost HMR allowance is replaced at build time | same (built `out/renderer/index.html` content check) |
| 5 | Spellchecker dictionary download off | `spellcheck: false` + `setSpellCheckerEnabled(false)` | same |
| 6 | No external navigation | `will-navigate` prevented; `window.open` denied entirely (no `openExternal` path) | same (`shell.openExternal` is a forbidden token) |
| 7 | Secrets not in argv/logs | connection URL via env to workers (inspect, MCP and row-data alike; the row-data worker also receives its capability that way and deletes both from its environment once read); error messages and piped worker stdio sanitized (decoded + percent-encoded forms, buffered to line boundaries) | unit tests (`test/url.test.ts`, `test/profileStore.test.ts`; `test/mcpServerManager.test.ts` and `test/dataWorkerManager.test.ts` pin the env-only channel and the log scrub) |
| 8 | Write path reachable from one surface only | `@kozou/api` **is** a production dependency now (row editing uses it), so the guarantee is per surface, and it is about **reachability, not absence from the artifact**: `externalizeDepsPlugin` ships `node_modules` whole, so that code is in the packaged app either way. The **row-data** worker is the only bundle allowed to reach it. The **inspect** worker, the **MCP server** worker and the **main process** are each bundled and scanned for the write entry points (`handleApiRequest`, `buildInsertQuery`/`buildUpdateQuery`/`buildDeleteQuery`) — main included, because it is the only process holding the credentials, so "main cannot write" is what keeps writes behind the worker fork it gates. No source under `src/` may name `@kozou/api`'s HTTP-server entry points at all, and no source outside `src/worker/` may import a database driver (`pg` and relatives) — without that second rule the marker scans would prove only that the *generated* write path is unreachable while main could still open its own pool and issue a statement by hand (measured: it stayed green until this check existed). The scans are checked against the row-data bundle so a renamed upstream export cannot turn them into vacuous passes. The inspect worker is additionally free of MCP server/transport and execution-path markers (MCP SDK type/validation modules are present by design — the describe output schemas reach them). The **MCP server** worker necessarily bundles the server stack, and `@kozou/mcp`'s server statically imports its runtime-gated execution/OAuth code — so for that worker the guarantee is **no execution path**: it never constructs the execution/OAuth options (source tripwire in CI), and the served tool list has no execution tool and refuses a forced call (integration test against a real database) | `scripts/check-treeshake.mjs` (CI) + `test/mcpServer.integration.test.ts` |
| 9 | Real keychain only | on Linux, the `basic_text` safeStorage backend (hardcoded key) is rejected — passwords are stored only under a real keyring | code (`src/main/index.ts`) |
| 10 | Local MCP listener is loopback-only, opt-in, and read-only | default mode `off`; per-profile explicit start; bind fixed to `127.0.0.1` (never configurable to a public interface); per-profile random capability path (`/mcp-<128-bit hex>`) so a local port scan alone does not reach the tools; built-in DNS-rebinding guard (Host/Origin validation); describe tools only. **Local exposure to be aware of**: any process on the same machine that learns the path (it lands in AI-client config files in plaintext) can read schema *metadata* — table/column structure, COMMENTs, `@ai`/`@policy` annotations, function signatures; never row data. Loopback is per-machine, not per-user. The unauthenticated `POST /admin/refresh` endpoint is also exposed while running (cache invalidation → introspection load on the database — a small local nuisance lever, no data access) | integration test (404 on wrong path, 403 on forged Host, tool-list pinning) + runtime verification below |
| 11 | Row data is off until a native approval | `rowAccess` is absent (= off) for every new profile and is **not** part of the profile form — it lives on its own IPC channel, and an escalation is persisted only after `dialog.showMessageBox` drawn by the main process. A renderer-drawn modal is deliberately not a trust anchor: a compromised renderer could draw and "click" its own. The approval is bound to the connection it was shown for (URL, schemas, whether a password is stored), so a profile swapped behind the same name while the prompt is open does not inherit the grant. The **stored** grant is anchored to that same triple: a form edit that repoints the profile at another database, at other schemas, or at another credential state drops it back to off, while label, colour and timeout edits keep it — an approval outlives an edit exactly as long as the facts the dialog named hold. A worker's capability is fixed in its fork environment; changing a grant discards the worker rather than widening it. **Residual risk, stated plainly**: for a profile opted in to `readwrite`, a compromised renderer *can* write to that database with the stored credentials. Off-by-default, per-profile granularity and the native approval are the whole mitigation — inside Electron's trust model there is nothing stronger, because the renderer is allowed to ask for the operations the feature exists to perform | unit tests (`test/rowAccessGate.test.ts`, `test/profileStore.test.ts`, `test/dataWorkerManager.test.ts`) + e2e (`e2e/data.spec.ts`: refused while off, a declined dialog grants nothing, an approved one does; `e2e/browse.spec.ts`: the same gate as the UI presents it — a profile card shows its level before anything is granted, the Data tab exists only under a grant, revoking removes it, and the prompt count kept in main pins that a decline was actually asked for and a downgrade was not; `e2e/crud.spec.ts`: a browsing grant offers no write control, editing takes a second approval of its own, and revoking removes both) |
| 12 | Row values never reach a log | every `@kozou/api` call runs with `process.stderr` silenced, because the handler writes the raw database message before mapping it and a class-22 error (an invalid date, say) quotes the offending **value**; only a fixed, value-free breadcrumb is written instead. The transaction's own statements are outside that window, so a failure there (a COMMIT rejected by a deferred constraint or a constraint trigger raising a message built from the row) is logged as its **SQLSTATE only** — never its text. Independently, main keeps the worker's piped output out of both the UI and the log: only lines carrying the worker's own prefix are echoed, anything else is counted and dropped. Failure messages sent to the UI are re-authored — 403/404/405/409 become fixed sentences, so no primary key, row value or handler body rides along. A 400 keeps its message, and the honest scope of that is narrower than "the input the user typed": it is either a description of typed input or a pre-flight rejection of a value the *app* sent, and a page cursor is such a value — it carries ordering values read from a boundary row, and the dependency's cursor validation quotes the offending one. That message reaches the UI (never a log), and the value it quotes came from a row the browse pane had already displayed, so it discloses nothing the operator was not already shown; it is not, however, always something they typed | unit tests (`test/dataRunner.test.ts` incl. a COMMIT-time failure whose message quotes a value, `test/dataWorkerManager.test.ts`) + integration negative control (`test/data.integration.test.ts`: a real class-22 error, asserting the value appears in neither the reply nor stderr) |
| 13 | A browse page is bounded before it leaves the worker | nothing in the request grammar limits what a page weighs: it is up to 200 rows, and one `text`/`json`/`bytea` column is enough to make that hundreds of megabytes crossing two IPC hops and retained in the renderer. The data worker therefore cuts every value over a per-value budget (1024 characters / bytes; a larger json value is dropped rather than half-serialized) **before** the page is serialized, and every cut is reported to the renderer, which shows it: a shortened value is never passed off as the value. Measuring a json value stops as soon as the budget is passed, so an oversized one is never serialized in order to find out that it is oversized — and a value whose size cannot be established at all (a bigint or a cyclic structure: both fine for structured clone, both fatal to the measuring walk) is **dropped**, because a bound that reads "not measured" as "small enough" is not a bound. Measurement counts characters rather than JSON bytes on purpose: both hops carry values by structured clone, so a character count is the cost that is actually paid. **Cursors are the second way a row value can leave**, and they are bounded by the same rule: a keyset cursor encodes the boundary row's `ORDER BY` values (measured: a 2,048-character sorted value produced a 2,799-character cursor while its own cell was cut to 1,024), so a cursor over 4,096 characters — the same limit main refuses on the way in — is withheld and the pane says the walk ends there. **What this deliberately does not bound**: the worker itself, which has already read the page (the driver did that before any of our code sees it), and the single-row `get` path, which hands its values over in full — a row editor that only ever saw a cut value could write the cut back, and one row is bounded by being one row. **Known residual**: the cap is per value, so a very wide relation (PostgreSQL allows up to 1600 columns) can still produce a large page within the rule — see the open issue on an aggregate page ceiling | unit tests (`test/rowBudget.test.ts`, `test/dataRunner.test.ts`) + integration (`test/data.integration.test.ts`: a real oversized value cut out of a page and whole again through `get`; a real oversized cursor withheld) + e2e (`e2e/browse.spec.ts`: the pane shows the cut) |
| 14 | A row is written only where it can be named, and only what was answered for | the editor is offered for a relation this app can address a single row of, and nowhere else: not for a view (kozou answers a write to one with a 405), not for a table without a primary key, and not for a row whose key cannot be expressed in the item address. Two ways that last one happens, both real: a component of a composite key containing the separator it is split on would name a *different* row, and so would a key the page budget had to **shorten** — the budget cuts every oversized value a page carries, keys included, so what is on screen is then the first 1,024 characters of a key, which can be another row's key in full. Every field answers one of three ways — leave it to the database, send a value, or send null — and the payload carries only what was answered for: an insert omits what it was not given (so a generated key is generated and a DEFAULT applies), and an update sends only the fields that were edited. A field is seeded in its COLUMN's syntax, not in whatever JavaScript the driver produced: a json document is always re-serialized (the driver parses json `"123"` into the string `123`, and sending that back would store the json *number*), and a value with no text form this app can write back — a byte array, an array, a geometric type — is **locked** rather than seeded with a rendering of it. An editor also re-reads its row through the single-row `get` path before opening, so a value the browse pane had to cut is never saved back cut (item 13). Independently, the row-data pool hands the scalar date/time/interval types over as PostgreSQL's own **text**: the driver's parsers for that family are not round-trippable, and a `date` parsed into an instant names the previous day under any clock behind UTC — measured, `2026-08-01` arriving as `2026-07-31T15:00:00.000Z`. The array forms of those types are left parsed and therefore fall under the lock rule above | unit tests (`test/rowForm.test.ts`: which fields lock, that only touched fields are sent, that a json seed is re-serialized, and every id that is refused — including a cut key; `test/dataRunner.test.ts`, `test/rowBudget.test.ts`: a mutation's returned row bounded while a `get` is not) + integration (`test/data.integration.test.ts`: real `date`/`time`/`timestamp`/`interval` values read back as themselves, a `date` accepted back unchanged, and a mutation reply cut while the stored value stays whole) + e2e (`e2e/crud.spec.ts`: a real insert/edit/delete round trip; no write control on a view or on a keyless table; no row controls at all on a row with a shortened key; a unique violation shown as the fixed sentence without the value that collided). **Not pinned by tests**: composite-key editing end to end, concurrent write/navigation ordering, and any optimistic-concurrency behaviour — there is none, and a concurrent change to a field being edited is overwritten |
| 15 | Comment editing generates DDL and never applies it | The `COMMENT ON` generator is a pure renderer module: no database driver, no `@kozou/api`, no Node builtin — its **whole import graph** is checked, and it is asserted absent from the main, inspect-worker, MCP-worker and row-data-worker bundles and present in the built renderer (that last leg is what stops the first two from passing for a module nothing ships). Two details are load-bearing rather than cosmetic. The editor is seeded with the **verbatim** COMMENT, not the rendered `description`: kozou lifts `@widget:`/`@example:` out of that field, so an editor seeded from it deletes them on the first save — the integration test performs exactly that mistake against a real database and asserts the widget is lost, so the guard is measured rather than argued. And a materialized view is named as one, because `COMMENT ON VIEW` against it is an error; when the relkind cannot be read the app offers **no** statement for that view rather than guessing, since a guess is DDL the database rejects. The comment body is inlined as a literal (PostgreSQL's `COMMENT` takes no bind parameter) with single quotes doubled — complete under `standard_conforming_strings`, on by default since PostgreSQL 9.1 and the setting this app assumes. Export writes a file only after a native save dialog returns a path; the payload is length-bounded and the renderer-supplied file name is flattened to a single name, so it cannot choose the directory the dialog opens in | `scripts/check-treeshake.mjs` (import-graph scan, CI) + unit property tests (`test/commentEmit.test.ts`: escaping round trip over generated bodies, quoting pinned against @kozou/core's own; `test/sqlExport.test.ts`) + integration (`test/comment.integration.test.ts`: apply-and-re-introspect on a schema of its own, the negative control above, and each relation kind refusing the other's keyword) + e2e (`e2e/comment.spec.ts`: reachable with no grant, seeded verbatim, the database unchanged after drafting, the export written only on a chosen path) |

## Runtime verification (manual)

With the app running, one Inspect executed, and (if testing MCP) one local
MCP server started:

```sh
# macOS: list sockets owned by the app and its helpers
lsof -i -nP | grep -i -E "kozou|Electron"
```

Expected: TCP connections to your database only (short-lived, during
inspect / on MCP tool calls), plus — **only when a local MCP server is
running** — one `LISTEN` on `127.0.0.1:<allocated port>` per started profile
and established loopback connections from your AI clients. Anything else
(any non-loopback listener, any other outbound peer) is a regression against
this document.

### Process-lifetime verification (2026-07-16, macOS)

App lifetime bounds MCP lifetime — verified empirically on the built app:

- **Graceful quit**: with a profile's MCP server running, quitting the app
  closed the listener (the `before-quit` kill sweep).
- **Main-process crash (SIGKILL)**: with a server running, `kill -9` of the
  main process reclaimed the MCP utilityProcess within seconds (Chromium
  tears utility processes down with the browser process) — no orphan
  listener remained.

### Real-client verification (2026-08-02, macOS)

What the automated suites already establish, so this record is not read as more
than it adds: `test/mcpServer.integration.test.ts` performs a **real MCP client
handshake** in CI — the official SDK client over Streamable HTTP against a live
database, asserting the tool list is exactly the eight describe tools, calling
one of them, and forcing the execution tool to be refused. The e2e suite covers
the lifecycle (start, restore, stop, quit) and checks that the listener answers
and that the default path 404s. Both drive the server module directly.

What this record adds is the rest of the path: a **third-party AI client**, the
**built app** rather than the module, and the **config the app itself hands
you**. Claude Code CLI (2.1.209) was pointed at a started profile's capability
URL using the command the card's **AI client config** panel produced, against
`electron-vite build` output (as `pnpm start` runs) and a live database:

- the client reported the server **connected**;
- `tools/list` returned the eight describe tools and nothing else — no
  execution tool;
- `list_tables`, `describe_table` and `search_schema` came back with compiled
  semantics (COMMENTs and `@ai` notes), so the served surface is the same model
  the app draws;
- quitting the app closed the listener, as in the process-lifetime check above.

Pasting the same server into a project `.mcp.json` leaves Claude Code awaiting
an in-session approval before it connects — a client-side gate, not a server
behaviour, noted here because it looks like a connection failure.

**Scope**: one client connected. Cursor's `mcpServers` form has a unit-tested
shape and no real-client run — nothing here says it was verified.

**Claude Desktop: attempted and refused (2026-08-02).** Pasting the URL as a
custom connector is rejected before any request is made — "URL must start with
https". That is the outer gate, not the reason: a custom connector is opened
from Anthropic's cloud rather than from the user's machine and must be reachable
over the public internet, so `127.0.0.1` cannot resolve to the user's Mac
whatever the scheme. TLS on the listener would not change that, and making the
hub publicly reachable would contradict this whole document. Claude Desktop's
own configuration file launches local commands (stdio) instead of connecting to
a URL, so it has no second route either. A local stdio-to-HTTP bridge process is
the known workaround and is not provided or tested here. Recorded as a negative
result rather than a gap: the app no longer offers that path.

Known Electron caveats handled: the built-in spellchecker downloads
dictionaries from an external CDN on Windows/Linux when enabled (item 5);
`autoUpdater`/`crashReporter` are opt-in and stay unused (items 1–2); on
Linux, `safeStorage.isEncryptionAvailable()` returns true even for the
`basic_text` backend (obfuscation with a hardcoded key, selectable by anyone
via `--password-store=basic`), so the backend is checked explicitly (item 9).
