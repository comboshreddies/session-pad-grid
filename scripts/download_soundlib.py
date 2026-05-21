#!/usr/bin/env python3
"""
Download Novation Arcade pack.json + WAVs into ./soundlib/<slug>/ with layout:

  soundlib/<slug>/<category>/<type>/<kind>/<name>/<original.wav>
  soundlib/<slug>/<category>/<type>/<kind>/<name>/<stem>.json   # full loop object from pack.json

Then writes soundlib/<slug>/pack.json with loop.url rewritten for local paths
(ASSET_BASE /soundlib/ in app.js).

Usage (from repo root):
  python3 scripts/download_soundlib.py viral-hiphop    # one pack
  python3 scripts/download_soundlib.py all             # every pack (slugs from Novation /js/bundle.js)
  python3 scripts/download_soundlib.py discover        # print slugs only, no download
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ORIGIN = "https://intro.novationmusic.com"
BUNDLE_URL = f"{ORIGIN}/js/bundle.js"
# Fallback if `bundle.js` cannot be fetched (regex must match how Arcade builds pack URLs).
FALLBACK_SLUGS = (
    "viral-hiphop",
    "future-house-fusion",
    "retro-grain",
    "hypnotic-energy",
    "nick-hook",
    "analogue-jewels",
    "wonk-pop",
    "harry-coade",
    "clap-trap",
    "hazy-beat",
    "sugar-vape",
    "high-roller",
    "kaskobi-nytrix",
)
ROOT = Path(__file__).resolve().parent.parent / "soundlib"
_SLUG_RE = re.compile(r"packs/([a-z0-9-]+)/pack")


def safe_seg(value: object, max_len: int = 96) -> str:
    s = str(value).strip() if value is not None else ""
    if not s:
        return "unknown"
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", s)
    s = re.sub(r"\s+", "_", s)
    s = s.strip("._") or "unknown"
    return s[:max_len]


def quote_url_path(rel: str) -> str:
    rel = rel.lstrip("/")
    parts = [urllib.parse.quote(seg, safe="") for seg in rel.split("/") if seg != ""]
    return f"{ORIGIN}/" + "/".join(parts)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "session-pad-grid-download_soundlib/1.0"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def discover_slugs() -> list[str]:
    """Slugs for all Arcade packs referenced in Novation's current bundle.js."""
    print(f"Discovering pack slugs from {BUNDLE_URL}", file=sys.stderr)
    try:
        text = fetch(BUNDLE_URL).decode("utf-8", errors="replace")
    except (urllib.error.URLError, OSError) as e:
        print(f"  (warn) could not fetch bundle: {e}; using built-in slug list", file=sys.stderr)
        return list(FALLBACK_SLUGS)
    found = sorted(set(_SLUG_RE.findall(text)))
    if not found:
        print("  (warn) no packs/* slugs in bundle; using built-in slug list", file=sys.stderr)
        return list(FALLBACK_SLUGS)
    return found


def download_pack(slug: str) -> None:
    pack_url = f"{ORIGIN}/packs/{slug}/pack.json"
    print(f"Fetching {pack_url}")
    pack = json.loads(fetch(pack_url).decode("utf-8"))
    base = ROOT / slug
    base.mkdir(parents=True, exist_ok=True)

    used_dirs: dict[tuple[str, str, str, str], int] = {}

    for loop in pack.get("loops", []):
        rel = (loop.get("url") or "").strip().lstrip("/")
        if not rel:
            continue
        wav_name = Path(rel).name
        stem = Path(wav_name).stem

        cat = safe_seg(loop.get("category"))
        typ = safe_seg(loop.get("type"))
        kin = safe_seg(loop.get("kind"))
        name = safe_seg(loop.get("name"))
        key = (cat, typ, kin, name)
        n = used_dirs.get(key, 0)
        used_dirs[key] = n + 1
        if n > 0:
            name = f"{name}__loop_{safe_seg(loop.get('loopId', str(n)))}"

        dest_dir = base / cat / typ / kin / name
        dest_dir.mkdir(parents=True, exist_ok=True)

        wav_url = quote_url_path(rel)
        print(f"  WAV {wav_name} <- {wav_url}")
        wav_path = dest_dir / wav_name
        wav_path.write_bytes(fetch(wav_url))

        meta_path = dest_dir / f"{stem}.json"
        meta_path.write_text(json.dumps(loop, indent=2), encoding="utf-8")

        posix = f"{slug}/{cat}/{typ}/{kin}/{name}/{wav_name}"
        loop["url"] = posix.replace("//", "/")

    out_pack = base / "pack.json"
    out_pack.write_text(json.dumps(pack, indent=2), encoding="utf-8")
    print(f"Wrote {out_pack} ({len(pack.get('loops', []))} loops)")


def main() -> None:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <slug>|all|discover", file=sys.stderr)
        print("  all      — download every pack listed in Novation's Arcade bundle.js", file=sys.stderr)
        print("  discover — print those slugs (no download)", file=sys.stderr)
        print(f"  example single slug: {FALLBACK_SLUGS[0]}", file=sys.stderr)
        sys.exit(1)
    arg = sys.argv[1].strip().lower()
    if arg == "discover":
        for s in discover_slugs():
            print(s)
        return
    slugs = discover_slugs() if arg == "all" else [arg]
    ROOT.mkdir(parents=True, exist_ok=True)
    for slug in slugs:
        download_pack(slug)
    print(f"Done. Open http://127.0.0.1:8765/ with python3 server.py (loads from /soundlib/).")


if __name__ == "__main__":
    main()
