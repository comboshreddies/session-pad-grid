# session-pad-grid module layout (AI-oriented)

Repo: [comboshreddies/session-pad-grid](https://github.com/comboshreddies/session-pad-grid) — live app at [comboshreddies.github.io/session-pad-grid](https://comboshreddies.github.io/session-pad-grid/).

This project splits the former single `app.js` (~3500 lines) into **ES modules** with explicit boundaries so tools (and humans) can change one concern without breaking others.

## Rules (read before editing)

| Rule | Why |
|------|-----|
| **`config.js` has no runtime state** | Constants and MIDI maps only. |
| **`store.js` holds all mutable state** | One place for `pack`, voices, menu flags, MIDI handles. |
| **Audio routes through `playback-bus.js`** | Add master FX only via `connectVoiceToMaster()` — do not bypass. |
| **Pad colours/LEDs via `presentation.js`** | Call `setPadPlaybackVisual` / `setPadArmed` / `setPadPendingOff`; do not toggle `.active` and LEDs separately. |
| **`playback` must not import `ui/` or `grid`** | Avoid circular deps and LED regressions. |
| **`midi-device.js` owns DAW port selection** | `eachLaunchpadSessionLightOutput` — used by LED refresh in `runtime.js`. |

## Module map

```
app.js                 → import boot from runtime
js/
  config.js            → SAMPLE_PACKS, note maps, palettes, storage keys, Mini MK3 CCs
  store.js             → mutable app state (pack, voices, menus, MIDI)
  dom.js               → getElementById refs
  settings.js          → getPadLayout, assetBase, setMidiDebugLine, …
  types.js             → JSDoc typedefs
  session-slice.js     → buildVisibleSessionSlice, scroll max offset
  midi-device.js       → framesForLaunchpadOutput, eachLaunchpadSessionLightOutput
  playback-bus.js      → ensureMasterBus, connectVoiceToMaster (FX hook)
  presentation.js      → pad DOM + registerLedSync → hardware LEDs
  init-settings.js     → localStorage → UI on startup
  pack-url.js          → resolvePackJsonUrl, directory base for loop.url
  pack-catalog.js      → catalog.json manifest parse + fetch
  runtime.js           → grid, MIDI in, playback, pack load (orchestrator)
  ARCHITECTURE.md      → this file
```

After editing any file under `js/`, bump the `?v=` query on the import in `app.js` so browsers reload ES modules (sub-imports are not cache-busted automatically).

## Data flow

```text
User / MIDI
    → runtime.handleMidiMessage / grid pointer handlers
    → triggerLoop / muteColumn / menus
    → playback (BufferSource → voice Gain → connectVoiceToMaster)
    → presentation.setPad* → DOM classes + syncLaunchpadLedForLoop
```

Pack load:

```text
Local:  applyPack → loadPack(slug) → store.pack → renderGrid
Remote: loadRemotePackFromUi → fetch URL
         → if catalog (no session/loops): parsePackCatalog → fill Sample set → applyPackFromUrl
         → else: applyPackFromUrl(pack.json) → store.remotePackBaseUrl for loop.url
         → renderGrid → syncPlaybackPadClasses → refreshAllLaunchpadClipLeds
```

## Safe change guide

| Task | Edit |
|------|------|
| New sample pack slug (local) | `config.js` `SAMPLE_PACKS` + `soundlib/<slug>/` |
| Novation proxy sample sets | `config.js` `NOVATION_SAMPLE_PACKS` (sync with `catalog.novation-proxy.json`) |
| Freesound WAV loop pack | `scripts/build_freesound_pack.py` → `soundlib/freesound-loops/` + `catalog.freesound.json` |
| localStorage v0 migration | `storage-migrate.js` (`migrateStorageKeysFromV0`) |
| Remote pack list | Host `catalog.json`; load via Custom URL (`pack-catalog.js`) |
| Remote single pack | Custom URL → `pack.json` URL (`pack-url.js`) |
| Master reverb/delay | `playback-bus.js` only |
| Pad LED colour | `runtime.js` `launchpadSessionPaletteForClipPadKey` + `config.js` palettes |
| Bar quantize math | `runtime.js` transport helpers (`patternLoopDurationSeconds`, …) |
| Web grid layout | `runtime.js` `renderGrid` (consider extracting `grid-view.js` later) |
| README `pack.json` / `catalog.json` docs | `README.md` |

## Regression checklist

After non-trivial changes, verify: one-shot + loop playback, bar sync arm/play, G mute, H stop, column 8 momentary, pack change, Launchpad LEDs on DAW out, kind/type legend (CC 89/79).

## Further splits (optional)

`runtime.js` is still large (~3000 lines). Next extractions with highest ROI:

1. `grid-view.js` — `renderGrid` + pad factories  
2. `playback.js` — `triggerLoop`, `stopLoop`, `getBuffer`  
3. `midi-input.js` — `handleMidiMessage` only  

Keep `store` as the shared hub when splitting.
