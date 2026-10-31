# Audit — Dynamic Island

A working audit of the repository as it stands, not a wish list. Every item below
was read in the source, and every "fixed" item has a test or a manual check that
proves it.

Scope: `src/main.js`, `src/preload.js`, `src/settings-preload.js`, `src/config.js`,
`src/lib/*.js`, `src/renderer/*`, `src/settings/*`, `src/ai/*`, `scripts/*`,
`.github/workflows/*`.

---

## Fixed in this pass (1.6.1)

### 1. The island renderer received the API key — high

`sendConfigToIsland()` sent `settings.get()` wholesale over IPC, so the key was
present in the renderer's `state.config.ai.apiKey`.

- `src/config.js`: new `publicConfig()` replaces the key with `hasApiKey: boolean`.
- `src/main.js`: the island, the settings window and every `settings:changed`
  broadcast now use it.
- The settings window shows an empty key field with the hint that the stored key
  is kept; **Remove key** deletes it explicitly.

Verified: `state.config.ai.apiKey === false` in the island, `CONFIG.ai.apiKey === ''`
and `hasApiKey === true` in Settings.

### 2. Any web page could post into the island — high

The Live Activities server answered `Access-Control-Allow-Origin: *`, and a
simple cross-origin POST needed no preflight. Any site you visited could draw
cards, and a card with `open` could phish.

- `POST /push` and `/clear` require `Content-Type: application/json` (415 otherwise).
- A request with an `Origin` header is refused with 403 unless `activities.allowBrowser`
  is on (new setting, default **off**).
- CORS headers are only emitted when browser access is explicitly enabled.
- Rate limit: 30 pushes/minute per process → 429.
- Body limit 16 KB → 413, and the socket is drained rather than destroyed so the
  status code actually arrives.
- A UTF-8 BOM is stripped before parsing (PowerShell writes one by default).

Verified by `test/activities.test.js` (14 tests) and live `curl`: 403 for
`Origin: https://evil.example`, 415 for `text/plain`, 200 for JSON.

### 3. Prototype pollution through the settings merge — medium

`deepMerge()` copied every key from a patch. `JSON.parse('{"__proto__":{...}}')`
creates an own `__proto__` property, which the merge then assigned.

- Blocked keys: `__proto__`, `constructor`, `prototype`.
- Exported `deepMerge` so it can be tested directly.

Verified by `test/config.test.js` (6 tests).

### 4. Any renderer could change settings or spend AI quota — medium

IPC handlers trusted whatever called them.

- `fromOwnWindow(event)` compares `event.sender.id` against the three windows the
  app owns. Applied to `settings:get`, `settings:set`, `settings:reset`,
  `settings:clear-api-key`, `ai:info`, `ai:send`, `ai:test`.
- `settings:set` re-checks that a patch is a plain object and drops an empty
  `ai.apiKey`, so a masked field can never erase a real key by accident.

### 5. No navigation or popup policy — medium

- `sandbox: true` on all three windows. Every preload only used `require('electron')`,
  so nothing broke.
- `lockDown(win)`: `setWindowOpenHandler` denies popups (http(s) goes to the real
  browser), `will-navigate` blocks anything that is not a local file, and every
  permission request is denied.

### 6. `open` on a Live Activity accepted any protocol handler — low/medium

`openTarget()` handed anything scheme-shaped to `shell.openExternal`.

- Now only `http(s):` and `mailto:` reach the shell; other schemes are ignored;
  real paths still open in Explorer; anything else is treated as a window title.

### 7. A failed AI request could leave the spinner forever — low

`window.ai.send()` rejection was unhandled in the chat window.

- `.catch()` returns an error result and the spinner always clears.

### 8. No tests, no CI check — process

- `npm test` → `node --test`, 31 tests, zero dependencies.
- `.github/workflows/ci.yml`: syntax-checks every `src`/`scripts` JS file, then
  runs the tests on push and pull request.
