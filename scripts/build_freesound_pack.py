#!/usr/bin/env python3
"""
Build a Launchpad-style pack from Freesound loops (WAV only, duration ≤ 8 s).

Requirements:
  - Search: FREESOUND_API_KEY (Token from https://freesound.org/apiv2/apply/) and/or
    FREESOUND_ACCESS_TOKEN (OAuth Bearer — can be used for search if no API key)
  - WAV download: FREESOUND_ACCESS_TOKEN (OAuth2)
    Obtain once: python3 scripts/freesound_oauth_token.py
    (OAuth callback http://127.0.0.1:8766/callback — not 8765 where server.py runs)

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


def api_request(path: str, *, token: str = "", bearer: str | None = None) -> bytes:
    url = path if path.startswith("http") else f"{API_BASE}{path}"
    if bearer:
        auth = f"Bearer {bearer}"
    elif token:
        auth = f"Token {token}"
    else:
        raise RuntimeError("Need FREESOUND_API_KEY and/or FREESOUND_ACCESS_TOKEN")
    req = urllib.request.Request(url, headers={"Authorization": auth, "User-Agent": "session-pad-grid-freesound/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        hint = ""
        if e.code == 401:
            hint = (
                " — check FREESOUND_API_KEY (Token from apiv2/apply) "
                "or FREESOUND_ACCESS_TOKEN (OAuth Bearer); do not swap them."
            )
        raise RuntimeError(f"API {path}: HTTP {e.code}{hint}\n{err_body}".strip()) from e


def _search_auth_works(*, token: str, bearer: str | None) -> bool:
    try:
        api_request("/search/text/?query=test&page_size=1", token=token, bearer=bearer)
        return True
    except RuntimeError:
        return False


def resolve_search_credentials(api_key: str, access_token: str) -> tuple[str, str | None]:
    """
    Pick credentials for /search/text/.
    Prefer Token API key; if it returns 401 and OAuth token is set, fall back to Bearer.
    """
    if api_key and _search_auth_works(token=api_key, bearer=None):
        return api_key, None
    if api_key and access_token:
        print(
            "FREESOUND_API_KEY rejected (Invalid token). Using FREESOUND_ACCESS_TOKEN for search.",
            file=sys.stderr,
        )
        print(
            "  Either unset FREESOUND_API_KEY or set it to the Api key from "
            "https://freesound.org/apiv2/apply/ (not client id/secret).",
            file=sys.stderr,
        )
        if _search_auth_works(token="", bearer=access_token):
            return "", access_token
    if access_token and _search_auth_works(token="", bearer=access_token):
        return "", access_token
    if api_key and not access_token:
        raise RuntimeError(
            "FREESOUND_API_KEY is invalid. Get the Api key from https://freesound.org/apiv2/apply/ "
            "or run scripts/freesound_oauth_token.py and set FREESOUND_ACCESS_TOKEN."
        )
    raise RuntimeError(
        "FREESOUND_ACCESS_TOKEN is invalid or expired (OAuth tokens last ~24h). "
        "Run: python3 scripts/freesound_oauth_token.py"
    )


def search_loops(
    token: str,
    query: str,
    *,
    wav_only: bool,
    page_size: int = 15,
    bearer: str | None = None,
) -> list[dict]:
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
    raw = api_request(f"/search/text/?{qs}", token=token, bearer=bearer)
    data = json.loads(raw.decode("utf-8"))
    return list(data.get("results") or [])


def search_loop_wav(
    token: str,
    query: str,
    page_size: int = 15,
    *,
    bearer: str | None = None,
) -> list[dict]:
    return search_loops(token, query, wav_only=True, page_size=page_size, bearer=bearer)


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


def _float_to_int16(f: float) -> int:
    f = max(-1.0, min(1.0, f))
    return int(f * 32767.0)


def _int24_le_to_int16(b0: int, b1: int, b2: int) -> int:
    v = b0 | (b1 << 8) | (b2 << 16)
    if v & 0x800000:
        v -= 1 << 24
    return max(-32768, min(32767, v >> 8))


def _read_pcm24_samples(data: bytes, *, channels: int, block_align: int) -> list[int]:
    """24-bit PCM: 3 bytes/sample, or 4 bytes/sample when block-aligned with padding."""
    bytes_per_sample = block_align // channels if block_align >= channels else 3
    if bytes_per_sample <= 3:
        if len(data) % 3 != 0:
            raise RuntimeError(f"24-bit PCM data length {len(data)} not multiple of 3")
        out: list[int] = []
        for i in range(0, len(data), 3):
            out.append(_int24_le_to_int16(data[i], data[i + 1], data[i + 2]))
        return out
    if len(data) % 4 != 0:
        raise RuntimeError(f"24-bit PCM (padded) data length {len(data)} not multiple of 4")
    return [max(-32768, min(32767, struct.unpack_from("<i", data, i)[0] >> 8)) for i in range(0, len(data), 4)]


def _read_wav_samples(path: Path) -> tuple[int, int, list[int]]:
    """Read WAV as interleaved int16 samples (PCM 8/16/24/32-bit, IEEE float 32-bit)."""
    buf = path.read_bytes()
    if len(buf) < 12 or buf[:4] != b"RIFF" or buf[8:12] != b"WAVE":
        raise RuntimeError(f"{path}: not a RIFF WAVE file")
    pos = 12
    fmt: bytes | None = None
    data: bytes | None = None
    while pos + 8 <= len(buf):
        chunk_id = buf[pos : pos + 4]
        chunk_size = struct.unpack_from("<I", buf, pos + 4)[0]
        chunk_start = pos + 8
        chunk_end = chunk_start + chunk_size
        if chunk_end > len(buf):
            break
        if chunk_id == b"fmt ":
            fmt = buf[chunk_start:chunk_end]
        elif chunk_id == b"data":
            data = buf[chunk_start:chunk_end]
        pos = chunk_end + (chunk_size % 2)
    if not fmt or not data:
        raise RuntimeError(f"{path}: missing fmt or data chunk")
    if len(fmt) < 16:
        raise RuntimeError(f"{path}: fmt chunk too short")
    w_format = struct.unpack_from("<H", fmt, 0)[0]
    channels = struct.unpack_from("<H", fmt, 2)[0]
    rate = struct.unpack_from("<I", fmt, 4)[0]
    bits = struct.unpack_from("<H", fmt, 14)[0]
    block_align = struct.unpack_from("<H", fmt, 12)[0] if len(fmt) >= 14 else 0
    if channels < 1 or channels > 2:
        raise RuntimeError(f"{path}: expected mono or stereo, got {channels} channels")

    if w_format == 1:  # PCM
        if bits == 16:
            samples = list(struct.unpack(f"<{len(data) // 2}h", data))
        elif bits == 8:
            u8 = struct.unpack(f"<{len(data)}B", data)
            samples = [(s - 128) * 256 for s in u8]
        elif bits == 24:
            samples = _read_pcm24_samples(data, channels=channels, block_align=block_align)
        elif bits == 32:
            samples = [
                max(-32768, min(32767, struct.unpack_from("<i", data, i)[0] >> 16))
                for i in range(0, len(data), 4)
            ]
        else:
            raise RuntimeError(f"{path}: unsupported PCM {bits}-bit")
    elif w_format == 3:  # IEEE float
        if bits != 32:
            raise RuntimeError(f"{path}: unsupported float WAV {bits}-bit")
        floats = struct.unpack(f"<{len(data) // 4}f", data)
        samples = [_float_to_int16(f) for f in floats]
    else:
        raise RuntimeError(f"{path}: unsupported WAV format tag {w_format} (need PCM or IEEE float)")

    return rate, channels, samples


def _write_pcm16_stereo_wav(path: Path, rate: int, interleaved: list[int]) -> None:
    tmp = path.with_suffix(".tmp.wav")
    with wave.open(str(tmp), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(struct.pack(f"<{len(interleaved)}h", *interleaved))
    tmp.replace(path)


def ensure_stereo_wav(path: Path) -> None:
    """Normalize to 16-bit PCM stereo (mono duplicated) for the web player."""
    try:
        with wave.open(str(path), "rb") as wf:
            if wf.getnchannels() >= 2 and wf.getsampwidth() == 2:
                return
            rate = wf.getframerate()
            n = wf.getnframes()
            ch = wf.getnchannels()
            sw = wf.getsampwidth()
            frames = wf.readframes(n)
        if sw != 2:
            raise wave.Error("non-16-bit")
        samples = list(struct.unpack(f"<{len(frames) // 2}h", frames))
        if ch == 1:
            stereo = []
            for s in samples:
                stereo.extend((s, s))
            _write_pcm16_stereo_wav(path, rate, stereo)
        return
    except wave.Error:
        pass

    rate, channels, samples = _read_wav_samples(path)
    if channels >= 2:
        if channels != 2:
            raise RuntimeError(f"{path}: only mono/stereo supported")
        stereo = samples
    else:
        stereo = []
        for s in samples:
            stereo.extend((s, s))
    _write_pcm16_stereo_wav(path, rate, stereo)


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
    search_bearer: str | None,
    download_bearer: str,
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
            results = search_loop_wav(token, f"{query} {row_letter}", bearer=search_bearer)
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
            download_sound_wav(sid, wav_path, token=token, bearer=download_bearer)

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
    bearer: str | None,
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
            results = search_loops(token, f"{query} {row_letter}", wav_only=False, bearer=bearer)
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

    api_key = os.environ.get("FREESOUND_API_KEY", "").strip()
    bearer = os.environ.get("FREESOUND_ACCESS_TOKEN", "").strip()
    if not api_key and not bearer:
        print(
            "Set FREESOUND_API_KEY (https://freesound.org/apiv2/apply/) and/or "
            "FREESOUND_ACCESS_TOKEN (python3 scripts/freesound_oauth_token.py)",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        search_token, search_bearer = resolve_search_credentials(api_key, bearer)
    except RuntimeError as e:
        print(e, file=sys.stderr)
        sys.exit(1)

    if args.remote_urls:
        print(f"Building {SLUG_REMOTE} ({cols}×{rows}, remote preview URLs, CC0 only)…")
        used: set[int] = set()
        pack, credits = build_pack_remote_urls(
            token=search_token, bearer=search_bearer, cols=cols, rows=rows, used_ids=used
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

    if not bearer:
        print(
            "Set FREESOUND_ACCESS_TOKEN for WAV download (OAuth2).\n"
            "Run: python3 scripts/freesound_oauth_token.py",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Building {SLUG} ({cols}×{rows} loops, WAV ≤{MAX_DURATION_SEC}s, CC0 only)…")
    used: set[int] = set()
    pack, credits = build_pack(
        token=search_token,
        search_bearer=search_bearer,
        download_bearer=bearer,
        cols=cols,
        rows=rows,
        used_ids=used,
    )
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
