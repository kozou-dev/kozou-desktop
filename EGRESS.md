# Egress hardening checklist

Design invariant: **the app's only network peer is the user's own database.**
No telemetry, no crash upload, no update checks, no external assets. Trials on
NDA-covered databases depend on this.

| # | Item | Mechanism | Verified by |
|---|---|---|---|
| 1 | No auto-update | `autoUpdater` never imported | `scripts/check-egress-static.mjs` (CI) |
| 2 | No crash upload | `crashReporter` never imported | same |
| 3 | No renderer network calls | no `fetch`/XHR/WebSocket in app code + CSP `default-src 'self'` | same + CSP meta check |
| 4 | Spellchecker dictionary download off | `spellcheck: false` + `setSpellCheckerEnabled(false)` | same |
| 5 | No external navigation | `will-navigate` prevented; `window.open` denied (https handed to OS browser) | code review (`src/main/index.ts`) |
| 6 | Secrets not in argv/logs | connection URL via env to worker; error messages sanitized | unit tests (`test/url.test.ts`, `test/profileStore.test.ts`) |
| 7 | Write surfaces absent | `@kozou/api` not in prod dependency tree; worker bundle free of MCP/execution markers | `scripts/check-treeshake.mjs` (CI) |

## Runtime verification (manual until M3)

With the app running and one Inspect executed:

```sh
# macOS: list sockets owned by the app and its helpers — expect only your DB host:port
lsof -i -nP | grep -i -E "kozou|Electron"
```

Expected: TCP connections to your database only (short-lived, during inspect).
Anything else is a regression against this document.

Known Electron caveats handled: the built-in spellchecker downloads
dictionaries from an external CDN on Windows/Linux when enabled (item 4);
`autoUpdater`/`crashReporter` are opt-in and stay unused (items 1–2).