- `release.yml` refuses to build an installer if the tests fail.

### 9. The API key sat in plain text on disk — high

`safeStorage` (DPAPI on Windows) now seals it.

- `src/lib/keyvault.js`: `seal` / `open` / `migrateKey`, with the crypto backend
  injected so it is testable outside Electron.
- `src/config.js`: `load()` migrates an existing plaintext key on first boot,
  `save()` writes the `enc:v1:` blob and never the plaintext, `reset()` clears
  both fields.
- `hasApiKey` still drives the UI; **Remove key** clears `apiKey` and `apiKeyEnc`.
- Verified: `settings.json` now holds `"apiKey": ""` and an `enc:v1:` blob, and
  Gemini still answers after a restart (7.9 s cold, 1.9 s warm).

### 10. A Live Activity vanished when the card did — product

- `src/lib/activity-store.js`: last N (default 50) records on disk, atomic write,
  corrupt files moved to `activities.json.broken`, grouping by `group`, repeat
  counter, `priority` 0–2, unread state, dismiss and clear.
- `GET /activities` exposes the same history to scripts.
- The island grew a bell with an unread badge and a scrollable centre; opening it
  marks everything read, `×` dismisses one, **Clear all** empties it.
- Verified: four pushes → badge 3, grouped build `×2`, time-sensitive pinned to
  the top, dismiss and clear both update the DOM, and the record survived a full
  app restart.

---

## Added in 1.8.0

Three features, all of them new surface, so each one got its own module, its own
tests, and a manual check in a running app.

### 11. Search — `src/lib/search.js` + `src/search/`

Two sources: every shortcut under the per-user and all-users Start Menu, and a
bounded walk of Desktop, Documents, Downloads and Pictures. Microsoft Store apps
have no shortcut on disk, so `Get-StartApps` is spawned once in the background and
merged in.

- **Bounded by design.** Depth 4, 6,000 files, 90 s TTL. `node_modules`, `.git`,
  `dist`, `build`, caches and the Windows directory are skipped; `~$`, `.part`,
  `.crdownload`, `Thumbs.db` and `desktop.ini` are filtered out.
- **Ranked, not filtered.** exact > prefix > word start > acronym (`vsc`) >
  substring in name > substring in folder > loose letter subsequence, with apps
  above files and shallow above deep.
- **Open only what was shown.** `searchHits` holds the ids from the last query;
  an id from an older query returns `false` from both `open` and `reveal`.
- **Fresh enough to be useful.** The panel forces a rebuild when the index is more
  than 10 s old, so a file downloaded a minute ago is findable on the first
  attempt instead of after the full TTL.
- Window is focusable and separate from the click-through island; `Ctrl+Enter`
  reveals in Explorer, `Enter` opens, `Esc` or losing focus closes.
- Verified live: `note` → 24 results in 79 ms including Notepad, Sticky Notes and
  Desktop/Downloads files; forged ids return `false`; a new file was invisible
  before the rebuild and visible after it.

### 12. Folder watcher — `src/lib/inbox.js`

Polling every 1.5 s rather than `fs.watch`, because `fs.watch` on Windows fires
several times per file and is unreliable on OneDrive and network folders.

- A file is announced only once its size has stopped moving and it has been quiet
  for 1.2 s, so a half-copied file never appears as a card.
- The first pass only baselines the folder: files that were already there are
  never announced on startup.
- A file that disappears while waiting is forgotten, so dropping it again counts
  as a new transfer.
- Verified live: a file written to Downloads produced one card with name, size and
  folder, and no second card.

### 13. LocalSend receiver — `src/lib/localsend.js` + `src/transfer/`

The real v2 protocol: `GET /info`, `POST /register`, `POST /prepare-upload`,
`POST /upload`, `POST /cancel`, plus UDP multicast discovery on
`224.0.0.167:53317`.

