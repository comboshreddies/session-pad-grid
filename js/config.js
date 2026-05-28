/** @module config — constants, MIDI maps, palettes (no runtime state). */
/** Relative to the page URL (works on GitHub Pages project sites and local `server.py`). */
export const ASSET_LOCAL = "soundlib/";
/** Novation CDN (browser fetch may be blocked by CORS unless you use `server.py`’s `/novation/` proxy locally). */
export const ASSET_NOVATION_CDN = "https://intro.novationmusic.com/";
/** Same-origin proxy path when running `python3 server.py` (not available on static GitHub Pages). */
export const ASSET_NOVATION_PROXY = "novation/";

/** Same slugs as on https://intro.novationmusic.com/ (see scripts/download_soundlib.py discover / all). */
export const SAMPLE_PACKS = [
  { slug: "demo-pulse", title: "Demo Pulse (original)" },
  { slug: "demo-echo", title: "Demo Echo (original)" },
  /** Needs `soundlib/freesound-loops/pack.json` — run `python3 scripts/build_freesound_pack.py --stub` or full Freesound build. */
  { slug: "freesound-loops", title: "Freesound Loops (WAV ≤8s)" },
];

/**
 * Novation Launchpad Arcade slugs for **Novation (local proxy)** (`server.py` → `/novation/packs/…`).
 * Keep in sync with `soundlib/catalog.novation-proxy.json` (regenerate via `scripts/generate_novation_catalog.py`).
 */
export const NOVATION_SAMPLE_PACKS = [
  { slug: "analogue-jewels", title: "Analogue Jewels" },
  { slug: "clap-trap", title: "Clap Trap" },
  { slug: "future-house-fusion", title: "Future House Fusion" },
  { slug: "harry-coade", title: "Harry Coade // Found Sound" },
  { slug: "hazy-beat", title: "Hazy Beat" },
  { slug: "high-roller", title: "High Roller" },
  { slug: "hypnotic-energy", title: "Hypnotic Energy" },
  { slug: "kaskobi-nytrix", title: "Kaskobi // Nytrix - Stay Here Forever" },
  { slug: "nick-hook", title: "Nick Hook" },
  { slug: "retro-grain", title: "Retro Grain" },
  { slug: "sugar-vape", title: "Sugar Vape" },
  { slug: "viral-hiphop", title: "Viral Hiphop" },
  { slug: "wonk-pop", title: "Wonk Pop" },
];

/**
 * Modern map — Launchpad X / Mini MK3 / Pro MK3
 * DAW USB Session uses Ableton Live–style numbering → decode with Classic map when input name contains “DAW”.
 * Keys are Arcade positions: digit 1–8 = column (left→right), letter A–H = row index 0–7
 * (see `Ur`/`Fr` in Novation bundle). Clip loops use row indices 0…(n−1); rows 6–7 are G/H (**G** = column mute until note off + clear arm, **H** = stop column).
 */
export const LAUNCHPAD_PAD_TO_NOTE_MODERN = {
  "1A": 0, "1B": 16, "1C": 32, "1D": 48, "1E": 64, "1F": 80, "1G": 96, "1H": 112,
  "2A": 1, "2B": 17, "2C": 33, "2D": 49, "2E": 65, "2F": 81, "2G": 97, "2H": 113,
  "3A": 2, "3B": 18, "3C": 34, "3D": 50, "3E": 66, "3F": 82, "3G": 98, "3H": 114,
  "4A": 3, "4B": 19, "4C": 35, "4D": 51, "4E": 67, "4F": 83, "4G": 99, "4H": 115,
  "5A": 4, "5B": 20, "5C": 36, "5D": 52, "5E": 68, "5F": 84, "5G": 100, "5H": 116,
  "6A": 5, "6B": 21, "6C": 37, "6D": 53, "6E": 69, "6F": 85, "6G": 101, "6H": 117,
  "7A": 6, "7B": 22, "7C": 38, "7D": 54, "7E": 70, "7F": 86, "7G": 102, "7H": 118,
  "8A": 7, "8B": 23, "8C": 39, "8D": 55, "8E": 71, "8F": 87, "8G": 103, "8H": 119,
};

