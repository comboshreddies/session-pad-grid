#!/usr/bin/env python3
"""
Generate two original demo Launchpad-style packs (synthesized WAV + pack.json).
Safe to commit: no Novation assets. Re-run: python3 scripts/generate_demo_packs.py

All demo WAVs are stereo (2 ch) so per-clip L/R pan in the app affects separate channels.

Packs:
  demo-pulse — bright electro pulse (120 BPM)
  demo-echo   — similar palette, darker filter (118 BPM)
"""

from __future__ import annotations

import json
import math
import re
import struct
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "soundlib"
SAMPLE_RATE = 44100
PATTERN_LENGTH = 16
COLS = 8
ROWS = 6  # clip rows A–F visible without scroll

PACKS = [
    {
        "slug": "demo-pulse",
        "title": "Demo Pulse (original)",
        "tempo": 120,
        "brightness": 1.0,
        "detune": 0.0,
    },
    {
        "slug": "demo-echo",
        "title": "Demo Echo (original)",
        "tempo": 118,
        "brightness": 0.82,
        "detune": 0.03,
    },
]

# Slot layout: (category, type, kind) per column 0–7
COL_META = [
    ("Drums", "loop", "Kick"),
    ("Drums", "loop", "Snare"),
    ("Bass", "loop", "Sub"),
    ("Melodic", "loop", "Chords"),
    ("Melodic", "loop", "Lead"),
    ("Melodic", "loop", "Pad"),
    ("FX", "oneshot", "Rise"),
    ("FX", "oneshot", "Hit"),
]

ROW_NAMES = ["A", "B", "C", "D", "E", "F"]


