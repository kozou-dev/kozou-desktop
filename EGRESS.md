# Egress hardening checklist

Design invariant: **the app's only network peer is the user's own database.**
No telemetry, no crash upload, no update checks, no external assets. Trials on
NDA-covered databases depend on this.

| # | Item | Mechanism | Verified by |
|---|---|---|---|
| 1 | No auto-update | `autoUpdater` never imported | `scripts/check-egress-static.mjs` (CI) |
| 2 | No crash upload | `crashReporter` never imported | same |
| 3 | No app-code network calls | no `fetch`/XHR/WebSocket, no `node:http(s)`/`net`/`tls`/`dgram`, no Electron `net`/`session.fetch` | same (token + import scan) |
| 4 | Strict production CSP | `default-src 'self'`; the dev-only localhost HMR allowance is replaced at build time | same (built `out/renderer/index.html` content check) |
| 5 | Spellchecker dictionary download off | `spellcheck: false` + `setSpellCheckerEnabled(false)` | same |
| 6 | No external navigation | `will-navigate` prevented; `window.open` denied entirely (no `openExternal` path in M1) | same (`shell.openExternal` is a forbidden token) |
| 7 | Secrets not in argv/logs | connection URL via env to worker; error messages sanitized (decoded + percent-encoded forms) | unit tests (`test/url.test.ts`, `test/profileStore.test.ts`) |
| 8 | Write surfaces absent | `@kozou/api` not in prod dependency tree; worker bundle free of MCP/execution markers | `scripts/check-treeshake.mjs` (CI) |
| 9 | Real keychain only | on Linux, the `basic_text` safeStorage backend (hardcoded key) is rejected — passwords are stored only under a real keyring | code (`src/main/index.ts`) |

## Runtime verification (manual until M3)

With the app running and one Inspect executed:

```sh
# macOS: list sockets owned by the app and its helpers — expect only your DB host:port
lsof -i -nP | grep -i -E "kozou|Electron"
```

Expected: TCP connections to your database only (short-lived, during inspect).
Anything else is a regression against this document.

Known Electron caveats handled: the built-in spellchecker downloads
dictionaries from an external CDN on Windows/Linux when enabled (item 5);
`autoUpdater`/`crashReporter` are opt-in and stay unused (items 1–2); on
Linux, `safeStorage.isEncryptionAvailable()` returns true even for the
`basic_text` backend (obfuscation with a hardcoded key, selectable by anyone
via `--password-store=basic`), so the backend is checked explicitly (item 9).