/**
 * Classic map — original Launchpad Mini / MK2 (Arcade `So` bridge, hardware Session).
 * Same position strings 1A–8H (column digit + row letter); different MIDI notes than modern.
 */
export const LAUNCHPAD_PAD_TO_NOTE_CLASSIC = {
  "1A": 81, "1B": 71, "1C": 61, "1D": 51, "1E": 41, "1F": 31, "1G": 21, "1H": 11,
  "2A": 82, "2B": 72, "2C": 62, "2D": 52, "2E": 42, "2F": 32, "2G": 22, "2H": 12,
  "3A": 83, "3B": 73, "3C": 63, "3D": 53, "3E": 43, "3F": 33, "3G": 23, "3H": 13,
  "4A": 84, "4B": 74, "4C": 64, "4D": 54, "4E": 44, "4F": 34, "4G": 24, "4H": 14,
  "5A": 85, "5B": 75, "5C": 65, "5D": 55, "5E": 45, "5F": 35, "5G": 25, "5H": 15,
  "6A": 86, "6B": 76, "6C": 66, "6D": 56, "6E": 46, "6F": 36, "6G": 26, "6H": 16,
  "7A": 87, "7B": 77, "7C": 67, "7D": 57, "7E": 47, "7F": 37, "7G": 27, "7H": 17,
  "8A": 88, "8B": 78, "8C": 68, "8D": 58, "8E": 48, "8F": 38, "8G": 28, "8H": 18,
};

export const noteToPadModern = Object.fromEntries(
  Object.entries(LAUNCHPAD_PAD_TO_NOTE_MODERN).map(([k, v]) => [String(v), k]),
);
export const noteToPadClassic = Object.fromEntries(
  Object.entries(LAUNCHPAD_PAD_TO_NOTE_CLASSIC).map(([k, v]) => [String(v), k]),
);

export const SYSEX_FRAMES = {
  miniMk3: [
    [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x10, 0x01, 0xf7],
    [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x00, 0x00, 0xf7],
  ],
  proMk3: [
    [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x10, 0x01, 0xf7],
    [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x00, 0x00, 0xf7],
  ],
  lpX: [
    [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x10, 0x01, 0xf7],
    [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x00, 0x00, 0xf7],
  ],
};

/** DAW off → Standalone (Novation manual: byte after 0x10 is 0, not 1). Lets the hardware Session key work again. */
export const SYSEX_STANDALONE_FRAMES = {
  miniMk3: [[0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x10, 0x00, 0xf7]],
  proMk3: [[0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x10, 0x00, 0xf7]],
  lpX: [[0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x10, 0x00, 0xf7]],
};

/**
 * Same port names + SysEx as intro.novationmusic.com/js/bundle.js (device connect path).
 * Order: [16,1] then [0,0] after model id byte (0x0C LP X, 0x0D Mini MK3, 0x0E Pro MK3).
 */
export const LAUNCHPAD_SESSION_SYSEX_STRICT = [
  {
    re: /^(LPMiniMK3\sMIDI|Launchpad\sMini\sMK3\sLPMiniMK3\sDAW\s(In|Out))$/i,
    frames: SYSEX_FRAMES.miniMk3,
  },
  {
    re: /^Launchpad\sPro\sMK3\s(LPProMK3\sDAW)|(MIDIIN3|MIDIOUT3)\s\((LPProMK3\sMIDI)\)$/i,
    frames: SYSEX_FRAMES.proMk3,
  },
  {
    re: /^(LPX\sMIDI|Launchpad\sX\sLPX\sDAW\s(In|Out))$/i,
    frames: SYSEX_FRAMES.lpX,
  },
];

