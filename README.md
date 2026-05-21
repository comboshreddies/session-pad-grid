# Session Pad Grid

Browser session pad player (**Web MIDI** + **Web Audio**) for [Launchpad Arcade](https://intro.novationmusic.com/)–style `pack.json` libraries.

**Live demo (GitHub Pages):** [https://comboshreddies.github.io/session-pad-grid/](https://comboshreddies.github.io/session-pad-grid/) — repo [comboshreddies/session-pad-grid](https://github.com/comboshreddies/session-pad-grid). Serves packs from **local** `soundlib/`, a **Novation proxy** via `server.py`, or **remote http(s)** URLs (single `pack.json` or a **`catalog.json`** manifest — implemented in `js/pack-catalog.js`).

**Code layout:** ES modules under [`js/`](js/) — see [`js/ARCHITECTURE.md`](js/ARCHITECTURE.md) for boundaries and safe-edit rules. Entry: [`app.js`](app.js).

```bash
python3 scripts/download_soundlib.py viral-hiphop   # optional: fetch a pack
python3 server.py
# open http://127.0.0.1:8765/
```

Register custom packs in the `SAMPLE_PACKS` array in `js/config.js`, or reuse an existing slug directory under `soundlib/<slug>/`. For **many packs on a web server**, publish a **`catalog.json`** (see below) — browsers cannot list directory URLs to discover `pack.json` files automatically.

**Bundled demo packs (safe to commit):** `demo-pulse` and `demo-echo` are original synthesized loops (~6.6 MB each). Regenerate with `python3 scripts/generate_demo_packs.py`. See `soundlib/DEMO-SAMPLES-LICENSE.md`. Novation packs from `scripts/download_soundlib.py` stay gitignored unless you choose to add them yourself.

### Freesound packs ([freesound.org](https://freesound.org/))

Built with `scripts/build_freesound_pack.py` (see `soundlib/FREESOUND-SAMPLES-LICENSE.md`). Generated folders `freesound-loops/` and `freesound-remote/` are **gitignored**; catalog JSON and the example pack are committed.

| Mode | Command | Output | Needs |
|------|---------|--------|--------|
| **Stub** (no API) | `python3 scripts/build_freesound_pack.py --stub` | `soundlib/freesound-loops/` — synthesized WAV + `pack.json` | Nothing |
| **WAV loops** (≤8 s, CC0) | `python3 scripts/build_freesound_pack.py` | `soundlib/freesound-loops/` — original WAV + `pack.json` | `FREESOUND_API_KEY` + `FREESOUND_ACCESS_TOKEN` ([OAuth helper](scripts/freesound_oauth_token.py)) |
| **Remote preview URLs** | `python3 scripts/build_freesound_pack.py --remote-urls` | `soundlib/freesound-remote/pack.json` only — each `loop.url` is `https://…` preview MP3/OGG | API key only |

After **stub** or **WAV** build, add or confirm `{ slug: "freesound-loops", … }` in `js/config.js` `SAMPLE_PACKS`, then **Local soundlib** → **Freesound Loops**. Or **Custom URL** → `http://127.0.0.1:8765/soundlib/catalog.freesound.json`.

**Remote URL pack:** **Custom URL** → `…/soundlib/freesound-remote/pack.json` or `catalog.freesound-remote.json`. Previews are compressed; original WAVs are not stable public links (OAuth download only). Hand-edit example: `soundlib/freesound-remote.example-pack.json`.

**Custom URL + local packs:** `loop.url` values like `freesound-loops/Drums/…/file.wav` are resolved from the **pack folder** when you load `…/freesound-loops/pack.json` (the app strips a duplicate slug prefix). Prefer **Local soundlib** for those packs, or use paths relative to the pack directory only.

---

## Loading packs (asset sources)

| Asset source (UI) | What it loads |
|-------------------|---------------|
| **Local soundlib** | `soundlib/<slug>/pack.json` for each slug in `js/config.js` `SAMPLE_PACKS` |
| **Novation (local proxy)** | `/novation/packs/<slug>/pack.json` via `server.py` (not on GitHub Pages) |
| **Custom URL** | One **http(s)** `pack.json`, **or** a **`catalog.json`** manifest listing many packs |

**Custom URL workflow**

1. Set **Asset source** → **Custom URL (pack.json)**.
2. Paste a URL and click **Load** (or press Enter).
3. **Single pack:** URL ends with `pack.json` (e.g. `https://comboshreddies.github.io/session-pad-grid/soundlib/demo-echo/pack.json`). The grid loads that pack; the built-in **Sample set** dropdown stays disabled.
4. **Catalog:** URL points to a manifest (e.g. `https://comboshreddies.github.io/session-pad-grid/soundlib/catalog.github-pages.json`). The app fetches the manifest, fills **Sample set** with every entry, loads the first (or remembered) pack, and shows a green status line under the URL field. Switch packs from **Sample set** without re-pasting URLs.

**File paths on disk:** If the app is served over `http://127.0.0.1:…`, you can paste a `file://` or absolute path to `…/soundlib/<slug>/pack.json`; it is rewritten to the same-origin `soundlib/<slug>/pack.json` URL.

**Remote pack load status:** A green line under the URL field confirms catalog or `pack.json` load; open the browser devtools **Network** tab if pads are silent (often a 404 on WAV paths or CORS on cross-origin audio).

### Web grid — rows G and H (session strips)

| Row | Default | **Pan** (side panel **C**, hold or latch) | **Volume** (hold **8G**) | **Clock** (hold **8H**) |
|-----|---------|-------------------------------------------|--------------------------|-------------------------|
| **G** | `mute col` (hold to duck column) | **L1…L8** — apply left pan to selected clips **1A…8F** | **volume** on **8G** | — |
| **H** | `stop col` (hold as stop modifier) | **R1…R8** — apply right pan | **1/8…8/8** on **1H…7H**, **8/8** on **8H** | **8H** — tick sync on **8A…8F** |

Select multiple clips in pan mode, then **L** and **R** strips independently (both can show the white “current” step). **8G** / **8H** are special (volume menu / clock), not column mute/stop in those modes.

---

## `catalog.json` format (remote pack list)

Browsers **cannot** scan `https://example.com/soundlib/` for subfolders. Use a small JSON **catalog** (filename can be `catalog.json`, `catalogue.json`, or anything — the URL you paste is what gets fetched).

### Top level

```json
{
  "packs": [
    { "slug": "demo-echo", "title": "Demo Echo (original)" },
    { "slug": "demo-pulse", "title": "Demo Pulse (original)" }
  ]
}
```

A **top-level JSON array** of entries is also accepted: `[ { "slug": "…", "title": "…" }, … ]`.

The document must **not** contain Arcade `session` / `loops` at the top level (that shape is treated as a single `pack.json`, not a catalog).

### Pack entry fields

| Field | Required | Notes |
|-------|----------|--------|
| `slug` | yes | Stable id; used in the **Sample set** dropdown and for default paths. |
| `title` | recommended | Display name in the UI. |
| `pack` | optional | Relative path to `pack.json` from the catalog URL’s directory. Default: `<slug>/pack.json`. |
| `packJson` | optional | Alias for `pack`. |
| `url` | optional | Full http(s) URL to `pack.json` (overrides `pack`). |

Example with **relative** `pack` paths (resolved from the catalog URL’s directory):

```json
{
  "packs": [
    { "slug": "demo-echo", "title": "Demo Echo (original)", "pack": "demo-echo/pack.json" },
    { "slug": "demo-pulse", "title": "Demo Pulse (original)", "pack": "demo-pulse/pack.json" }
  ]
}
```

If `catalog.json` is served at `https://comboshreddies.github.io/session-pad-grid/soundlib/catalog.github-pages.json`, each entry’s `url` (or default `<slug>/pack.json` next to the catalog) resolves under that host.

Example with **full http(s) URLs** (`url` overrides `pack`; packs can live on different hosts if CORS allows):

```json
{
  "packs": [
    {
      "slug": "demo-echo",
      "title": "Demo Echo (original)",
      "url": "https://comboshreddies.github.io/session-pad-grid/soundlib/demo-echo/pack.json"
    },
    {
      "slug": "demo-pulse",
      "title": "Demo Pulse (original)",
      "url": "https://comboshreddies.github.io/session-pad-grid/soundlib/demo-pulse/pack.json"
    }
  ]
}
```

Each pack’s `loop.url` values in that `pack.json` are then resolved against **that pack’s** directory (same rules as local soundlib), except **Novation Arcade** packs: those use `packs/<slug>/…` paths relative to the CDN or `/novation/` proxy root (handled automatically when the catalog points at Novation `pack.json` URLs).

### Novation Arcade catalogs

Official packs from [Launchpad Arcade](https://intro.novationmusic.com/) (13 packs as of the current `bundle.js`). Three manifests:

| File | Use when |
|------|----------|
| `catalog.novation.json` | Each pack’s `url` → `https://intro.novationmusic.com/packs/<slug>/pack.json`. Load locally via Custom URL (needs Novation **CORS** for WAVs). |
| `catalog.novation-local.json` | Relative `soundlib/<slug>/pack.json` after `python3 scripts/download_soundlib.py all` (not on GitHub Pages). |
| `catalog.novation-proxy.json` | **`python3 server.py`** — Custom URL: `http://127.0.0.1:8765/soundlib/catalog.novation-proxy.json` (same-origin `/novation/` proxy, best for Novation). |
| `catalog.novation-cdn.json` | Same as `catalog.novation.json` (alias). |

**Asset source “Novation (local proxy)”** still works without a catalog (built-in slugs in `js/config.js` when listed). The catalog is for **Custom URL** + **Sample set** switching across all Novation packs.

Novation content is subject to [Novation’s terms](https://intro.novationmusic.com/); demo packs `demo-pulse` / `demo-echo` are separate originals in this repo.

### Hosting requirements

- **CORS:** `Access-Control-Allow-Origin` must allow your app origin (or `*`).
- **COEP:** If the **app page** is served with `Cross-Origin-Embedder-Policy: require-corp`, remote `pack.json` and WAVs on **other** hosts need `Cross-Origin-Resource-Policy: cross-origin`. Same-host catalog + packs (e.g. all on `comboshreddies.github.io`) are fine.

Example manifests in the repo (copy to your server as `catalog.json`):

| File | Style |
|------|--------|
| `soundlib/catalog.example.json` | Relative paths — `{ "slug", "title" }` only (defaults to `<slug>/pack.json` next to the catalog) |
| `soundlib/catalog.github-pages.json` | Ready-to-load catalog for [comboshreddies/session-pad-grid](https://github.com/comboshreddies/session-pad-grid) on Pages |
| `soundlib/catalog.example-full-url.json` | Same full URLs (example copy) |
| `soundlib/catalog.example-github-pages.json` | Same URLs (example copy for docs) |
| `soundlib/catalog.novation.json` | Novation Arcade — full `intro.novationmusic.com` pack.json URLs |
| `soundlib/catalog.novation-local.json` | Novation — local `soundlib/<slug>/` after `scripts/download_soundlib.py` |
| `soundlib/catalog.novation-proxy.json` | Novation via `server.py` — `/novation/packs/<slug>/pack.json` (Custom URL + **Load**) |
| `soundlib/catalog.novation-cdn.json` | Novation CDN full URLs (often blocked by CORS in the browser) |
| `soundlib/catalog.freesound.json` | Local **freesound-loops** after `build_freesound_pack.py` (stub or WAV) |
| `soundlib/catalog.freesound-remote.json` | **freesound-remote** pack (preview URLs only) |
| `soundlib/freesound-remote.example-pack.json` | Minimal example — one `loop.url` as full `https://…` preview |

Regenerate Novation catalogs from Novation’s live bundle:

```bash
python3 scripts/generate_novation_catalog.py
```

---

## `pack.json` format

Each sample set is a single JSON file:

| Source | Path |
|--------|------|
| Local | `soundlib/<slug>/pack.json` → fetched as `/soundlib/<slug>/pack.json` |
| Proxy | Novation CDN → `/novation/packs/<slug>/pack.json` |
| Custom URL | Full URL you paste, or `catalog.json` entry → `pack` / `url` |

The file matches the Launchpad Arcade export shape. This app reads the fields below; extra keys (e.g. `lights`) are ignored for playback.

### Top level

```json
{
  "session": { ... },
  "loops": [ ... ]
}
```

Optional `lights` arrays from Arcade are not required.

### `session`

| Field | Type | Used by app | Notes |
|-------|------|-------------|--------|
| `title` | string | UI | Display name; defaults to slug. |
| `tempo` | number | Transport | BPM; default `120`. |
| `patternLength` | number | Bar clock | Length in **16th-note steps**; `16` ≈ one 4/4 bar. Default `16`. |
| `channels` | array | Pad grid | **8 columns**; each column is an array of **row slots** (often 8 rows per column in the file). |

Rows **A–F** (indices `0`–`5`) are clip pads. Rows **G** and **H** are handled as mute/stop strips in the app, not as clip slots from `channels`.

Each cell in `session.channels[col][row]` is an object, typically:

```json
{
  "loopId": "0",
  "gain": { "dB": "0" },
  "trigger": { "type": "oneshot", "syncTo": "bar" }
}
```

- **`loopId`** — string (or number in JSON) referencing `loops[].loopId`.
- **`trigger.type`** — `"oneshot"` or `"loop"` (also read from `loops[].padData` when present).
- **`trigger.syncTo`** — `"bar"` or `"beat"` for quantized start/stop; omit for immediate one-shots.

If the pack defines **more than six clip rows** per column, only six are shown at once; use hardware **▲/▼** (Mini MK3 DAW) or scroll logic to move the visible window over `channels`.

### `loops[]`

Each entry describes one sample and how it is played.

| Field | Required | Notes |
|-------|----------|--------|
| `loopId` | yes | Unique id (stringified internally). Must match `session.channels` references. |
| `url` | yes | Audio file location (see [Audio URLs](#audio-urls)). |
| `name` | recommended | Shown on the web pad. |
| `type` | recommended | e.g. `"oneshot"`, `"loop"` — drives looping vs one-shot and type legend. |
| `category` | optional | Shown as **kind** when `kind` is missing. |
| `kind` | optional | Kind legend / web UI middle line. |
| `gain` | optional | String dB value, e.g. `"0"`; converted to linear gain. |
| `loopLength` | optional | Arcade metadata only — **not** used for playback length in this app (see [Loop duration](#loop-duration-and-looplength)). |
| `file` | optional | Original filename; not used for fetch ( **`url`** is). |
| `padData` | optional | Arcade pad metadata; `padData.pad.trigger.type` / `syncTo` used when top-level fields are absent. |

Minimal custom loop:

```json
{
  "loopId": "1",
  "name": "My Hat",
  "type": "oneshot",
  "category": "Drums",
  "kind": "Hats",
  "gain": "0",
  "url": "my-pack/Drums/oneshot/Drums/Hats/my-hat.wav"
}
```

Minimal custom pack skeleton:

```json
{
  "session": {
    "title": "My Pack",
    "tempo": 120,
    "patternLength": 16,
    "channels": [
      [{ "loopId": "1", "trigger": { "type": "oneshot" } }],
      [],
      [],
      [],
      [],
      [],
      [],
      []
    ]
  },
  "loops": [
    {
      "loopId": "1",
      "name": "Kick",
      "type": "oneshot",
      "url": "my-pack/Drums/oneshot/Drums/Kick/kick.wav"
    }
  ]
}
```

Expand each column to 6+ rows to fill the clip grid; pad **1A** = column 1, row A (`channels[0][0]`).

### Audio URLs

`loop.url` is resolved by `absoluteUrl()` in `js/runtime.js`:

1. **Relative path** (recommended for local packs) — joined to the asset base:
   - **Local soundlib:** `soundlib/` + path → e.g. `demo-echo/Drums/…/kick.wav` on disk
   - **Novation proxy:** `/novation/` + path → Novation CDN
   - **Custom URL / catalog:** directory containing the loaded `pack.json` (if the path still starts with `<slug>/`, that prefix is stripped so WAVs are not requested twice)
2. **Absolute URL** — `https://…` fetched as-is (Freesound previews, your CDN, etc.; needs CORS unless same-origin).

After `scripts/download_soundlib.py`, URLs look like:

```text
<slug>/<category>/<type>/<kind>/<name>/<filename.wav>
```

Example on disk:

```text
soundlib/my-pack/Drums/oneshot/Drums/Kick/kick.wav
```

with `"url": "my-pack/Drums/oneshot/Drums/Kick/kick.wav"`.

---

## Loop duration and `loopLength`

### Who controls how long a loop plays?

| What | Controls playback length? | Role |
|------|---------------------------|------|
| **Audio file** (`loop.url`) | **Yes** | Decoded buffer length is the sample. This is the only length that matters for sound. |
| **`loops[].loopLength`** | **No** (here) | Optional Arcade field (often 16th-note steps in the original product). **Ignored** by `app.js`. |
| **`session.patternLength`** | **No** (per clip) | Pack-wide grid: bar clock, quantize snaps, purple G-row tick spacing — not trimming of individual WAVs. |
| **`session.tempo`** | **No** (per clip) | BPM for bar/beat sync timing, not WAV duration. |
| **`type: "loop"`** | **How** it plays | Repeats the **entire** decoded file (`loopStart = 0`, `loopEnd = buffer duration`). Does not shorten the file. |
| **`type: "oneshot"`** | **How** it plays | Plays the file once from start to natural end. |

**Bottom line:** loop duration comes from the **file on disk** (after decode), not from `loopLength` in JSON. Two clips with the same `loopLength` in `pack.json` can still be different lengths in seconds. A `loopLength` of `4` is **not** enforced as half the duration of `loopLength` `8` in this tool.

Official Arcade packs may have been authored with `loopLength` in mind, but file lengths still vary. This app does not re-trim Novation assets to match that metadata.

### Trim before packing

For **custom packs**, cut each sample to the length you want **before** adding it to `soundlib/` and `pack.json`:

1. **One-shots** — trim silence and set the hit length you want; playback runs through the whole file.
2. **Loops** (`type: "loop"`) — export a seamless loop at the correct bar length (e.g. 1 or 2 bars at your pack `tempo`). The player will repeat the full WAV; extra audio after the loop point will be heard every cycle.
3. **Bar/beat sync** (`syncTo: "bar"` / `"beat"`) — align musically to `session.tempo` and your intended bar count; sync only schedules **when** playback starts/stops, not **how many seconds** of the file play.

You can leave `loopLength` in JSON for compatibility with Arcade tools, but Session Pad Grid will not read it unless you add that logic yourself.

### Handy length math (authoring only)

At `session.tempo` BPM and `session.patternLength` in 16th-note steps (default `16` = one 4/4 bar):

```text
one 16th note  = (60 / tempo) × 4 / patternLength   seconds
one bar (4/4)  = (60 / tempo) × 4                   seconds
```

Example: tempo `120`, `patternLength` `16` → one bar = **2.0 s**. A 2-bar loop should be about **4.0 s** in the file — not “set `loopLength` to 32 and hope.”

---

## Supported audio formats

Playback does **not** use a separate audio library. Samples are loaded in `getBuffer()`:

1. `fetch(loop.url)`
2. `AudioContext.decodeAudioData(arrayBuffer)`
3. Play via `AudioBufferSourceNode`

There is **no** extension check in code — success depends on **what the browser can decode**.

### Recommended

| Format | Extensions | Notes |
|--------|------------|--------|
| **WAV (PCM)** | `.wav` | **Default choice** — matches Arcade, `scripts/download_soundlib.py`, and bar/beat sync behavior. |
| **AIFF** | `.aif`, `.aiff` | Present in some official packs; works on many Safari/macOS setups; test on Chrome if you target it. |

### May work (browser-dependent)

Treat as experimental; verify in every browser you care about.

| Format | Extensions | Typical support |
|--------|------------|-----------------|
| MP3 | `.mp3` | Chrome, Firefox, Safari |
| OGG Vorbis | `.ogg` | Chrome, Firefox (weak on Safari) |
| FLAC | `.flac` | Modern Chrome / Firefox / Edge |
| AAC / MP4 audio | `.m4a`, `.aac` | Safari, Chrome (varies) |
| WebM audio | `.webm` | Chromium |

### Not supported

- MIDI (`.mid`), module music, WMA, and other formats **not** handled by `decodeAudioData`
- Any format without a decodable PCM buffer in the browser

Convert those to WAV (or another supported format) before referencing them in `pack.json`.

### Practical notes for custom packs

- **Bar/beat-synced loops** (`syncTo: "bar"` / `"beat"`): prefer **uncompressed WAV** — MP3/AAC encoder delay can make grid sync feel wrong.
- **Failures** show as fetch or decode errors in the browser devtools console; the pad stays silent.
- The UI and downloader text say “WAV” because that is the supported **workflow**; other extensions are only “supported” insofar as the browser decodes them.

### Example: non-WAV `url`

```json
{
  "loopId": "2",
  "name": "Alt Hat",
  "type": "oneshot",
  "url": "my-pack/Drums/oneshot/Drums/Hats/hat.flac"
}
```

Place `soundlib/my-pack/Drums/oneshot/Drums/Hats/hat.flac` on disk, enable audio in the UI, and trigger the pad once to confirm decode in your browser.

---

## One codebase: local server and GitHub Pages

The same files work in both places. Only **how you host** and **asset source** change:

| | **Local (`python3 server.py`)** | **GitHub Pages** |
|--|--|--|
| **Host** | `python3 server.py` → `http://127.0.0.1:8765/` | Static deploy from repo root |
| **Local soundlib** | `soundlib/` on disk (via `scripts/download_soundlib.py`) | Commit `soundlib/<slug>/` in git (not in `.gitignore` for deploy) |
| **Novation proxy** | Asset source **Novation (local proxy)** → `novation/` proxied by `server.py` | Not available — use **Local soundlib** or **Custom URL** |
| **Custom URL / catalog** | Paste `pack.json` or `catalog.json` (needs CORS on the remote host) | Same — host `catalog.json` + packs on https with CORS |
| **Plain static server** | `python3 -m http.server` works with **Local soundlib** only (no `/novation/` proxy) | Same as Pages |

Asset URLs are **relative** (`soundlib/…`, `novation/…`) so they resolve under both `http://127.0.0.1:8765/` and `https://comboshreddies.github.io/session-pad-grid/`.

---

## GitHub Pages

The app is static HTML + ES modules; no build step is required. Host the **repository root** (where `index.html` lives) as the Pages source.

| Topic | What to do |
|--------|------------|
| **URL** | Project site: `https://comboshreddies.github.io/session-pad-grid/`. Asset paths are **relative** (`soundlib/…`) so packs load under the repo prefix. |
| **Audio files** | `.gitignore` ignores `soundlib/*` except **demo packs**, **catalog\*.json**, license files, and `freesound-remote.example-pack.json`. Commit `demo-pulse` / `demo-echo` for a small Pages demo (~13 MB). Novation / Freesound builds stay local unless you change `.gitignore`. Full `scripts/download_soundlib.py all` is ~100 MB+ — consider [Git LFS](https://git-lfs.github.com/) if you commit Novation WAVs. |
| **Novation proxy** | `python3 server.py`’s `/novation/` proxy does **not** run on GitHub Pages. Use **Local soundlib** or **Custom URL** online. |
| **Remote catalog** | Paste a `catalog.json` URL under **Custom URL**; remote host must allow CORS (and CORP if your Pages site uses COEP). |
| **HTTPS** | GitHub Pages serves HTTPS, which Web MIDI needs in most browsers. |
| **`.nojekyll`** | Included so Jekyll does not skip static assets. |

**Settings:** In [comboshreddies/session-pad-grid](https://github.com/comboshreddies/session-pad-grid) → **Settings** → **Pages** → Build from branch **main**, folder **/** (root).

**Custom URL on the live site:** paste  
`https://comboshreddies.github.io/session-pad-grid/soundlib/catalog.github-pages.json`  
and click **Load** (demo packs only). For Novation on your machine: Custom URL → `http://127.0.0.1:8765/soundlib/catalog.novation.json` (CDN URLs), or `catalog.novation-proxy.json` with `python3 server.py`, or `catalog.novation-local.json` after `scripts/download_soundlib.py`.

**Local check (same layout as Pages):**

```bash
git clone https://github.com/comboshreddies/session-pad-grid.git
cd session-pad-grid
python3 -m http.server 8765
# open http://127.0.0.1:8765/   (not server.py — that is only needed for /novation/ proxy)
```

`server.py` still works for development with the Novation proxy; use `http://127.0.0.1:8765/` with `server.py` when you need **Novation (proxy)**.

---

## Related files

| File | Role |
|------|------|
| `scripts/download_soundlib.py` | Download Arcade `pack.json` + audio into `soundlib/<slug>/` and rewrite `loop.url` for local paths. |
| `server.py` | Static server for `/soundlib/` and `/novation/` proxy. |
| `soundlib/catalog.example.json` | Example catalog — relative pack paths. |
| `soundlib/catalog.example-full-url.json` | Example catalog — full `url` per pack (remote CDN). |
| `soundlib/catalog.github-pages.json` | GitHub Pages catalog (`comboshreddies/session-pad-grid`). |
| `soundlib/catalog.example-github-pages.json` | Example copy of the Pages catalog. |
| `soundlib/catalog.novation.json` | Novation packs — `intro.novationmusic.com` pack.json URLs. |
| `soundlib/catalog.novation-local.json` | Novation packs — relative paths (local download). |
| `soundlib/catalog.novation-proxy.json` | Novation packs — `/novation/packs/…` for `server.py`. |
| `soundlib/catalog.novation-cdn.json` | Novation packs — `intro.novationmusic.com` URLs. |
| `scripts/generate_novation_catalog.py` | Refresh Novation catalog files from live Arcade. |
| `scripts/generate_demo_packs.py` | Regenerate committed `demo-pulse` / `demo-echo` WAVs + `pack.json`. |
| `scripts/build_freesound_pack.py` | Freesound loops: `--stub`, WAV download, or `--remote-urls`. |
| `scripts/freesound_oauth_token.py` | One-time OAuth2 token for Freesound original WAV download. |
| `soundlib/FREESOUND-SAMPLES-LICENSE.md` | Freesound build notes and credits template. |
| `app.js` | Boots `js/runtime.js` (bump `?v=` on the import after `js/` changes). |
| `js/pack-url.js` | Resolve/normalize remote `pack.json` URLs and `file://` → local `soundlib/` paths. |
| `js/pack-catalog.js` | Parse `catalog.json` manifests and resolve per-pack `pack.json` URLs. |
| `js/runtime.js` | Pack load, grid, MIDI, Web Audio playback. |
| `js/ARCHITECTURE.md` | Module map and rules for AI/human edits. |
