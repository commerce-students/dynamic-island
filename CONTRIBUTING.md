# Contributing

Thanks for wanting to help. This is a small, deliberately dependency-light
project - most of it is plain JavaScript, CSS and two short Python scripts.

## Run it from source

You need [Node.js 22+](https://nodejs.org) and [Python 3.12](https://python.org).

```powershell
git clone https://github.com/commerce-students/dynamic-island.git
cd dynamic-island
npm install
pip install -r requirements.txt
npm start
```

`npm start` uses your system Python. To run exactly what ships in the installer
(a private, portable Python), build the runtime once and then start:

```powershell
npm run runtime
npm start
```

## Build the installer

```powershell
npm run dist        # -> release\Dynamic-Island-Setup-<version>.exe
```

`npm run dist` first assembles `runtime/` (portable Python + `bridge.py` +
`volume.py`) and then packs everything with electron-builder. Nothing else on the
machine is required at runtime.

## How the app is put together

```
src/main.js              Electron main process: windows, tray, IPC, sidecar supervision
src/config.js            defaults + settings.json persistence
src/preload.js           the small API the island renderer is allowed to use
src/renderer/            the island itself (state machine, spring physics, canvas)
src/settings/            the settings window (schema-driven panes)
src/bridge.py            WinRT: media sessions, mic/camera usage, call detection
src/volume.py            Core Audio: master volume + per-app peak levels
src/lib/calendar.js      dependency-free iCalendar parser (incl. recurrence)
src/lib/activities.js    local HTTP API for Live Activities
build/                   icon, NSIS customisation
scripts/                 runtime assembly, icon generation, repo setup
```

## Things that will bite you

- **Two Python processes, not one.** `pycaw`/`comtypes` initialise COM in a way
  that conflicts with the WinRT apartment `bridge.py` needs. Merging the two
  scripts raises `Cannot change thread mode after it is set`. Keep them apart.
- **WinRT needs an apartment first.** `bridge.py` calls
  `winrt.runtime.init_apartment(MTA)` before touching any collection, otherwise
  the APIs quietly return nothing.
- **Album art colour is computed in the main process.** A `file://` canvas can't
  read pixels without tainting, so `main.js` decodes the artwork with
  `nativeImage` and reads BGRA bytes directly.
- **The island is click-through while idle.** Mouse events are forwarded on
  hover only; if you add UI, remember to switch `setIgnoreMouseEvents` back off.

## Adding a Live Activity source

Anything that can make an HTTP request can push a card:

```powershell
curl -X POST http://127.0.0.1:39321/push `
  -H "Content-Type: application/json" `
  -d '{"title":"Tests passed","subtitle":"214 in 12s","tone":"success","durationMs":6000}'
```

`POST /clear` dismisses it, `GET /health` reports whether the island is up. The
server only binds to `127.0.0.1`.

## Pull requests

- Keep the dependency count low. New runtime dependencies need a good reason.
- Match the surrounding style: 2 spaces, no semicolons, single quotes.
- Test the island itself, not just the settings window - most changes touch the
  spring animation, and that is where regressions hide.
- Screenshots help. `npm start -- --shot` regenerates `shots/` automatically.

## Assets

Do not copy artwork, icons, sounds or fonts from Apple or from other Dynamic
Island clones. Everything in `assets/` and `build/` in this repository is drawn
from scratch and MIT licensed along with the rest of the code.