def safe_seg(s: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", s.strip())
    return re.sub(r"\s+", "_", s) or "slot"


def bar_duration_sec(tempo: float) -> float:
    return (60.0 / tempo) * 4.0


def write_wav_stereo(path: Path, left: list[float], right: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = len(left)
    if len(right) != n:
        raise ValueError("stereo channels must be the same length")
    peak = max(
        max((abs(s) for s in left), default=0.0),
        max((abs(s) for s in right), default=0.0),
        1e-9,
    )
    scale = 0.92 / peak
    frames = bytearray()
    for i in range(n):
        frames += struct.pack(
            "<h", int(max(-32767, min(32767, left[i] * scale * 32767)))
        )
        frames += struct.pack(
            "<h", int(max(-32767, min(32767, right[i] * scale * 32767)))
        )
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(frames)


def stereo_equal(mono: list[float]) -> tuple[list[float], list[float]]:
    return (list(mono), list(mono))


def stereo_width(
    mono: list[float], width: float = 0.4, delay_ms: float = 3.5
) -> tuple[list[float], list[float]]:
    """Centered stereo image: L dry, R delayed/weaker copy."""
    n = len(mono)
    d = max(1, int(delay_ms * 0.001 * SAMPLE_RATE))
    w = max(0.0, min(1.0, width))
    left = list(mono)
    right = [0.0] * n
    dry = 1.0 - w * 0.45
    wet = w * 0.45
    for i in range(n):
        right[i] = mono[i] * dry
        if i >= d:
            right[i] += mono[i - d] * wet
    return (left, right)


def hard_pan_stereo(mono: list[float], pan: float) -> tuple[list[float], list[float]]:
    """Equal-power pan baked into the file: pan -1..1 (L..R)."""
    pan = max(-1.0, min(1.0, pan))
    angle = (pan + 1.0) * math.pi / 4.0
    lg = math.cos(angle)
    rg = math.sin(angle)
    return ([s * lg for s in mono], [s * rg for s in mono])


def sample_count(duration_sec: float) -> int:
    return max(1, int(duration_sec * SAMPLE_RATE))


def sine(freq: float, phase: float, n: int) -> list[float]:
    out = []
    for i in range(n):
        t = i / SAMPLE_RATE
        out.append(math.sin(2 * math.pi * freq * t + phase))
    return out


def mix(*tracks: list[float]) -> list[float]:
    n = max(len(t) for t in tracks)
    out = [0.0] * n
    for t in tracks:
        for i, v in enumerate(t):
            out[i] += v
    return out


def env_adsr(n: int, a: float, d: float, s: float, r: float) -> list[float]:
    a_n = int(a * SAMPLE_RATE)
    d_n = int(d * SAMPLE_RATE)
    r_n = int(r * SAMPLE_RATE)
    out = []
    for i in range(n):
        if i < a_n:
            out.append(i / max(1, a_n))
        elif i < a_n + d_n:
            out.append(1.0 - (1.0 - s) * ((i - a_n) / max(1, d_n)))
        elif i < n - r_n:
            out.append(s)
        else:
            out.append(s * (n - i) / max(1, r_n))
    return out


def apply_env(samples: list[float], env: list[float]) -> list[float]:
    return [s * env[i] for i, s in enumerate(samples)]


def noise(n: int, seed: int = 0) -> list[float]:
    x = seed & 0xFFFFFFFF
    out = []
    for _ in range(n):
        x = (x * 1664525 + 1013904223) & 0xFFFFFFFF
        out.append((x / 0xFFFFFFFF) * 2.0 - 1.0)
    return out


def kick_hit(tempo: float, brightness: float) -> list[float]:
    n = sample_count(0.35)
    out = [0.0] * n
    for i in range(n):
        t = i / SAMPLE_RATE
        f = 90 + 140 * math.exp(-t * 18)
        out[i] = math.sin(2 * math.pi * f * t) * math.exp(-t * 10) * brightness
    return out


def snare_hit(brightness: float) -> list[float]:
    n = sample_count(0.18)
    nrm = noise(n, 42)
    env = env_adsr(n, 0.001, 0.04, 0.2, 0.12)
    tone = sine(180, 0, n)
    return [brightness * (nrm[i] * 0.55 + tone[i] * 0.25) * env[i] for i in range(n)]


def hat_tick(brightness: float) -> list[float]:
    n = sample_count(0.05)
    nrm = noise(n, 7)
    env = env_adsr(n, 0.001, 0.01, 0.0, 0.038)
    return [brightness * nrm[i] * env[i] * 0.4 for i in range(n)]


def drum_loop(
    tempo: float, row: int, col: int, brightness: float
) -> tuple[list[float], list[float]]:
    bar = bar_duration_sec(tempo)
    n = sample_count(bar)
    out = [0.0] * n
    step = bar / 16
    is_kick_col = col == 0
    for step_i in range(16):
        pos = int(step_i * step * SAMPLE_RATE)
        if is_kick_col:
            if step_i % 4 == 0:
                hit = kick_hit(tempo, brightness)
                for j, v in enumerate(hit):
                    if pos + j < n:
                        out[pos + j] += v
        else:
            if step_i % 4 == 2:
                hit = snare_hit(brightness)
                for j, v in enumerate(hit):
                    if pos + j < n:
                        out[pos + j] += v
            if step_i % 2 == 1:
                hit = hat_tick(brightness)
                for j, v in enumerate(hit):
                    if pos + j < n:
                        out[pos + j] += v * (0.7 + 0.1 * row)
    # Kick/snare columns stay centered; other columns get a fixed L/R bias per column/row.
    if col == 0:
        return stereo_equal(out)
    if col == 1:
        return stereo_equal(out)
    pan = ((col - 3.5) / 3.5) * 0.55 + (row - 2.5) * 0.08
    return hard_pan_stereo(out, pan)


def bass_loop(
    tempo: float, row: int, detune: float, brightness: float
) -> tuple[list[float], list[float]]:
    bar = bar_duration_sec(tempo)
    n = sample_count(bar)
    scale = [55, 55, 65.4, 55, 73.4, 65.4, 55, 49]
    freq = scale[row % len(scale)] * (1 + detune)
    raw_l = sine(freq, 0, n)
    raw_r = sine(freq * (1.0 + detune * 1.5 + 0.004), 0.15, n)
    raw2 = sine(freq * 2, 0.3, n)
    env = env_adsr(n, 0.02, 0.1, 0.75, 0.15)
    left = [brightness * 0.55 * (raw_l[i] * 0.7 + raw2[i] * 0.2) * env[i] for i in range(n)]
    right = [brightness * 0.55 * (raw_r[i] * 0.7 + raw2[i] * 0.18) * env[i] for i in range(n)]
    return (left, right)


def melodic_loop(
    tempo: float, row: int, col: int, detune: float, brightness: float
) -> tuple[list[float], list[float]]:
    bar = bar_duration_sec(tempo)
    n = sample_count(bar)
    chords = [
        [261.6, 329.6, 392.0],
        [293.7, 369.9, 440.0],
        [329.6, 415.3, 493.9],
        [349.2, 440.0, 523.3],
    ]
    ch = chords[(row + col) % len(chords)]
    out = [0.0] * n
    for fi, f in enumerate(ch):
        phase = fi * 0.4
        layer = sine(f * (1 + detune), phase, n)
        env = env_adsr(n, 0.05, 0.2, 0.55, 0.25)
        gain = 0.22 * brightness * (0.9 if col == 3 else 0.65 if col == 4 else 0.45)
        for i in range(n):
            out[i] += layer[i] * env[i] * gain
    width = 0.28 + 0.1 * col + 0.04 * row
    return stereo_width(out, width=width, delay_ms=2.5 + col * 0.4)


def fx_oneshot(
    kind: str, brightness: float, row: int = 0
) -> tuple[list[float], list[float]]:
    if kind == "Rise":
        n = sample_count(0.45)
        out = []
        for i in range(n):
            t = i / SAMPLE_RATE
            f = 200 + 800 * (t / 0.45)
            out.append(math.sin(2 * math.pi * f * t) * t * brightness * 0.35)
        env = env_adsr(n, 0.01, 0.1, 0.8, 0.2)
        mono = apply_env(out, env)
        left, right = [], []
        for i, s in enumerate(mono):
            t = i / max(1, n - 1)
            lg = math.cos((1.0 - t) * math.pi / 2.0)
            rg = math.sin(t * math.pi / 2.0)
            left.append(s * lg)
            right.append(s * rg)
        return (left, right)
    n = sample_count(0.25)
    nrm = noise(n, 99)
    env = env_adsr(n, 0.001, 0.05, 0.0, 0.18)
    mono = [brightness * nrm[i] * env[i] * 0.5 for i in range(n)]
    pan = (row / max(1, ROWS - 1)) * 2.0 - 1.0
    return hard_pan_stereo(mono, pan * 0.75)


def synth_for_slot(
    tempo: float,
    col: int,
    row: int,
    cat: str,
    typ: str,
    kind: str,
    brightness: float,
    detune: float,
) -> tuple[list[float], list[float]]:
    if cat == "Drums":
        return drum_loop(tempo, row, col, brightness)
    if cat == "Bass":
        return bass_loop(tempo, row, detune, brightness)
    if cat == "Melodic":
        return melodic_loop(tempo, row, col, detune, brightness)
    return fx_oneshot(kind, brightness, row)


def make_loop(
    loop_id: str,
    slug: str,
    col: int,
    row: int,
    cat: str,
    typ: str,
    kind: str,
    name: str,
    file_name: str,
    rel_url: str,
) -> dict:
    trigger = {"type": typ}
    if typ == "loop":
        trigger["syncTo"] = "bar"
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
                "trigger": trigger,
            },
        },
        "type": typ,
        "lightIndex": None,
    }