Deliberate choices, all documented in the module header:

- **Plain HTTP.** The receiver announces `protocol: "http"`; the protocol allows
  it and senders follow the announcement. The alternative was shipping a
  self-signed certificate, which only teaches people to click through warnings.
- **Port 53318**, so it coexists with the LocalSend app on 53317.
- **Nothing is auto-accepted** unless `localsend.autoAccept` is on. The sender's
  request is held open until the window answers; a throw, a 90 s timeout or a
  closed window is a single 403.
- **Writes are atomic.** Bytes go to `.di-<token>.part` and are renamed only after
  the count matches the declared size; a mismatch deletes the temp file and
  returns 400.
- **Names cannot escape.** `sanitiseName` takes the last path segment, strips
  control characters, replaces `\ / : * ? " < > |`, blocks `CON`, `PRN`, `AUX`,
  `NUL`, `COM1-9`, `LPT1-9`, caps length at 140 and never returns an empty name.
  `uniqueName` numbers a collision instead of overwriting.
- **One session at a time** → a second sender gets 409; `/cancel` frees it.
- Tokens are 24 random bytes, per file, per session.
- Discovery failures are logged and non-fatal: a machine with a locked-down
  firewall still accepts direct connections.

Verified live over real HTTP against the running app: `prepare-upload` held for
2,178 ms until Accept was clicked, then 200; `upload` 200; the file content on disk
matched `hello from localsend`; the island showed exactly one card ("Received
from-phone.txt · 20 B · LocalSend · Test Phone") and the watcher did not duplicate
it.

### 14. Settings grew two panes

`Search` (enable, shortcut, apps/files, result count) and `Files & LocalSend`
(watch folder with a folder picker, receiver on/off, network name, port,
auto-accept). Both apply live: changing them clears the search index and restarts
the watcher and the receiver without a relaunch. 13 panes total.

---

## Found, deliberately not fixed yet

| Item | Why it is still open |
|---|---|
| **Python sidecars are supervised, not sandboxed** | They run as the same user with full filesystem access. Fixing it properly means dropping privileges or moving to a native addon; neither is a one-evening change. Crash-restart already exists. |
| **No code signing** | Out of scope without a certificate; SmartScreen will warn. |
| **`zoom` is used for island scale** | Works in Chromium, is not the same as real layout scaling; a transform-based renderer would be sharper on fractional DPI. |
| **Linux port** | Not written. Needs MPRIS over `gdbus`, `pactl`/`parec`, and a click-through workaround; cannot be built or tested on Windows. |
| **Notification mirroring, Windows Clock timers, call answering** | No public Windows API. The Live Activities endpoint is the honest substitute. Call answering stays out even as UI automation: untestable here, breaks silently with Phone Link updates. |
| **Bluetooth battery** | Needs real headphones to verify; not shipped blind. |
| **Search reads names, not contents** | Content search means an indexer, a much bigger promise than this app makes. The folder set is deliberately narrow; there is no "all drives" mode. |
| **LocalSend sender side** | Only receiving is implemented. Sending already works in the LocalSend app on both ends. |
| **LocalSend over HTTPS** | The receiver announces HTTP to avoid a self-signed certificate. Senders accept it; a stricter peer could refuse. |
| **Real second-device LocalSend test** | Verified only against a simulated sender over real HTTP on `127.0.0.1`; no phone was available. Discovery multicast is untested across a real router. |

---

## How this was verified

```powershell
npm test                       # 100/100
npm run dist                   # installer builds
# dev run, then:
curl -s http://127.0.0.1:39321/health
```

Manual checks that were run against the live app: island config contains no key,
settings load and save, AI chat answers through Gemini, Live Activities rejects
browser origins and accepts a JSON push, all five windows work with
`sandbox: true`, search returns ranked apps and files, a dropped file produces one
card, and a LocalSend transfer waits for Accept and lands on disk byte-for-byte.
