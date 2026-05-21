#!/usr/bin/env python3
"""
Build Novation Arcade catalog.json manifests from intro.novationmusic.com.

Usage (from repo root):
  python3 scripts/generate_novation_catalog.py

Writes:
  soundlib/catalog.novation.json          — local soundlib/ after download_soundlib.py
  soundlib/catalog.novation-proxy.json    — python3 server.py + Custom URL (/novation/ proxy)
  soundlib/catalog.novation-cdn.json      — full https://intro.novationmusic.com/ pack.json URLs
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOUNDLIB = ROOT / "soundlib"
ORIGIN = "https://intro.novationmusic.com"

sys.path.insert(0, str(ROOT))
from download_soundlib import discover_slugs, fetch  # noqa: E402


def pack_title(slug: str) -> str:
    url = f"{ORIGIN}/packs/{slug}/pack.json"
    pack = json.loads(fetch(url).decode("utf-8"))
    return str(pack.get("session", {}).get("title") or slug).strip()


def main() -> None:
    slugs = discover_slugs()
    packs = []
    for slug in slugs:
        title = pack_title(slug)
        print(f"  {slug}: {title}", file=sys.stderr)
        packs.append({"slug": slug, "title": title})
    packs.sort(key=lambda p: p["title"].lower())

    local = {
        "title": "Novation Launchpad Arcade (local soundlib)",
        "packs": packs,
    }
    (SOUNDLIB / "catalog.novation.json").write_text(
        json.dumps(local, indent=2) + "\n",
        encoding="utf-8",
    )

    proxy = {
        "title": "Novation Launchpad Arcade (local proxy via server.py)",
        "packs": [
            {
                "slug": p["slug"],
                "title": p["title"],
                "pack": f"/novation/packs/{p['slug']}/pack.json",
            }
            for p in packs
        ],
    }
    (SOUNDLIB / "catalog.novation-proxy.json").write_text(
        json.dumps(proxy, indent=2) + "\n",
        encoding="utf-8",
    )

    cdn = {
        "title": "Novation Launchpad Arcade (CDN — needs CORS or download locally)",
        "packs": [
            {
                "slug": p["slug"],
                "title": p["title"],
                "url": f"{ORIGIN}/packs/{p['slug']}/pack.json",
            }
            for p in packs
        ],
    }
    (SOUNDLIB / "catalog.novation-cdn.json").write_text(
        json.dumps(cdn, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Wrote {len(packs)} packs to soundlib/catalog.novation*.json", file=sys.stderr)


if __name__ == "__main__":
    main()
