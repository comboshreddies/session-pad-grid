# Freesound samples — license record

## Remote preview URLs (no download)

Each `loop.url` may be a **full https URL** to Freesound’s preview MP3/OGG (from API field `previews.preview-hq-mp3`, etc.). The browser loads them directly.

```bash
export FREESOUND_API_KEY=...
python3 scripts/build_freesound_pack.py --remote-urls
```

Example shape: `soundlib/freesound-remote.example-pack.json`

**Not valid in `loop.url`:** sound page URLs (`https://freesound.org/sounds/123/`), OAuth download links, or FTP.

## Local WAV (≤8 s)

```bash
python3 scripts/build_freesound_pack.py --stub    # placeholders, no API
python3 scripts/build_freesound_pack.py         # WAV originals + OAuth token
```

## Stub pack (current)

**Stub pack** — loops are synthesized placeholders from `python3 scripts/build_freesound_pack.py --stub`.

Replace with real Freesound WAVs or remote preview URLs as above.