/** Max Session **clip** row index (A=0 … F=5). Physical G/H are always mute/stop strip in this app — never clip slots. */
export const LAUNCHPAD_CLIP_SESSION_MAX_ROW = 5;
/** Number of visible clip rows (A–F) on Session hardware. */
export const LAUNCHPAD_CLIP_SESSION_ROW_COUNT = LAUNCHPAD_CLIP_SESSION_MAX_ROW + 1;

/** Session palette velocities (static colour, ch 1 `0x90`). Odd/even **Session** columns = blue / green idle (matches web); playing = yellow. */
export const LP_SESSION_PALETTE = {
  playing: 13,
  /** Playing clip in a column held muted on row **G** — white (LUT 3). */
  playingColumnMuted: 3,
  armed: 62,
  /** Playing clip queued for bar/beat stop — red (LUT 60), not armed orange. */
  pendingQuantizedStop: 60,
  /** Idle column 1,3,5,7 — blue (Novation palette). */
  idleOddColumn: 37,
  /** Idle column 2,4,6,8 — green (Novation palette). */
  idleEvenColumn: 21,
};

/** Row G: strip stays **red** (5); moving clock tick is **purple** (48). **`8G`** is volume-menu hold (**29** teal, not mute). */
export const LP_SESSION_G_SYNC = { lit: 5, tick: 48, col8Inert: 29 };

/** While **H8** is held: dim column-8 clip rows A–F on hardware; **37** = selected tick option (dark blue in Live palette). */
export const LP_SESSION_COL8_H8_MENU = { rowDim: 1, rowSelected: 37 };

/** Hold **8G**: row **H** shows **1/8…8/8** (dark strip); multi-select clips **1A–8F**; **H1–H8** sets per-clip volume (step/8). */
export const LP_SESSION_G7_VOLUME_MENU = {
  clipPurple: 48,
  stripDark: 1,
  stripStepApplyYellow: 13,
  stripStepQueryPurple: 48,
  /** One clip selected on **8G** menu: row **H** shows its current level (1/8…8/8). */
  stripStepCurrent: 37,
};

/** Stereo pan menu (right column row 3 / row **G**+**H** strips): L+R=8 (steps 0…8). */
export const LP_SESSION_G6_STEREO_MENU = {
  clipPurple: 48,
  stripRowG: 41,
  stripRowH: 62,
  stripStepApplyYellow: 13,
  stripStepQueryPurple: 48,
  stripStepCurrentG: 3,
  stripStepCurrentH: 3,
};

/** Distortion menu (scene row 6 / CC **39**): row **G** = drive 1…8, row **H** = OS / clip / tone. */
export const LP_SESSION_G4_DISTORTION_MENU = {
  clipPurple: 48,
  stripRowG: 5,
  stripRowH: 62,
  stripStepApplyYellow: 13,
  stripStepQueryPurple: 48,
  stripStepCurrentG: 37,
  stripH1: 3,
  stripH2: 37,
  stripH3: 21,
  /** H4 lit: soft clip (blue) vs hard clip (red) — must contrast stripRowH (62 orange). */
  stripH4Soft: 37,
  stripH4Hard: 5,
  stripTone: [41, 37, 21, 13],
};

/** Scene row 4 EQ menu: row **G** = high-pass 1…8, row **H** = low-pass 1…8 (spectrum sweep). */
export const LP_SESSION_SCENE4_EQ_MENU = {
  clipPurple: 48,
  stripRowG: 41,
  stripRowH: 21,
  /** Row G HPF step while held (orange — contrasts blue idle strip). */
  stripStepApplyOrange: 62,
  stripStepApplyYellow: 13,
  stripStepQueryPurple: 48,
  stripStepCurrentG: 37,
  stripStepCurrentH: 37,
};

/** Scene row 5 compressor menu: row **G** = threshold 1…8; **H1–H4** = ratio, **H5–H8** = makeup. */
export const LP_SESSION_SCENE5_COMP_MENU = {
  clipPurple: 48,
  stripRowG: 13,
  stripRowH: 62,
  stripStepApplyYellow: 13,
  stripStepQueryPurple: 48,
  stripStepCurrentG: 37,
  stripRatioLit: [41, 37, 21, 13],
  stripMakeupLit: [3, 37, 21, 5],
};