def build_pack(spec: dict) -> None:
    slug = spec["slug"]
    tempo = spec["tempo"]
    brightness = spec["brightness"]
    detune = spec["detune"]
    base = ROOT / slug
    loops = []
    channels: list[list[dict]] = [[] for _ in range(COLS)]

    loop_idx = 0
    for col in range(COLS):
        cat, typ, kind = COL_META[col]
        col_channels: list[dict] = []
        for row in range(ROWS):
            lid = str(loop_idx)
            name = f"{kind} {ROW_NAMES[row]}{col + 1}"
            file_name = f"{safe_seg(kind)}_{ROW_NAMES[row]}{col + 1}.wav"
            rel_path = f"{slug}/{cat}/{typ}/{kind}/{safe_seg(name)}/{file_name}"
            wav_path = base / cat / typ / kind / safe_seg(name) / file_name

            left, right = synth_for_slot(
                tempo, col, row, cat, typ, kind, brightness, detune
            )
            write_wav_stereo(wav_path, left, right)

            loop = make_loop(lid, slug, col, row, cat, typ, kind, name, file_name, rel_path)
            loops.append(loop)
            slot = {
                "gain": {"dB": "0"},
                "loopId": lid,
                "trigger": dict(loop["padData"]["pad"]["trigger"]),
            }
            col_channels.append(slot)
            loop_idx += 1
        channels[col] = col_channels

    pack = {
        "lights": [],
        "loops": loops,
        "session": {
            "channels": channels,
            "tempo": tempo,
            "timingSample": None,
            "title": spec["title"],
            "patternLength": PATTERN_LENGTH,
        },
    }
    out = base / "pack.json"
    out.write_text(json.dumps(pack, indent=2), encoding="utf-8")
    print(f"Wrote {slug}: {len(loops)} loops → {out}")


def main() -> None:
    for spec in PACKS:
        build_pack(spec)
    print("Done. Add slugs to SAMPLE_PACKS in js/config.js if not already present.")


if __name__ == "__main__":
    main()
