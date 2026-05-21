#!/usr/bin/env python3
"""
Build a Launchpad-style pack from Freesound loops (WAV only, duration ≤ 8 s).

Requirements:
  - Freesound API key: https://freesound.org/apiv2/apply/ → FREESOUND_API_KEY
  - OAuth2 access token for downloads (original WAV): FREESOUND_ACCESS_TOKEN
    Obtain once: python3 scripts/freesound_oauth_token.py

Usage (from repo root):
  python3 scripts/build_freesound_pack.py --stub   # no API; synthesized WAV placeholders
  export FREESOUND_API_KEY=...
  python3 scripts/build_freesound_pack.py --remote-urls   # pack.json only; loop.url = Freesound preview MP3/OGG
  export FREESOUND_ACCESS_TOKEN=...   # Bearer token (WAV download only)
  python3 scripts/build_freesound_pack.py
  python3 scripts/build_freesound_pack.py --cols 8 --rows 4   # default 8×4 (A–D)

Writes:
  soundlib/freesound-loops/…/*.wav
  soundlib/freesound-loops/pack.json
  soundlib/catalog.freesound.json
  soundlib/FREESOUND-SAMPLES-LICENSE.md
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOUNDLIB = ROOT / "soundlib"
SLUG = "freesound-loops"
SLUG_REMOTE = "freesound-remote"
PREVIEW_KEYS = ("preview-hq-mp3", "preview-lq-mp3", "preview-hq-ogg", "preview-lq-ogg")
API_BASE = "https://freesound.org/apiv2"
MAX_DURATION_SEC = 8.0
PATTERN_LENGTH = 16
DEFAULT_TEMPO = 120

# (category, kind, search query) per column — all slots are type "loop"
COL_SLOTS = [
    ("Drums", "Kick", "kick drum loop"),
    ("Drums", "Snare", "snare drum loop"),
    ("Drums", "Hats", "hi hat loop"),
    ("Bass", "Bass", "bass loop"),
    ("Melodic", "Chords", "chord loop"),
    ("Melodic", "Lead", "synth lead loop"),
    ("Melodic", "Pad", "pad loop"),
    ("Drums", "Perc", "percussion loop"),
]

ROW_NAMES = "ABCDEF"


def safe_seg(s: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(s).strip())
    return re.sub(r"\s+", "_", s) or "slot"


def api_request(path: str, *, token: str, bearer: str | None = None) -> bytes:
    url = path if path.startswith("http") else f"{API_BASE}{path}"
    auth = f"Bearer {bearer}" if bearer else f"Token {token}"
    req = urllib.request.Request(url, headers={"Authorization": auth, "User-Agent": "session-pad-grid-freesound/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def search_loops(token: str, query: str, *, wav_only: bool, page_size: int = 15) -> list[dict]:
    filt = (
        f'duration:[0.3 TO {MAX_DURATION_SEC}] '
        f'license:"Creative Commons 0"'
    )
    if wav_only:
        filt += " type:wav"
    params = {
        "query": f"{query} loop",
        "filter": filt,
        "sort": "rating_desc",
        "fields": "id,name,duration,username,license,download,type,previews",
        "page_size": str(page_size),
    }
    qs = urllib.parse.urlencode(params)
    raw = api_request(f"/search/text/?{qs}", token=token)
    data = json.loads(raw.decode("utf-8"))
    return list(data.get("results") or [])


def search_loop_wav(token: str, query: str, page_size: int = 15) -> list[dict]:
    return search_loops(token, query, wav_only=True, page_size=page_size)


def preview_url_from_sound(sound: dict) -> str | None:
    previews = sound.get("previews") or {}
    if not isinstance(previews, dict):
        return None
    for key in PREVIEW_KEYS:
        u = str(previews.get(key) or "").strip()
        if u.startswith("http"):
            return u
    return None


def file_name_from_url(url: str) -> str:
    try:
        path = urllib.parse.urlparse(url).path
        name = path.rsplit("/", 1)[-1]
        return name if name else "preview.mp3"
    except Exception:
        return "preview.mp3"


def download_sound_wav(sound_id: int, dest: Path, *, token: str, bearer: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        body = api_request(f"/sounds/{sound_id}/download/", token=token, bearer=bearer)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"download {sound_id}: HTTP {e.code} — need FREESOUND_ACCESS_TOKEN (OAuth2)") from e
    if not body.startswith(b"RIFF"):
        raise RuntimeError(f"download {sound_id}: not a WAV file (got {body[:12]!r})")
    dest.write_bytes(body)
    ensure_stereo_wav(dest)


def ensure_stereo_wav(path: Path) -> None:
    """Duplicate mono WAV to stereo so the app’s pan controls behave consistently."""
    with wave.open(str(path), "rb") as wf:
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        rate = wf.getframerate()
        n = wf.getnframes()
        frames = wf.readframes(n)
    if ch >= 2:
        return
    if sw != 2:
        raise RuntimeError(f"{path}: only 16-bit PCM supported, got width {sw}")
    samples = struct.unpack(f"<{n}h", frames)
    stereo = []
    for s in samples:
        stereo.extend((s, s))
    tmp = path.with_suffix(".tmp.wav")
    with wave.open(str(tmp), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(struct.pack(f"<{len(stereo)}h", *stereo))
    tmp.replace(path)


def make_loop_entry(
    loop_id: str,
    col: int,
    row: int,
    cat: str,
    kind: str,
    name: str,
    file_name: str,
    rel_url: str,
) -> dict:
    return {
        "category": cat,
        "file": file_name,
        "gain": "0",
        "kind": kind,
        "loopId": loop_id,
        "loopLength": PATTERN_LENGTH,
        "name": name,
        "url": rel_url,
        "padData": {
            "channelId": col,
            "rowId": row,
            "pad": {
                "gain": {"dB": "0"},
                "loopId": loop_id,
                "trigger": {"type": "loop", "syncTo": "bar"},
            },
        },
        "type": "loop",
        "lightIndex": None,
    }


def build_pack(
    *,
    token: str,
    bearer: str,
    cols: int,
    rows: int,
    used_ids: set[int],
) -> tuple[dict, list[dict]]:
    base = SOUNDLIB / SLUG
    loops: list[dict] = []
    channels: list[list[dict]] = [[] for _ in range(cols)]
    credits: list[dict] = []
    loop_idx = 0

    for col in range(cols):
        if col >= len(COL_SLOTS):
            break
        cat, kind, query = COL_SLOTS[col]
        col_cells: list[dict] = []
        for row in range(rows):
            row_letter = ROW_NAMES[row]
            name = f"{kind} {row_letter}{col + 1}"
            results = search_loop_wav(token, f"{query} {row_letter}")
            picked = None
            for cand in results:
                sid = int(cand["id"])
                if sid in used_ids:
                    continue
                dur = float(cand.get("duration") or 0)
                if dur <= 0 or dur > MAX_DURATION_SEC:
                    continue
                if str(cand.get("type") or "").lower() not in ("wav", "wave", ""):
                    continue
                picked = cand
                used_ids.add(sid)
                break
            if not picked:
                print(f"  warn: no WAV loop for col {col + 1} row {row_letter} ({query})", file=sys.stderr)
                col_cells.append({})
                continue

            sid = int(picked["id"])
            file_name = f"{safe_seg(kind)}_{row_letter}{col + 1}.wav"
            rel_path = f"{SLUG}/{cat}/loop/{kind}/{safe_seg(name)}/{file_name}"
            wav_path = base / cat / "loop" / kind / safe_seg(name) / file_name

            print(f"  [{loop_idx}] {name} ← Freesound {sid} ({picked.get('name')}) {picked.get('duration')}s")
            download_sound_wav(sid, wav_path, token=token, bearer=bearer)

            lid = str(loop_idx)
            loop = make_loop_entry(lid, col, row, cat, kind, name, file_name, rel_path)
            loops.append(loop)
            col_cells.append(
                {
                    "gain": {"dB": "0"},
                    "loopId": lid,
                    "trigger": {"type": "loop", "syncTo": "bar"},
                }
            )
            credits.append(
                {
                    "freesound_id": sid,
                    "name": picked.get("name"),
                    "username": picked.get("username"),
                    "license": picked.get("license"),
                    "duration_sec": picked.get("duration"),
                    "pad": name,
                    "file": rel_path,
                }
            )
            loop_idx += 1
        channels[col] = col_cells

    pack = {
        "lights": [],
        "loops": loops,
        "session": {
            "channels": channels,
            "tempo": DEFAULT_TEMPO,
            "timingSample": None,
            "title": "Freesound Loops (WAV ≤8s)",
            "patternLength": PATTERN_LENGTH,
        },
    }
    return pack, credits


def build_pack_remote_urls(
    *,
    token: str,
    cols: int,
    rows: int,
    used_ids: set[int],
) -> tuple[dict, list[dict]]:
    """pack.json only: each loop.url is a Freesound preview MP3/OGG (https://…). No OAuth download."""
    loops: list[dict] = []
    channels: list[list[dict]] = [[] for _ in range(cols)]
    credits: list[dict] = []
    loop_idx = 0

    for col in range(cols):
        if col >= len(COL_SLOTS):
            break
        cat, kind, query = COL_SLOTS[col]
        col_cells: list[dict] = []
        for row in range(rows):
            row_letter = ROW_NAMES[row]
            name = f"{kind} {row_letter}{col + 1}"
            results = search_loops(token, f"{query} {row_letter}", wav_only=False)
            picked = None
            preview = None
            for cand in results:
                sid = int(cand["id"])
                if sid in used_ids:
                    continue
                dur = float(cand.get("duration") or 0)
                if dur <= 0 or dur > MAX_DURATION_SEC:
                    continue
                preview = preview_url_from_sound(cand)
                if not preview:
                    continue
                picked = cand
                used_ids.add(sid)
                break
            if not picked or not preview:
                print(
                    f"  warn: no preview URL for col {col + 1} row {row_letter} ({query})",
                    file=sys.stderr,
                )
                col_cells.append({})
                continue

            sid = int(picked["id"])
            file_name = file_name_from_url(preview)
            print(
                f"  [{loop_idx}] {name} ← Freesound {sid} preview ({picked.get('name')}) {preview[:72]}…"
            )
            lid = str(loop_idx)
            loop = make_loop_entry(lid, col, row, cat, kind, name, file_name, preview)
            loops.append(loop)
            col_cells.append(
                {
                    "gain": {"dB": "0"},
                    "loopId": lid,
                    "trigger": {"type": "loop", "syncTo": "bar"},
                }
            )
            credits.append(
                {
                    "freesound_id": sid,
                    "name": picked.get("name"),
                    "username": picked.get("username"),
                    "license": picked.get("license"),
                    "duration_sec": picked.get("duration"),
                    "pad": name,
                    "preview_url": preview,
                }
            )
            loop_idx += 1
        channels[col] = col_cells

    pack = {
        "lights": [],
        "loops": loops,
        "session": {
            "channels": channels,
            "tempo": DEFAULT_TEMPO,
            "timingSample": None,
            "title": "Freesound Loops (remote preview URLs)",
            "patternLength": PATTERN_LENGTH,
        },
    }
    return pack, credits


def write_catalog(*, remote: bool = False) -> None:
    if remote:
        catalog = {
            "title": "Freesound loop packs (remote preview URLs)",
            "packs": [
                {
                    "slug": SLUG_REMOTE,
                    "title": "Freesound Remote (preview MP3/OGG)",
                    "pack": "freesound-remote/pack.json",
                }
            ],
        }
        path = SOUNDLIB / "catalog.freesound-remote.json"
    else:
        catalog = {
            "title": "Freesound loop packs (local WAV)",
            "packs": [{"slug": SLUG, "title": "Freesound Loops (WAV ≤8s)"}],
        }
        path = SOUNDLIB / "catalog.freesound.json"
    path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")


def _load_demo_synth():
    path = ROOT / "scripts" / "generate_demo_packs.py"
    spec = importlib.util.spec_from_file_location("generate_demo_packs", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def build_stub_pack(*, cols: int, rows: int) -> dict:
    """Synthesized loop WAVs (no Freesound) so Local soundlib works before API build."""
    demo = _load_demo_synth()
    base = SOUNDLIB / SLUG
    tempo = DEFAULT_TEMPO
    brightness = 0.9
    detune = 0.02
    loops: list[dict] = []
    channels: list[list[dict]] = [[] for _ in range(cols)]
    loop_idx = 0

    def synth_col(col: int, row: int, cat: str, kind: str):
        if cat == "Drums":
            drum_col = {0: 0, 1: 1, 2: 2, 7: 2}.get(col, min(col, 7))
            return demo.drum_loop(tempo, row, drum_col, brightness)
        if cat == "Bass":
            return demo.bass_loop(tempo, row, detune, brightness)
        return demo.melodic_loop(tempo, row, min(col, 5), detune, brightness)

    for col in range(cols):
        if col >= len(COL_SLOTS):
            break
        cat, kind, _query = COL_SLOTS[col]
        col_cells: list[dict] = []
        for row in range(rows):
            row_letter = ROW_NAMES[row]
            name = f"{kind} {row_letter}{col + 1}"
            file_name = f"{safe_seg(kind)}_{row_letter}{col + 1}.wav"
            rel_path = f"{SLUG}/{cat}/loop/{kind}/{safe_seg(name)}/{file_name}"
            wav_path = base / cat / "loop" / kind / safe_seg(name) / file_name
            left, right = synth_col(col, row, cat, kind)
            demo.write_wav_stereo(wav_path, left, right)
            lid = str(loop_idx)
            loop = make_loop_entry(lid, col, row, cat, kind, name, file_name, rel_path)
            loops.append(loop)
            col_cells.append(
                {
                    "gain": {"dB": "0"},
                    "loopId": lid,
                    "trigger": {"type": "loop", "syncTo": "bar"},
                }
            )
            loop_idx += 1
        channels[col] = col_cells

    return {
        "lights": [],
        "loops": loops,
        "session": {
            "channels": channels,
            "tempo": tempo,
            "timingSample": None,
            "title": "Freesound Loops (stub — run build without --stub for Freesound WAVs)",
            "patternLength": PATTERN_LENGTH,
        },
    }


def write_license(credits: list[dict], *, remote: bool = False) -> None:
    lines = [
        "# Freesound samples — license record",
        "",
    ]
    if remote:
        lines += [
            "Pack uses **remote preview URLs** from [Freesound](https://freesound.org/) "
            "(`preview-hq-mp3` / `preview-hq-ogg` in each `loop.url`). Built with "
            "`python3 scripts/build_freesound_pack.py --remote-urls`.",
            "",
            "Previews are **compressed** (not original WAV). The browser fetches them directly; "
            "host must allow CORS (`Access-Control-Allow-Origin: *` on Freesound previews).",
            "",
            "Only **Creative Commons 0** sounds are selected.",
            "",
            "## Credits",
            "",
        ]
        for c in credits:
            lines.append(
                f"- **{c['pad']}** — [{c['name']}](https://freesound.org/sounds/{c['freesound_id']}/) "
                f"by {c['username']} ({c['license']}) — `{c['preview_url']}`"
            )
    else:
        lines += [
            "Samples were downloaded from [Freesound](https://freesound.org/) using",
            "`scripts/build_freesound_pack.py`. Only **Creative Commons 0** (public domain)",
            "sounds are selected. **WAV** originals only (no MP3/OGG previews).",
            "",
            "You must comply with Freesound’s terms when re-downloading or substituting sounds.",
            "",
            "## Credits",
            "",
        ]
        for c in credits:
            lines.append(
                f"- **{c['pad']}** — [{c['name']}](https://freesound.org/sounds/{c['freesound_id']}/) "
                f"by {c['username']} ({c['license']}, {c['duration_sec']}s)"
            )
    lines.append("")
    (SOUNDLIB / "FREESOUND-SAMPLES-LICENSE.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build freesound-loops pack from Freesound API")
    ap.add_argument(
        "--stub",
        action="store_true",
        help="Synthesized placeholder WAVs (no API); fixes missing soundlib/freesound-loops/pack.json",
    )
    ap.add_argument(
        "--remote-urls",
        action="store_true",
        help="Write pack.json with full https:// Freesound preview URLs (MP3/OGG); needs FREESOUND_API_KEY only",
    )
    ap.add_argument("--cols", type=int, default=8, help="Session columns (max 8)")
    ap.add_argument("--rows", type=int, default=4, help="Clip rows A–… (max 6)")
    args = ap.parse_args()
    cols = max(1, min(8, args.cols))
    rows = max(1, min(6, args.rows))

    if args.stub:
        print(f"Building {SLUG} stub ({cols}×{rows} synthesized loops)…")
        pack = build_stub_pack(cols=cols, rows=rows)
        out = SOUNDLIB / SLUG / "pack.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(pack, indent=2), encoding="utf-8")
        write_catalog()
        stub_note = (
            "# Freesound samples — license record\n\n"
            "**Stub pack** — loops are synthesized placeholders from "
            "`python3 scripts/build_freesound_pack.py --stub`.\n\n"
            "Replace with real Freesound WAVs: set API credentials and run without `--stub`.\n"
        )
        (SOUNDLIB / "FREESOUND-SAMPLES-LICENSE.md").write_text(stub_note, encoding="utf-8")
        print(f"Wrote {len(pack['loops'])} loops → {out}")
        print("Reload the app (Local soundlib → Freesound Loops).")
        return

    token = os.environ.get("FREESOUND_API_KEY", "").strip()
    if not token:
        print("Set FREESOUND_API_KEY (https://freesound.org/apiv2/apply/)", file=sys.stderr)
        sys.exit(1)

    if args.remote_urls:
        print(f"Building {SLUG_REMOTE} ({cols}×{rows}, remote preview URLs, CC0 only)…")
        used: set[int] = set()
        pack, credits = build_pack_remote_urls(
            token=token, cols=cols, rows=rows, used_ids=used
        )
        if not pack["loops"]:
            print("No loops with preview URLs — check API key and filters.", file=sys.stderr)
            sys.exit(1)
        out = SOUNDLIB / SLUG_REMOTE / "pack.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(pack, indent=2), encoding="utf-8")
        write_catalog(remote=True)
        write_license(credits, remote=True)
        print(f"Wrote {len(pack['loops'])} loops → {out}")
        print(f"Wrote {SOUNDLIB / 'catalog.freesound-remote.json'}")
        print("Load: Custom URL → …/soundlib/freesound-remote/pack.json (or catalog.freesound-remote.json)")
        return

    bearer = os.environ.get("FREESOUND_ACCESS_TOKEN", "").strip()
    if not bearer:
        print(
            "Set FREESOUND_ACCESS_TOKEN for WAV download (OAuth2).\n"
            "Run: python3 scripts/freesound_oauth_token.py",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Building {SLUG} ({cols}×{rows} loops, WAV ≤{MAX_DURATION_SEC}s, CC0 only)…")
    used: set[int] = set()
    pack, credits = build_pack(token=token, bearer=bearer, cols=cols, rows=rows, used_ids=used)
    if not pack["loops"]:
        print("No loops downloaded — check API credentials and filters.", file=sys.stderr)
        sys.exit(1)

    out = SOUNDLIB / SLUG / "pack.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(pack, indent=2), encoding="utf-8")
    write_catalog()
    write_license(credits, remote=False)
    print(f"Wrote {len(pack['loops'])} loops → {out}")
    print(f"Wrote {SOUNDLIB / 'catalog.freesound.json'}")
    print(f"Wrote {SOUNDLIB / 'FREESOUND-SAMPLES-LICENSE.md'}")
    print("Add to js/config.js SAMPLE_PACKS: { slug: 'freesound-loops', title: 'Freesound Loops (WAV ≤8s)' }")


if __name__ == "__main__":
    main()
