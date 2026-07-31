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
grant says. As of this build the row-data path is plumbing: no screen reaches
it, so nothing in the shipped UI can grant or use it yet.

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
| 11 | Row data is off until a native approval | `rowAccess` is absent (= off) for every new profile and is **not** part of the profile form — it lives on its own IPC channel, and an escalation is persisted only after `dialog.showMessageBox` drawn by the main process. A renderer-drawn modal is deliberately not a trust anchor: a compromised renderer could draw and "click" its own. The approval is bound to the connection it was shown for (URL, schemas, whether a password is stored), so a profile swapped behind the same name while the prompt is open does not inherit the grant. A worker's capability is fixed in its fork environment; changing a grant discards the worker rather than widening it. **Residual risk, stated plainly**: for a profile opted in to `readwrite`, a compromised renderer *can* write to that database with the stored credentials. Off-by-default, per-profile granularity and the native approval are the whole mitigation — inside Electron's trust model there is nothing stronger, because the renderer is allowed to ask for the operations the feature exists to perform | unit tests (`test/rowAccessGate.test.ts`, `test/profileStore.test.ts`, `test/dataWorkerManager.test.ts`) + e2e (`e2e/data.spec.ts`: refused while off, a declined dialog grants nothing, an approved one does) |
| 12 | Row values never reach a log | every `@kozou/api` call runs with `process.stderr` silenced, because the handler writes the raw database message before mapping it and a class-22 error (an invalid date, say) quotes the offending **value**; only a fixed, value-free breadcrumb is written instead. The transaction's own statements are outside that window, so a failure there (a COMMIT rejected by a deferred constraint or a constraint trigger raising a message built from the row) is logged as its **SQLSTATE only** — never its text. Independently, main keeps the worker's piped output out of both the UI and the log: only lines carrying the worker's own prefix are echoed, anything else is counted and dropped. Failure messages sent to the UI are re-authored — 403/404/405/409 become fixed sentences, so no primary key, row value or handler body rides along (only a 400 keeps its message, which describes the input the user just typed) | unit tests (`test/dataRunner.test.ts` incl. a COMMIT-time failure whose message quotes a value, `test/dataWorkerManager.test.ts`) + integration negative control (`test/data.integration.test.ts`: a real class-22 error, asserting the value appears in neither the reply nor stderr) |

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

Known Electron caveats handled: the built-in spellchecker downloads
dictionaries from an external CDN on Windows/Linux when enabled (item 5);
`autoUpdater`/`crashReporter` are opt-in and stay unused (items 1–2); on
Linux, `safeStorage.isEncryptionAvailable()` returns true even for the
`basic_text` backend (obfuscation with a hardcoded key, selectable by anyone
via `--password-store=basic`), so the backend is checked explicitly (item 9).