/** Scene row 7 delay menu: **G1–G4** time (blue), **G5–G8** feedback (red); **H1–H4** mix (purple), **H5–H8** tone (green). */
export const LP_SESSION_SCENE7_DELAY_MENU = {
  clipPurple: 48,
  stripGTime: 41,
  stripGFeedback: 5,
  stripHMix: 48,
  stripHTone: 21,
  stripStepApplyYellow: 13,
  stripStepQueryPurple: 48,
  stripTimeLit: [41, 37, 21, 13],
  stripFeedbackLit: [5, 7, 13, 21],
  stripMixLit: [48, 13, 37, 21],
  stripToneLit: [21, 37, 13, 5],
};

/** Scene row 8 reverb menu: **G1–G4** decay (blue), **G5–G8** room (green); **H1–H4** pre-delay (yellow), **H5–H8** wet (purple). */
export const LP_SESSION_SCENE8_REVERB_MENU = {
  clipPurple: 48,
  stripGDecay: 41,
  stripGRoom: 21,
  stripHPreDelay: 13,
  stripHWet: 48,
  stripStepApplyYellow: 13,
  stripStepQueryPurple: 48,
  stripDecayLit: [41, 37, 21, 13],
  stripRoomLit: [21, 37, 13, 5],
  stripPreDelayLit: [13, 37, 21, 5],
  stripWetLit: [48, 13, 37, 21],
};

/** Row **H** strip `1H`…`7H` idle — Novation RGB LUT velocity **3** (`FD FD FD`, white). **`8H`** uses `LP_SESSION_G_SYNC.col8Inert` (teal). */
export const LP_SESSION_STRIP_H_IDLE = 3;
/** Hold **1H**…**7H** as stop modifier (no stop until clip or **G** in that column). */
export const LP_SESSION_H_STOP_MODIFIER = 45;

/** localStorage prefix for this app (v0 keys migrated in `storage-migrate.js`). */
export const STORAGE_KEY_PREFIX = "session-pad-grid.";

export const LAYOUT_STORAGE_KEY = `${STORAGE_KEY_PREFIX}padLayout`;
export const GRID_FLIP_STORAGE_KEY = `${STORAGE_KEY_PREFIX}gridFlip`;
export const MIDI_INPUT_STORAGE_KEY = `${STORAGE_KEY_PREFIX}midiInputId`;
export const MIDI_SYSEX_SESSION_STORAGE_KEY = `${STORAGE_KEY_PREFIX}sendDawSessionSysex`;
export const ASSET_SOURCE_STORAGE_KEY = `${STORAGE_KEY_PREFIX}assetSource`;
export const SAMPLE_PACK_SLUG_STORAGE_KEY = `${STORAGE_KEY_PREFIX}samplePackSlug`;
export const CUSTOM_PACK_URL_STORAGE_KEY = `${STORAGE_KEY_PREFIX}customPackJsonUrl`;
export const SYNC_LOOP_TICKS_STORAGE_KEY = `${STORAGE_KEY_PREFIX}syncPurpleTicks`;

/** Right column row 3 (CC **69**): hold for stereo pan (web side panel row **C**). */
export const MINI_MK3_STEREO_PAN_CC = 69;
export const MINI_MK3_STEREO_PAN_IDLE_LED = LP_SESSION_PALETTE.armed;

/** Right column row 4 (CC **59**): hold for spectrum EQ — row **G** = HPF, row **H** = LPF (web side panel row **D**). */
export const MINI_MK3_SCENE4_EQ_CC = 59;
export const MINI_MK3_SCENE4_EQ_SCENE_IDLE_LED = LP_SESSION_PALETTE.idleOddColumn;

