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

| # | Item | Mechanism | Verified by |
|---|---|---|---|
| 1 | No auto-update | `autoUpdater` never imported | `scripts/check-egress-static.mjs` (CI) |
| 2 | No crash upload | `crashReporter` never imported | same |
| 3 | No outbound app-code network calls | no `fetch`/XHR/WebSocket, no `node:http(s)`/`net`/`tls`/`dgram` imports anywhere under `src/` (the local MCP server gets its listener from `@kozou/mcp`, not from a direct import), no Electron `net`/`session.fetch` | same (token + import scan) |
| 4 | Strict production CSP | `default-src 'self'`; the dev-only localhost HMR allowance is replaced at build time | same (built `out/renderer/index.html` content check) |
| 5 | Spellchecker dictionary download off | `spellcheck: false` + `setSpellCheckerEnabled(false)` | same |
| 6 | No external navigation | `will-navigate` prevented; `window.open` denied entirely (no `openExternal` path) | same (`shell.openExternal` is a forbidden token) |
| 7 | Secrets not in argv/logs | connection URL via env to workers (inspect and MCP alike); error messages and piped MCP worker stdio sanitized (decoded + percent-encoded forms, buffered to line boundaries) | unit tests (`test/url.test.ts`, `test/profileStore.test.ts`; `test/mcpServerManager.test.ts` pins the env-only channel and the stderr-tail scrub) |
| 8 | Write surfaces absent | `@kozou/api` not in the prod dependency tree; the **inspect** worker bundle is free of MCP server/transport and execution-path markers (MCP SDK type/validation modules are present by design — the describe output schemas reach them). The **MCP server** worker necessarily bundles the server stack, and `@kozou/mcp`'s server statically imports its runtime-gated execution/OAuth code — so for that worker the guarantee is **no execution path**, not "not shipped": the worker never constructs the execution/OAuth options (source tripwire in CI), and the served tool list has no execution tool and refuses a forced call (integration test against a real database) | `scripts/check-treeshake.mjs` (CI) + `test/mcpServer.integration.test.ts` |
| 9 | Real keychain only | on Linux, the `basic_text` safeStorage backend (hardcoded key) is rejected — passwords are stored only under a real keyring | code (`src/main/index.ts`) |
| 10 | Local MCP listener is loopback-only, opt-in, and read-only | default mode `off`; per-profile explicit start; bind fixed to `127.0.0.1` (never configurable to a public interface); per-profile random capability path (`/mcp-<128-bit hex>`) so a local port scan alone does not reach the tools; built-in DNS-rebinding guard (Host/Origin validation); describe tools only. **Local exposure to be aware of**: any process on the same machine that learns the path (it lands in AI-client config files in plaintext) can read schema *metadata* — table/column structure, COMMENTs, `@ai`/`@policy` annotations, function signatures; never row data. Loopback is per-machine, not per-user. The unauthenticated `POST /admin/refresh` endpoint is also exposed while running (cache invalidation → introspection load on the database — a small local nuisance lever, no data access) | integration test (404 on wrong path, 403 on forged Host, tool-list pinning) + runtime verification below |

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