/** Right column row 5 (CC **49**): hold for compressor (web side panel row **E**). */
export const MINI_MK3_SCENE5_COMP_CC = 49;
export const MINI_MK3_SCENE5_COMP_SCENE_IDLE_LED = LP_SESSION_PALETTE.idleEvenColumn;

/** Right column row 7 (CC **29**): hold for delay (web side panel row **G**). */
export const MINI_MK3_SCENE7_DELAY_CC = 29;
export const MINI_MK3_SCENE7_DELAY_SCENE_IDLE_LED = LP_SESSION_PALETTE.idleOddColumn;

/** Right column row 8 (CC **19**): hold for reverb (web side panel row **H**). */
export const MINI_MK3_SCENE8_REVERB_CC = 19;
export const MINI_MK3_SCENE8_REVERB_SCENE_IDLE_LED = LP_SESSION_PALETTE.idleEvenColumn;

/** Right column row 6 (CC **39**): hold for per-clip distortion (web side panel row **F**). */
export const MINI_MK3_DISTORTION_CC = 39;
export const MINI_MK3_DISTORTION_SCENE_IDLE_LED = LP_SESSION_PALETTE.idleEvenColumn;
export const MINI_MK3_DISTORTION_IDLE_LED = MINI_MK3_DISTORTION_SCENE_IDLE_LED;

export const MINI_MK3_PANEL_RIGHT_CC = new Map([
  [99, "Logo (top row, CC)"],
  [89, "Scene launch row 1 (right column, CC)"],
  [79, "Scene launch row 2 (right column, CC)"],
  [69, "Scene launch row 3 — stereo pan (right column, CC)"],
  [59, "Scene launch row 4 — spectrum EQ (HPF row G, LPF row H, CC)"],
  [49, "Scene launch row 5 — compressor (threshold G, ratio H1–H4, makeup H5–H8, CC)"],
  [39, "Scene launch row 6 — distortion (right column, CC)"],
  [29, "Scene launch row 7 — delay (time G1–G4, feedback G5–G8, mix H1–H4, tone H5–H8, CC)"],
  [19, "Scene launch row 8 — reverb (decay G1–G4, room G5–G8, pre-delay H1–H4, wet H5–H8, CC)"],
]);

export const SESSION_CLIP_LEGEND_SWATCHES = [
  { vel: 3, fill: "#e8e8ee", border: "#b8b8c2" },
  { vel: 13, fill: "#ede205", border: "#b8a800" },
  { vel: 21, fill: "#12d018", border: "#0a8a0f" },
  { vel: 37, fill: "#1a9bff", border: "#0d5a99" },
  { vel: 41, fill: "#084878", border: "#052a47" },
  { vel: 5, fill: "#e01818", border: "#8a0a0a" },
  { vel: 48, fill: "#8b42e0", border: "#5a2a96" },
  { vel: 52, fill: "#e04da8", border: "#94306e" },
  { vel: 62, fill: "#e88810", border: "#9a5508" },
  { vel: 25, fill: "#145f28", border: "#0d3d1a" },
  { vel: 1, fill: "#121418", border: "#2a3038" },
  { vel: 57, fill: "#6a5540", border: "#3d3328" },
];

export const MINI_MK3_CLIP_KIND_LEGEND_CC = 89;
export const MINI_MK3_CLIP_TYPE_LEGEND_CC = 79;
export const MINI_MK3_CLIP_LEGEND_KIND_SCENE_IDLE_LED = LP_SESSION_PALETTE.idleOddColumn;
export const MINI_MK3_CLIP_LEGEND_TYPE_SCENE_IDLE_LED = LP_SESSION_PALETTE.idleEvenColumn;
export const MINI_MK3_ARROW_LEFT_CC = 0x5d;
export const MINI_MK3_ARROW_RIGHT_CC = 0x5e;
export const MINI_MK3_ARROW_UP_CC = 0x5b;
export const MINI_MK3_ARROW_DOWN_CC = 0x5c;
export const MINI_MK3_PACK_NAV_LED_PALETTE = 37;
