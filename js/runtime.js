/**
 * @module runtime
 * Application logic (grid, MIDI, playback). Split into js/* modules for AI-friendly boundaries.
 * @see js/ARCHITECTURE.md
 */

import {
  SAMPLE_PACKS,
  NOVATION_SAMPLE_PACKS,
  LAUNCHPAD_PAD_TO_NOTE_MODERN,
  LAUNCHPAD_PAD_TO_NOTE_CLASSIC,
  noteToPadModern,
  noteToPadClassic,
  SYSEX_FRAMES,
  SYSEX_STANDALONE_FRAMES,
  LAUNCHPAD_SESSION_SYSEX_STRICT,
  LAUNCHPAD_CLIP_SESSION_MAX_ROW,
  LAUNCHPAD_CLIP_SESSION_ROW_COUNT,
  LP_SESSION_PALETTE,
  LP_SESSION_G_SYNC,
  LP_SESSION_COL8_H8_MENU,
  LP_SESSION_G7_VOLUME_MENU,
  LP_SESSION_G6_STEREO_MENU,
  LP_SESSION_G4_DISTORTION_MENU,
  LP_SESSION_SCENE4_EQ_MENU,
  LP_SESSION_SCENE5_COMP_MENU,
  LP_SESSION_SCENE7_DELAY_MENU,
  LP_SESSION_SCENE8_REVERB_MENU,
  LP_SESSION_STRIP_H_IDLE,
  MINI_MK3_SCENE4_EQ_CC,
  MINI_MK3_SCENE4_EQ_SCENE_IDLE_LED,
  MINI_MK3_SCENE5_COMP_CC,
  MINI_MK3_SCENE5_COMP_SCENE_IDLE_LED,
  MINI_MK3_SCENE7_DELAY_CC,
  MINI_MK3_SCENE7_DELAY_SCENE_IDLE_LED,
  MINI_MK3_SCENE8_REVERB_CC,
  MINI_MK3_SCENE8_REVERB_SCENE_IDLE_LED,
  MINI_MK3_DISTORTION_CC,
  MINI_MK3_DISTORTION_SCENE_IDLE_LED,
  LP_SESSION_H_STOP_MODIFIER,
  SESSION_CLIP_LEGEND_SWATCHES,
  MINI_MK3_PANEL_RIGHT_CC,
  MINI_MK3_CLIP_KIND_LEGEND_CC,
  MINI_MK3_CLIP_TYPE_LEGEND_CC,
  MINI_MK3_STEREO_PAN_CC,
  MINI_MK3_STEREO_PAN_IDLE_LED,
  MINI_MK3_CLIP_LEGEND_KIND_SCENE_IDLE_LED,
  MINI_MK3_CLIP_LEGEND_TYPE_SCENE_IDLE_LED,
  MINI_MK3_ARROW_LEFT_CC,
  MINI_MK3_ARROW_RIGHT_CC,
  MINI_MK3_ARROW_UP_CC,
  MINI_MK3_ARROW_DOWN_CC,
  MINI_MK3_PACK_NAV_LED_PALETTE,
  LAYOUT_STORAGE_KEY,
  GRID_FLIP_STORAGE_KEY,
  MIDI_INPUT_STORAGE_KEY,
  MIDI_SYSEX_SESSION_STORAGE_KEY,
  ASSET_SOURCE_STORAGE_KEY,
  SYNC_LOOP_TICKS_STORAGE_KEY,
  CUSTOM_PACK_URL_STORAGE_KEY,
  SAMPLE_PACK_SLUG_STORAGE_KEY,
} from "./config.js";

import { store } from "./store.js";
import { dom } from "./dom.js";
import {
  getPadLayout,
  getAssetSource,
  assetBase,
  assetLoadErrorHint,
  fillAssetSourceSelect,
  syncAssetSourceRemotePanel,
  getGridFlip,
  CLIP_GRID_ROW_ORDER_PACK,
  applySessionGridFlip,
  logicalColForPadCol,
  setMidiDebugLine,
} from "./settings.js";
import { connectVoiceToMaster, ensureMasterBus } from "./playback-bus.js";
import { disconnectVoiceNodes, wireBufferSourceWithStereoPan } from "./playback-stereo.js";
import {
  attachDistortionToVoice,
  applyClipDistortionToVoice,
  defaultClipDistortionParams,
} from "./playback-distortion.js";
import {
  attachSpectrumEqToVoice,
  applyClipSpectrumEqToVoice,
  defaultClipSpectrumEqParams,
} from "./playback-spectrum-eq.js";
import {
  attachCompressorToVoice,
  applyClipCompressorToVoice,
  defaultClipCompressorParams,
} from "./playback-compressor.js";
import {
  attachDelayToVoice,
  applyClipDelayToVoice,
  defaultClipDelayParams,
} from "./playback-delay.js";
import {
  attachReverbToVoice,
  applyClipReverbToVoice,
  defaultClipReverbParams,
} from "./playback-reverb.js";
import {
  clipChannelMark,
  clipChannelModeLabel,
  wavChannelCountFromArrayBuffer,
} from "./wav-meta.js";
import {
  directoryBaseFromPackJsonUrl,
  packLoadStatusHint,
  resolvePackJsonUrl,
  slugHintFromPackJsonUrl,
} from "./pack-url.js";
import { isPackCatalogDocument, parsePackCatalog } from "./pack-catalog.js";
import {
  padEl,
  padElByPadKey,
  setPadDomActive,
  setPadArmed,
  setPadPendingOff,
  registerLedSync,
  registerColumnMutePadClassSync,
} from "./presentation.js";
import { buildVisibleSessionSlice, getSessionScrollMaxOffsetFromFull } from "./session-slice.js";
import { eachLaunchpadSessionLightOutput, framesForLaunchpadOutput } from "./midi-device.js";
import { restoreSettingsFromLocalStorage } from "./init-settings.js";


/** Hold **H8** to choose **Clock sync** via **8A…8F** (same values as the web Clock sync control). */

/** Narrow viewport / touch-first host (phone + Launchpad over Web MIDI). */
function isMobileSessionHost() {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(max-width: 900px)").matches;
  } catch {
    return false;
  }
}

/** Session grid on MK3/X/Pro uses Live-style notes (Classic map) on the DAW port. */
function usesClassicSessionNoteMap(midiPortName = "") {
  if (getPadLayout() === "classic") return true;
  if (/\bdaw\b/i.test(midiPortName)) return true;
  return false;
}

/**
 * Classic Session notes; some mobile hosts deliver a note ~16 too low for pads in columns 5–8 only
 * (e.g. raw 35 → 5F, should be 51 → 1D). The +16 correction must not run on legitimate row-E/F notes in
 * cols 5–6 (e.g. 45 → 5E, 36 → 6F) — that wrongly remapped 5E → 1C and broke E/F columns on phones.
 */
function resolveClassicSessionPadKey(note) {
  const n = Number(note);
  const direct = noteToPadClassic[String(n)] ?? null;
  if (!isMobileSessionHost() || !dom.midiSysex?.checked) return direct;
  const bumpedN = n + 16;
  const bumped = bumpedN <= 127 ? noteToPadClassic[String(bumpedN)] ?? null : null;
  const directP = direct ? parsePadKey(direct) : null;
  const bumpedP = bumped ? parsePadKey(bumped) : null;
  if (
    directP &&
    bumpedP &&
    directP.rowIdx === LAUNCHPAD_CLIP_SESSION_MAX_ROW &&
    directP.col === 4 &&
    bumpedP.rowIdx <= LAUNCHPAD_CLIP_SESSION_MAX_ROW &&
    bumpedP.col < directP.col &&
    directP.col - bumpedP.col >= 4
  ) {
    return bumped;
  }
  return direct;
}

/**
 * Phone + Session SysEx: classic Session notes on input; modern only when the byte is not in the classic map.
 * Classic and modern share 32 note numbers (e.g. 21 → 1G vs 6B) — never prefer modern when classic matches.
 */
function resolveMobileSessionPadKey(note, classicPad, modernPad) {
  const n = Number(note);
  const modernMatches =
    modernPad != null && LAUNCHPAD_PAD_TO_NOTE_MODERN[modernPad] === n;
  const classicMatches =
    classicPad != null && LAUNCHPAD_PAD_TO_NOTE_CLASSIC[classicPad] === n;
  const mp = modernPad ? parsePadKey(modernPad) : null;

  if (
    modernMatches &&
    !classicMatches &&
    mp &&
    mp.rowIdx <= LAUNCHPAD_CLIP_SESSION_MAX_ROW &&
    mp.col >= 2 &&
    mp.col < 6
  ) {
    return modernPad;
  }

  if (classicMatches) return classicPad;
  return modernPad ?? classicPad;
}

function isSessionFxStripMenuHeld() {
  return !!(
    store.g6StereoPanMenuHeld ||
    store.scene4EqMenuHeld ||
    store.scene5CompressorMenuHeld ||
    store.scene7DelayMenuHeld ||
    store.scene8ReverbMenuHeld ||
    store.g4DistortionMenuHeld ||
    store.g7VolumeMenuHeld
  );
}

/**
 * While an FX menu is held, some Android hosts decode row-G/H strip hits as clip pads
 * two columns right (+4 row letters toward the top). Do not use note +41 here — that
 * byte is shared by real clip pads (e.g. 2C) and would mute/stop instead of playing.
 */
function stripPadKeyFromMobileFxMenuMisread(padKey) {
  if (!padKey || !dom.midiSysex?.checked || !isMobileSessionHost()) return null;
  if (!isSessionFxStripMenuHeld()) return null;
  const p = parsePadKey(padKey);
  if (!p || p.col < 2 || p.rowIdx > LAUNCHPAD_CLIP_SESSION_MAX_ROW) return null;
  const sc = p.col - 2;
  const sr = p.rowIdx + 4;
  if (sc < 0 || sc > 7 || sr < 6 || sr > 7) return null;
  return padKeyFromPhysicalCell(sc, sr);
}

function portLooksLikeNovationLaunchpad(portName) {
  return /launchpad|lpmini|lppromk3|\blpx\b|novation/i.test(portName || "");
}

function sessionLightNoteForPadKey(padKey, outputName) {
  if (usesClassicSessionNoteMap(outputName) || (dom.midiSysex?.checked && isMobileSessionHost())) {
    return LAUNCHPAD_PAD_TO_NOTE_CLASSIC[padKey] ?? null;
  }
  return LAUNCHPAD_PAD_TO_NOTE_MODERN[padKey] ?? null;
}

/** Pack slot → hardware Session pad label (applies grid flip like `getLoopIdForPad`). */
function padKeyForPackCell(packCol, packSessionRow) {
  if (!store.pack) return null;
  if (packSessionRow < 0 || packSessionRow >= store.pack.nRows) return null;
  const { col, sessionRow } = applySessionGridFlip(packCol, packSessionRow, store.pack.nCols, store.pack.nRows);
  return padKeyFromPhysicalCell(col, sessionRow);
}

function padKeyForLoopId(loopId) {
  if (!store.pack || loopId == null) return null;
  const sid = String(loopId);
  for (let c = 0; c < store.pack.nCols; c += 1) {
    for (let r = 0; r < store.pack.nRows; r += 1) {
      if (String(store.pack.channels[c]?.[r]?.loopId) === sid) {
        return padKeyForPackCell(c, r);
      }
    }
  }
  return null;
}

/** When `padKeyForLoopId` fails (sparse `channels`, etc.), resolve Session pad from pack slots only. */
function anchorClipPadKeyFromChannels(loopId) {
  if (!store.pack || loopId == null) return null;
  const sid = String(loopId);
  for (let c = 0; c < store.pack.nCols; c += 1) {
    const row = store.pack.channels[c];
    if (!row) continue;
    for (let r = 0; r < store.pack.nRows; r += 1) {
      if (String(row[r]?.loopId) !== sid) continue;
      return padKeyForPackCell(c, r);
    }
  }
  return null;
}

function mapHasLoopId(map, loopId) {
  if (loopId == null) return false;
  if (map.has(loopId)) return true;
  if (map.has(String(loopId))) return true;
  const n = Number(loopId);
  if (Number.isFinite(n) && map.has(n)) return true;
  return false;
}

/** True if `padKey` is a clip cell (A–F), not the G/H utility strip. */
function isClipSessionPadKey(padKey) {
  const p = parsePadKey(padKey);
  return p != null && p.rowIdx >= 0 && p.rowIdx <= LAUNCHPAD_CLIP_SESSION_MAX_ROW;
}

/** Session clip **1A–8F** (columns **1–8**, rows **A–F**): toggled while **8G** volume menu is held. */
function isG7ClipMultiSelectSessionPadKey(padKey) {
  const p = parsePadKey(padKey);
  if (!p || p.rowIdx < 0 || p.rowIdx > LAUNCHPAD_CLIP_SESSION_MAX_ROW) return false;
  return p.rowIdx <= 5 && p.col <= 7;
}

/** Session clip **1A–8F** (rows **A–F**): dimmed / volume-query match while **8G** menu is active. */
function isG7ClipVolumeGridSessionPadKey(padKey) {
  const p = parsePadKey(padKey);
  if (!p || p.rowIdx < 0 || p.rowIdx > LAUNCHPAD_CLIP_SESSION_MAX_ROW) return false;
  return p.rowIdx <= 5;
}

/** `"odd"` for Session columns 1,3,5,7 — `"even"` for 2,4,6,8 (pad key digit). */
function sessionColParityFromPadKey(padKey) {
  const p = parsePadKey(padKey);
  if (!p) return "even";
  return (p.col + 1) % 2 === 1 ? "odd" : "even";
}

/**
 * Session column **7**, rows **A–F** (`7A`…`7F`): one-shot — full sample per trigger (no hold gate).
 * Pack data may still mark these as loops with bar sync; we **always** play them immediately as one-shots,
 * show **playing** colour only while the sample sounds, and never use the orange armed state.
 */
function isOneShotColumn7ClipPadKey(padKey) {
  const p = parsePadKey(padKey);
  if (!p || p.rowIdx < 0 || p.rowIdx > LAUNCHPAD_CLIP_SESSION_MAX_ROW) return false;
  return p.col + 1 === 7;
}

/**
 * Session column **8**, rows **A–F** (`8A`…`8F`): momentary — sound only while pad is held (pointer or MIDI note).
 * Pattern sync is off here; no bar/beat arm; release stops immediately.
 */
function isMomentaryColumn8ClipPadKey(padKey) {
  const p = parsePadKey(padKey);
  if (!p || p.rowIdx < 0 || p.rowIdx > LAUNCHPAD_CLIP_SESSION_MAX_ROW) return false;
  return p.col + 1 === 8;
}

/**
 * Session clips on columns **1–7** only (`1A`…`7F`): pattern-loop / bar quantize for loop on and off.
 * Column **8** (`8A`…`8F`) skips this — see `isMomentaryColumn8ClipPadKey` (no sync).
 */
function sessionClipPadUsesPatternSyncGrid(padKey) {
  const p = parsePadKey(padKey);
  if (!p || p.rowIdx < 0 || p.rowIdx > LAUNCHPAD_CLIP_SESSION_MAX_ROW) return false;
  return p.col < 7;
}

/** Loops on cols 1–7: always `bar` (pattern tick grid) or pack `beat`, never pack-only immediate/off. */
function effectiveLoopTriggerSync(loop, originPadKey, loopId) {
  const resolved =
    originPadKey ?? padKeyForLoopId(loopId) ?? anchorClipPadKeyFromChannels(loopId);
  const raw = getTriggerSync(loop);
  if (resolved && sessionClipPadUsesPatternSyncGrid(resolved)) {
    if (raw === "beat") return "beat";
    return "bar";
  }
  return raw || "bar";
}

/** Physical Session column index for digit `8` (strip **`8G`** = volume-menu hold, **`8H`** = Clock sync menu; column-8 clip pads are momentary-only). */
function isStripMuteStopInertAtPhysicalCol(physicalCol) {
  return physicalCol === 7;
}

/** Web + Mini MK3 right column (scene buttons, top → bottom). */
const SIDE_PANEL_KIND_ROW_IDX = 0;
const SIDE_PANEL_TYPE_ROW_IDX = 1;
const SIDE_PANEL_STEREO_ROW_IDX = 2;
/** Web side panel row **D** (4th row) — matches Launchpad scene row 4 (CC 59). */
const SIDE_PANEL_SCENE4_EQ_ROW_IDX = 3;
/** Web side panel row **E** (5th row) — matches Launchpad scene row 5 (CC 49). */
const SIDE_PANEL_SCENE5_COMP_ROW_IDX = 4;
/** Web side panel row **F** (6th row) — matches Launchpad right-column scene row 6 (CC 39). */
const SIDE_PANEL_DISTORTION_ROW_IDX = 5;
/** Web side panel row **G** (7th row) — matches Launchpad scene row 7 (CC 29). */
const SIDE_PANEL_SCENE7_DELAY_ROW_IDX = 6;
/** Web side panel row **H** (8th row) — matches Launchpad scene row 8 (CC 19). */
const SIDE_PANEL_SCENE8_REVERB_ROW_IDX = 7;

function getActiveOneShot(loopId) {
  const sid = String(loopId);
  for (const [k, v] of store.activeOneShots.entries()) {
    if (String(k) === sid) return v;
  }
  return undefined;
}

function deleteActiveOneShot(loopId) {
  const sid = String(loopId);
  for (const k of [...store.activeOneShots.keys()]) {
    if (String(k) === sid) store.activeOneShots.delete(k);
  }
}

function setActiveOneShot(loopId, payload) {
  deleteActiveOneShot(loopId);
  store.activeOneShots.set(String(loopId), payload);
}

function normalizeLoopKindKey(loop) {
  if (!loop) return "Unknown";
  const direct = String(loop.kind ?? "").trim();
  if (direct) return direct;
  /** Many Arcade `pack.json` loops omit `kind`; `category` is the next-best “kind” axis (see `scripts/scripts/download_soundlib.py`). */
  const cat = String(loop.category ?? "").trim();
  if (cat) return cat;
  const pd =
    loop.padData?.pad?.kind ??
    loop.padData?.kind ??
    loop.padData?.Pad?.Kind ??
    loop.padData?.Pad?.kind;
  if (pd != null && String(pd).trim()) return String(pd).trim();
  return "Unknown";
}

/**
 * `loop.url` after `scripts/scripts/download_soundlib.py` is like `slug/cat/type/kind/name/file.wav` (≥4 dirs before file).
 * The **type** folder is one level above **kind** — use it when JSON `type` is only the trigger (`loop`, etc.).
 */
function typeLegendKeyFromPackUrl(loop) {
  let u = String(loop?.url ?? "").trim();
  if (!u) return "";
  try {
    if (/^https?:\/\//i.test(u)) {
      u = new URL(u).pathname || "";
    }
  } catch {
    return "";
  }
  u = u.replace(/^\/+/, "");
  const segs = u.split("/").filter(Boolean);
  if (segs.length < 4) return "";
  const seg = segs[segs.length - 4];
  try {
    return decodeURIComponent(seg).trim();
  } catch {
    return String(seg).trim();
  }
}

/** Arcade `loop.type` on pads; when JSON is trigger-only, infer from URL path then other fields (avoid matching kind legend). */
function normalizeLoopTypeLegendKey(loop) {
  if (!loop) return "Unknown";
  const raw = String(loop.type ?? "").trim();
  const low = raw.toLowerCase();
  if (raw && low !== "loop" && low !== "one-shot" && low !== "oneshot") return raw;
  const fromUrl = typeLegendKeyFromPackUrl(loop);
  if (fromUrl) return fromUrl;
  const kindKey = normalizeLoopKindKey(loop);
  const cat = String(loop.category ?? "").trim();
  const kin = String(loop.kind ?? "").trim();
  const nm = String(loop.name ?? "").trim();
  if (cat && cat !== kindKey) return cat;
  if (kin && kin !== kindKey) return kin;
  if (nm && nm !== kindKey) return nm;
  if (cat) return cat;
  if (kin) return kin;
  if (nm) return nm;
  return "Unknown";
}

function rebuildClipKindLegendMaps() {
  store.clipKindLegendVelocityByKey.clear();
  if (!store.pack) return;
  const keys = new Set();
  for (let c = 0; c < store.pack.nCols; c += 1) {
    const col = store.pack.channels[c];
    if (!col) continue;
    for (let r = 0; r < store.pack.nRows; r += 1) {
      const lid = col[r]?.loopId;
      if (lid == null || String(lid).trim() === "") continue;
      const loop = store.pack.byId.get(String(lid));
      keys.add(normalizeLoopKindKey(loop));
    }
  }
  const sorted = [...keys].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const L = SESSION_CLIP_LEGEND_SWATCHES.length;
  sorted.forEach((k, i) => {
    store.clipKindLegendVelocityByKey.set(k, SESSION_CLIP_LEGEND_SWATCHES[i % L].vel);
  });
}

function rebuildClipTypeLegendMaps() {
  store.clipTypeLegendVelocityByKey.clear();
  if (!store.pack) return;
  const keys = new Set();
  for (let c = 0; c < store.pack.nCols; c += 1) {
    const col = store.pack.channels[c];
    if (!col) continue;
    for (let r = 0; r < store.pack.nRows; r += 1) {
      const lid = col[r]?.loopId;
      if (lid == null || String(lid).trim() === "") continue;
      const loop = store.pack.byId.get(String(lid));
      keys.add(normalizeLoopTypeLegendKey(loop));
    }
  }
  const sorted = [...keys].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const L = SESSION_CLIP_LEGEND_SWATCHES.length;
  sorted.forEach((k, i) => {
    store.clipTypeLegendVelocityByKey.set(k, SESSION_CLIP_LEGEND_SWATCHES[i % L].vel);
  });
}

function clipKindLegendPaletteVelocityForLoopId(loopId) {
  if (!store.pack || loopId == null) return 1;
  const loop = store.pack.byId.get(String(loopId));
  const k = normalizeLoopKindKey(loop);
  return store.clipKindLegendVelocityByKey.get(k) ?? 1;
}

function clipTypeLegendPaletteVelocityForLoopId(loopId) {
  if (!store.pack || loopId == null) return 1;
  const loop = store.pack.byId.get(String(loopId));
  const k = normalizeLoopTypeLegendKey(loop);
  return store.clipTypeLegendVelocityByKey.get(k) ?? 1;
}

function legendSwatchForPaletteVelocity(vel) {
  const v = Math.min(127, Math.max(0, vel | 0));
  for (const sw of SESSION_CLIP_LEGEND_SWATCHES) {
    if (sw.vel === v) return sw;
  }
  return SESSION_CLIP_LEGEND_SWATCHES[1];
}

function clipKindLegendSwatchForLoopId(loopId) {
  return legendSwatchForPaletteVelocity(clipKindLegendPaletteVelocityForLoopId(loopId));
}

function clipTypeLegendSwatchForLoopId(loopId) {
  return legendSwatchForPaletteVelocity(clipTypeLegendPaletteVelocityForLoopId(loopId));
}

function applyClipLegendPadStyle(el, sw) {
  el.style.setProperty("background-color", sw.fill, "important");
  el.style.setProperty("border-color", sw.border, "important");
  el.style.setProperty("color", "#0a0c12", "important");
}

function clearClipLegendPadStyle(el) {
  el.style.removeProperty("background-color");
  el.style.removeProperty("border-color");
  el.style.removeProperty("color");
}

function syncClipLegendWebStyling() {
  if (!dom.grid || !store.pack) return;
  const clipSel = "button.pad[data-loop-id]";
  const mode = store.clipKindLegendHeld ? "kind" : store.clipTypeLegendHeld ? "type" : null;
  if (mode == null) {
    dom.grid.classList.remove("clip-legend-active");
    dom.grid.removeAttribute("data-clip-legend");
    for (const el of dom.grid.querySelectorAll(clipSel)) {
      const pk = el.dataset.padKey;
      if (!pk || !isClipSessionPadKey(pk)) continue;
      el.classList.remove("clip-legend-swatch");
      clearClipLegendPadStyle(el);
    }
    return;
  }
  dom.grid.classList.add("clip-legend-active");
  dom.grid.dataset.clipLegend = mode;
  for (const el of dom.grid.querySelectorAll(clipSel)) {
    const pk = el.dataset.padKey;
    if (!pk || !isClipSessionPadKey(pk)) continue;
    const lid = getLoopIdForSessionClipPadOrScan(pk);
    el.classList.add("clip-legend-swatch");
    const sw =
      lid == null
        ? SESSION_CLIP_LEGEND_SWATCHES[10]
        : mode === "kind"
          ? clipKindLegendSwatchForLoopId(lid)
          : clipTypeLegendSwatchForLoopId(lid);
    applyClipLegendPadStyle(el, sw);
  }
}

function startClipKindLegendHold() {
  if (!store.pack) return;
  if (store.g6StereoPanMenuHeld) setG6StereoPanMenuHeld(false);
  if (store.g7VolumeMenuHeld) setG7VolumeMenuHeld(false);
  if (store.g4DistortionMenuHeld) setG4DistortionMenuHeld(false);
  if (store.scene7DelayMenuHeld) setScene7DelayMenuHeld(false);
  if (store.scene8ReverbMenuHeld) setScene8ReverbMenuHeld(false);
  if (store.scene5CompressorMenuHeld) setScene5CompressorMenuHeld(false);
  if (store.scene4EqMenuHeld) setScene4EqMenuHeld(false);
  if (store.h8ClockStripMenuHeld) setH8ClockStripMenuHeld(false);
  store.clipTypeLegendHeld = false;
  store.clipTypeLegendVelocityByKey.clear();
  store.clipKindLegendHeld = true;
  rebuildClipKindLegendMaps();
  syncClipLegendWebStyling();
  syncSidePanelLegendsWeb();
  refreshAllLaunchpadClipLeds();
  if (store.midiAccess) queueMicrotask(() => refreshLaunchpadMiniMk3PackNavLeds());
}

function endClipKindLegendHold() {
  if (!store.clipKindLegendHeld) return;
  store.clipKindLegendLatched = false;
  store.clipKindLegendHeld = false;
  store.clipKindLegendVelocityByKey.clear();
  syncClipLegendWebStyling();
  syncSidePanelLegendsWeb();
  refreshAllLaunchpadClipLeds();
  if (store.midiAccess) queueMicrotask(() => refreshLaunchpadMiniMk3PackNavLeds());
}

function startClipTypeLegendHold() {
  if (!store.pack) return;
  if (store.g6StereoPanMenuHeld) setG6StereoPanMenuHeld(false);
  if (store.g7VolumeMenuHeld) setG7VolumeMenuHeld(false);
  if (store.g4DistortionMenuHeld) setG4DistortionMenuHeld(false);
  if (store.scene7DelayMenuHeld) setScene7DelayMenuHeld(false);
  if (store.scene8ReverbMenuHeld) setScene8ReverbMenuHeld(false);
  if (store.scene4EqMenuHeld) setScene4EqMenuHeld(false);
  if (store.scene5CompressorMenuHeld) setScene5CompressorMenuHeld(false);
  if (store.h8ClockStripMenuHeld) setH8ClockStripMenuHeld(false);
  store.clipKindLegendHeld = false;
  store.clipKindLegendVelocityByKey.clear();
  store.clipTypeLegendHeld = true;
  rebuildClipTypeLegendMaps();
  syncClipLegendWebStyling();
  syncSidePanelLegendsWeb();
  refreshAllLaunchpadClipLeds();
  if (store.midiAccess) queueMicrotask(() => refreshLaunchpadMiniMk3PackNavLeds());
}

function endClipTypeLegendHold() {
  if (!store.clipTypeLegendHeld) return;
  store.clipTypeLegendLatched = false;
  store.clipTypeLegendHeld = false;
  store.clipTypeLegendVelocityByKey.clear();
  syncClipLegendWebStyling();
  syncSidePanelLegendsWeb();
  refreshAllLaunchpadClipLeds();
  if (store.midiAccess) queueMicrotask(() => refreshLaunchpadMiniMk3PackNavLeds());
}

function maybeRefreshClipLegendAfterChannelsChange() {
  if (store.clipKindLegendHeld) rebuildClipKindLegendMaps();
  if (store.clipTypeLegendHeld) rebuildClipTypeLegendMaps();
  if (store.clipKindLegendHeld || store.clipTypeLegendHeld) syncClipLegendWebStyling();
}

/** Session column 1,3,5,7 → blue idle; 2,4,6,8 → green idle; armed / playing override (web + hardware). */
function launchpadSessionPaletteForClipPadKey(padKey) {
  if (!isClipSessionPadKey(padKey)) return null;
  const p = parsePadKey(padKey);
  if (!p) return null;
  const colDigit = p.col + 1;
  const loopId = getLoopIdForSessionClipPadOrScan(padKey);
  if (store.g7VolumeMenuHeld && isG7ClipVolumeGridSessionPadKey(padKey)) {
    if (loopId != null && store.g7SelectedClipLoopIds.has(String(loopId))) return LP_SESSION_G7_VOLUME_MENU.clipPurple;
    const queryByH = store.g7VolumeStepSelection != null && store.g7SelectedClipLoopIds.size === 0;
    if (queryByH && loopId != null && getClipG7VolumeStep(loopId) === store.g7VolumeStepSelection) {
      return LP_SESSION_G7_VOLUME_MENU.clipPurple;
    }
  }
  if (store.scene7DelayMenuHeld && isG7ClipVolumeGridSessionPadKey(padKey)) {
    if (loopId != null && store.scene7SelectedClipLoopIds.has(String(loopId))) {
      return LP_SESSION_SCENE7_DELAY_MENU.clipPurple;
    }
    const p = loopId != null ? getClipDelayParams(loopId) : null;
    if (p && store.scene7SelectedClipLoopIds.size === 0) {
      if (store.scene7TimeStepSelection != null && p.timeStep === store.scene7TimeStepSelection) {
        return LP_SESSION_SCENE7_DELAY_MENU.clipPurple;
      }
      if (store.scene7FeedbackStepSelection != null && p.feedbackStep === store.scene7FeedbackStepSelection) {
        return LP_SESSION_SCENE7_DELAY_MENU.clipPurple;
      }
      if (store.scene7MixStepSelection != null && p.mixStep === store.scene7MixStepSelection) {
        return LP_SESSION_SCENE7_DELAY_MENU.clipPurple;
      }
      if (store.scene7ToneStepSelection != null && p.toneStep === store.scene7ToneStepSelection) {
        return LP_SESSION_SCENE7_DELAY_MENU.clipPurple;
      }
    }
  }
  if (store.scene8ReverbMenuHeld && isG7ClipVolumeGridSessionPadKey(padKey)) {
    if (loopId != null && store.scene8SelectedClipLoopIds.has(String(loopId))) {
      return LP_SESSION_SCENE8_REVERB_MENU.clipPurple;
    }
    const rv = loopId != null ? getClipReverbParams(loopId) : null;
    if (rv && store.scene8SelectedClipLoopIds.size === 0) {
      if (store.scene8DecayStepSelection != null && rv.decayStep === store.scene8DecayStepSelection) {
        return LP_SESSION_SCENE8_REVERB_MENU.clipPurple;
      }
      if (store.scene8RoomStepSelection != null && rv.roomStep === store.scene8RoomStepSelection) {
        return LP_SESSION_SCENE8_REVERB_MENU.clipPurple;
      }
      if (store.scene8PreDelayStepSelection != null && rv.preDelayStep === store.scene8PreDelayStepSelection) {
        return LP_SESSION_SCENE8_REVERB_MENU.clipPurple;
      }
      if (store.scene8MixStepSelection != null && rv.mixStep === store.scene8MixStepSelection) {
        return LP_SESSION_SCENE8_REVERB_MENU.clipPurple;
      }
    }
  }
  if (store.scene5CompressorMenuHeld && isG7ClipVolumeGridSessionPadKey(padKey)) {
    if (loopId != null && store.scene5SelectedClipLoopIds.has(String(loopId))) {
      return LP_SESSION_SCENE5_COMP_MENU.clipPurple;
    }
    const qThr =
      store.scene5ThresholdStepSelection != null && store.scene5SelectedClipLoopIds.size === 0;
    if (qThr && loopId != null && getClipCompressorParams(loopId).thresholdStep === store.scene5ThresholdStepSelection) {
      return LP_SESSION_SCENE5_COMP_MENU.clipPurple;
    }
  }
  if (store.scene4EqMenuHeld && isG7ClipVolumeGridSessionPadKey(padKey)) {
    if (loopId != null && store.scene4SelectedClipLoopIds.has(String(loopId))) {
      return LP_SESSION_SCENE4_EQ_MENU.clipPurple;
    }
    const qHp =
      store.scene4HighPassStepSelection != null && store.scene4SelectedClipLoopIds.size === 0;
    if (qHp && loopId != null && getClipSpectrumEqParams(loopId).highPassStep === store.scene4HighPassStepSelection) {
      return LP_SESSION_SCENE4_EQ_MENU.clipPurple;
    }
    const qLp =
      store.scene4LowPassStepSelection != null && store.scene4SelectedClipLoopIds.size === 0;
    if (qLp && loopId != null && getClipSpectrumEqParams(loopId).lowPassStep === store.scene4LowPassStepSelection) {
      return LP_SESSION_SCENE4_EQ_MENU.clipPurple;
    }
  }
  if (store.g4DistortionMenuHeld && isG7ClipVolumeGridSessionPadKey(padKey)) {
    if (loopId != null && store.g4SelectedClipLoopIds.has(String(loopId))) {
      return LP_SESSION_G4_DISTORTION_MENU.clipPurple;
    }
    const qD =
      store.g4DistortionDriveStepSelection != null && store.g4SelectedClipLoopIds.size === 0;
    if (qD && loopId != null && getClipDistortionParams(loopId).drive === store.g4DistortionDriveStepSelection) {
      return LP_SESSION_G4_DISTORTION_MENU.clipPurple;
    }
  }
  if (store.g6StereoPanMenuHeld && isG7ClipVolumeGridSessionPadKey(padKey)) {
    if (loopId != null && store.g6SelectedClipLoopIds.has(String(loopId))) {
      return LP_SESSION_G6_STEREO_MENU.clipPurple;
    }
    const q =
      store.g6StereoPanStepSelection != null &&
      store.g6StereoPanStepValue != null &&
      store.g6SelectedClipLoopIds.size === 0;
    if (q && loopId != null) {
      const r = getClipRightPanStep(loopId);
      const gStrip = getClipLeftPanStripStep(loopId);
      if (
        (store.g6StereoPanStepSelection === "right" && r === store.g6StereoPanStepValue) ||
        (store.g6StereoPanStepSelection === "left" && gStrip === store.g6StereoPanStepValue)
      ) {
        return LP_SESSION_G6_STEREO_MENU.clipPurple;
      }
    }
  }
  if (store.g6StereoPanMenuHeld && isG7ClipVolumeGridSessionPadKey(padKey)) {
    if (loopId != null && store.g6SelectedClipLoopIds.has(String(loopId))) {
      return LP_SESSION_G6_STEREO_MENU.clipPurple;
    }
    const q =
      store.g6StereoPanStepSelection != null &&
      store.g6StereoPanStepValue != null &&
      store.g6SelectedClipLoopIds.size === 0;
    if (q && loopId != null) {
      const r = getClipRightPanStep(loopId);
      const gStrip = getClipLeftPanStripStep(loopId);
      if (
        (store.g6StereoPanStepSelection === "right" && r === store.g6StereoPanStepValue) ||
        (store.g6StereoPanStepSelection === "left" && gStrip === store.g6StereoPanStepValue)
      ) {
        return LP_SESSION_G6_STEREO_MENU.clipPurple;
      }
    }
  }
  if (store.clipKindLegendHeld) {
    if (loopId == null) return 1;
    return clipKindLegendPaletteVelocityForLoopId(loopId);
  }
  if (store.clipTypeLegendHeld) {
    if (loopId == null) return 1;
    return clipTypeLegendPaletteVelocityForLoopId(loopId);
  }
  if (loopId != null && store.pendingQuantizedStopLoopIds.has(String(loopId))) {
    return LP_SESSION_PALETTE.pendingQuantizedStop;
  }
  if (clipPadKeyHasActivePlayback(padKey)) {
    if (isSessionPadKeyInMutedColumn(padKey)) return LP_SESSION_PALETTE.playingColumnMuted;
    return LP_SESSION_PALETTE.playing;
  }
  if (loopId != null && mapHasLoopId(store.pendingLoopStartTimers, loopId)) return LP_SESSION_PALETTE.armed;
  return colDigit % 2 === 1 ? LP_SESSION_PALETTE.idleOddColumn : LP_SESSION_PALETTE.idleEvenColumn;
}

function sendSessionPadLighting(padKey, paletteVelocity) {
  if (!store.midiAccess || !padKey || !isClipSessionPadKey(padKey) || paletteVelocity === null) return;
  const vel = Math.min(127, Math.max(0, paletteVelocity | 0));
  eachLaunchpadSessionLightOutput((output, name) => {
    const note = sessionLightNoteForPadKey(padKey, name);
    if (note == null) return;
    try {
      output.send(new Uint8Array([0x90, note & 0x7f, vel]));
    } catch (err) {
      console.warn("Launchpad Session pad light (Note On) failed:", name, err);
    }
  });
}

/** Session row **G** only — strip lighting (not clip A–F); purple tick is visual 8-step loop reference. */
function sendSessionPadLightingRowG(padKey, paletteVelocity) {
  const p = parsePadKey(padKey);
  if (!store.midiAccess || !padKey || !p || p.rowIdx !== 6 || paletteVelocity === null) return;
  const vel = Math.min(127, Math.max(0, paletteVelocity | 0));
  eachLaunchpadSessionLightOutput((output, name) => {
    const note = sessionLightNoteForPadKey(padKey, name);
    if (note == null) return;
    try {
      output.send(new Uint8Array([0x90, note & 0x7f, vel]));
    } catch (err) {
      console.warn("Launchpad Session G-row pad light failed:", name, err);
    }
  });
}

/** Session row **H** strip pad (e.g. `8H` inert in this app); same Note On protocol as row G. */
function sendSessionPadLightingRowH(padKey, paletteVelocity) {
  const p = parsePadKey(padKey);
  if (!store.midiAccess || !padKey || !p || p.rowIdx !== 7 || paletteVelocity === null) return;
  const vel = Math.min(127, Math.max(0, paletteVelocity | 0));
  eachLaunchpadSessionLightOutput((output, name) => {
    const note = sessionLightNoteForPadKey(padKey, name);
    if (note == null) return;
    try {
      output.send(new Uint8Array([0x90, note & 0x7f, vel]));
    } catch (err) {
      console.warn("Launchpad Session H-row pad light failed:", name, err);
    }
  });
}

/** Clip rows A–F on Session layout (not row G). Row G updates can clear pad colours on some firmware — re-send after G strip refresh. */
function refreshLaunchpadSessionClipPadsHardwareOnly() {
  if (!store.midiAccess || !store.pack) return;
  const maxRow = Math.min(store.pack.nRows - 1, LAUNCHPAD_CLIP_SESSION_MAX_ROW);
  eachLaunchpadSessionLightOutput((output, name) => {
    for (let colDigit = 1; colDigit <= 8; colDigit += 1) {
      for (let rowIdx = 0; rowIdx <= maxRow; rowIdx += 1) {
        const padKey = `${colDigit}${String.fromCharCode(65 + rowIdx)}`;
        const v = launchpadSessionPaletteForClipPadKey(padKey);
        if (v === null) continue;
        const note = sessionLightNoteForPadKey(padKey, name);
        if (note == null) continue;
        try {
          output.send(new Uint8Array([0x90, note & 0x7f, v]));
        } catch (err) {
          console.warn("Launchpad Session pad light failed:", name, err);
        }
      }
    }
  });
  if (store.g7VolumeMenuHeld) refreshLaunchpadG7HStripHardware();
  if (store.g4DistortionMenuHeld) refreshLaunchpadG4DistortionStripHardware();
}

/** Full clip grid (A–F) + row **G** bar clock (web always; hardware when MIDI connected). */
function refreshAllLaunchpadClipLeds() {
  if (!store.pack) return;
  const tick = syncClockTickDisplayColumn8();
  updateWebSyncClockRowG(tick);
  store.lastSyncClockGColumn = tick;
  if (!store.midiAccess) return;
  refreshLaunchpadSessionClipPadsHardwareOnly();
  refreshLaunchpadSyncClockRowG(tick);
  refreshLaunchpadMiniMk3PackNavLeds();
}

function syncLaunchpadLedForLoop(loopId) {
  if (!store.midiAccess || !store.pack) return;
  let pk = padKeyForLoopId(loopId);
  if (!pk) {
    const os = getActiveOneShot(loopId);
    if (os?.anchorPadKey) pk = os.anchorPadKey;
  }
  if (!pk) {
    let pl = store.activeLoops.get(loopId);
    if (!pl) pl = store.activeLoops.get(String(loopId));
    if (!pl && Number.isFinite(Number(loopId))) pl = store.activeLoops.get(Number(loopId));
    if (pl?.anchorPadKey) pk = pl.anchorPadKey;
  }
  if (!pk) return;
  const v = launchpadSessionPaletteForClipPadKey(pk);
  if (v !== null) sendSessionPadLighting(pk, v);
}

function standaloneFramesForLaunchpadOutput(name) {
  const session = framesForLaunchpadOutput(name);
  if (!session) return null;
  const dev = session[0][5];
  if (dev === 0x0d) return SYSEX_STANDALONE_FRAMES.miniMk3;
  if (dev === 0x0e) return SYSEX_STANDALONE_FRAMES.proMk3;
  if (dev === 0x0c) return SYSEX_STANDALONE_FRAMES.lpX;
  return null;
}

function portLooksLikeLaunchpadMiniMk3(portName) {
  return /\bmini\s*mk\s*3|lpminimk3/i.test(portName || "");
}

function miniMk3PanelRightCcLabel(cc) {
  return MINI_MK3_PANEL_RIGHT_CC.get(cc) ?? null;
}

/** Debounce duplicate ▲/▼ when “All inputs” binds both DAW + MIDI ports. */
let lastSessionRowScrollAt = 0;

/** Debounce duplicate clip triggers (DAW + MIDI ports often fire two Note Ons per press). */
let lastClipTriggerAtByKey = new Map();

function shouldDebounceClipTrigger(loopId, padKey) {
  const key = `${String(loopId)}:${padKey ?? ""}`;
  const now = Date.now();
  const last = lastClipTriggerAtByKey.get(key) ?? 0;
  if (now - last < 100) return true;
  lastClipTriggerAtByKey.set(key, now);
  return false;
}

function clearPendingLoopStartTimerIds(loopId) {
  const tid =
    store.pendingLoopStartTimers.get(loopId) ??
    store.pendingLoopStartTimers.get(String(loopId)) ??
    (Number.isFinite(Number(loopId)) ? store.pendingLoopStartTimers.get(Number(loopId)) : undefined);
  if (tid != null) clearTimeout(tid);
  store.pendingLoopStartTimers.delete(loopId);
  store.pendingLoopStartTimers.delete(String(loopId));
  if (Number.isFinite(Number(loopId))) store.pendingLoopStartTimers.delete(Number(loopId));
}

/**
 * Mini MK3 ◀ ▶ ▲ ▼ — CC on **DAW** or **MIDI** input (default input picker prefers MIDI).
 * @returns {boolean} handled
 */
function handleLaunchpadMiniMk3PackNavCcPress(port, d1, d2, raw) {
  if (!portLooksLikeNovationLaunchpad(port) || d2 <= 0) return false;
  if (d1 === MINI_MK3_ARROW_UP_CC || d1 === MINI_MK3_ARROW_DOWN_CC) {
    const delta = d1 === MINI_MK3_ARROW_UP_CC ? -1 : 1;
    applySessionRowScroll(delta);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      `CC ${d1} val ${d2}`,
      d1 === MINI_MK3_ARROW_UP_CC
        ? "Mini MK3 ▲ scroll session rows up"
        : "Mini MK3 ▼ scroll session rows down",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_ARROW_LEFT_CC || d1 === MINI_MK3_ARROW_RIGHT_CC) {
    const delta = d1 === MINI_MK3_ARROW_LEFT_CC ? -1 : 1;
    void (async () => {
      await ensureAudio();
      if (store.audioCtx?.state === "suspended") await store.audioCtx.resume();
      cyclePackFromHardware(delta);
    })();
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      `CC ${d1} val ${d2}`,
      d1 === MINI_MK3_ARROW_LEFT_CC ? "Mini MK3 ◀ previous sample set" : "Mini MK3 ▶ next sample set",
    ]);
    return true;
  }
  return false;
}

/** Right column rows 1–3 (CC 89 / 79 / 69): kind legend, type legend, stereo pan — any Novation Launchpad input. */
function handleLaunchpadSceneSideCcPress(port, d1, d2, raw) {
  if (!portLooksLikeNovationLaunchpad(port) || d2 <= 0) return false;
  const cc = `CC ${d1} (0x${((d1 >>> 0) & 0xff).toString(16)}) val ${d2}`;
  if (d1 === MINI_MK3_CLIP_KIND_LEGEND_CC) {
    if (store.pack) startClipKindLegendHold();
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      store.pack
        ? "Launchpad · **hold** — kind / category colours on clip pads"
        : "Launchpad · kind legend (load a sample set first)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_CLIP_TYPE_LEGEND_CC) {
    if (store.pack) startClipTypeLegendHold();
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      store.pack
        ? "Launchpad · **hold** — loop **type** colours on clip pads"
        : "Launchpad · type legend (load a sample set first)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_SCENE7_DELAY_CC) {
    if (store.pack) setScene7DelayMenuHeld(true);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      store.pack
        ? "Launchpad · **hold** — delay (row 7); G1–G4=time, G5–G8=feedback, H1–H4=mix, H5–H8=tone"
        : "Launchpad · delay (load a sample set first)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_SCENE8_REVERB_CC) {
    if (store.pack) setScene8ReverbMenuHeld(true);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      store.pack
        ? "Launchpad · **hold** — reverb (row 8); G1–G4=decay, G5–G8=room, H1–H4=pre-delay, H5–H8=wet"
        : "Launchpad · reverb (load a sample set first)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_SCENE5_COMP_CC) {
    if (store.pack) setScene5CompressorMenuHeld(true);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      store.pack
        ? "Launchpad · **hold** — compressor (row 5); G=threshold, H1–H4=ratio, H5–H8=makeup"
        : "Launchpad · compressor (load a sample set first)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_SCENE4_EQ_CC) {
    if (store.pack) setScene4EqMenuHeld(true);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      store.pack
        ? "Launchpad · **hold** — spectrum EQ (row 4); G=HPF 1…8, H=LPF 1…8, clips 1A…8F"
        : "Launchpad · spectrum EQ (load a sample set first)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_STEREO_PAN_CC) {
    if (store.pack) setG6StereoPanMenuHeld(true);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      store.pack
        ? "Launchpad · **hold** — stereo pan (right col row 3); H=right G=left"
        : "Launchpad · stereo pan (load a sample set first)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_DISTORTION_CC) {
    if (store.pack) setG4DistortionMenuHeld(true);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      store.pack
        ? "Launchpad · **hold** — distortion (row 6); G=drive 1…8, H=OS/clip/tone, clips 1A…8F"
        : "Launchpad · distortion (load a sample set first)",
    ]);
    return true;
  }
  return false;
}

function handleLaunchpadSceneSideCcRelease(port, d1, raw) {
  if (!portLooksLikeNovationLaunchpad(port)) return false;
  const cc = `CC ${d1} (0x${((d1 >>> 0) & 0xff).toString(16)}) val 0`;
  if (d1 === MINI_MK3_CLIP_KIND_LEGEND_CC && store.clipKindLegendHeld) {
    endClipKindLegendHold();
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      "Launchpad · kind legend released (grid back to normal)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_CLIP_TYPE_LEGEND_CC && store.clipTypeLegendHeld) {
    endClipTypeLegendHold();
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      "Launchpad · type legend released (grid back to normal)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_SCENE7_DELAY_CC && store.scene7DelayMenuHeld) {
    setScene7DelayMenuHeld(false);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      "Launchpad · delay released (right column row 7)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_SCENE8_REVERB_CC && store.scene8ReverbMenuHeld) {
    setScene8ReverbMenuHeld(false);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      "Launchpad · reverb released (right column row 8)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_SCENE5_COMP_CC && store.scene5CompressorMenuHeld) {
    setScene5CompressorMenuHeld(false);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      "Launchpad · compressor released (right column row 5)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_SCENE4_EQ_CC && store.scene4EqMenuHeld) {
    setScene4EqMenuHeld(false);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      "Launchpad · spectrum EQ released (right column row 4)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_STEREO_PAN_CC && store.g6StereoPanMenuHeld) {
    setG6StereoPanMenuHeld(false);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      "Launchpad · stereo pan released (right column row 3)",
    ]);
    return true;
  }
  if (d1 === MINI_MK3_DISTORTION_CC && store.g4DistortionMenuHeld) {
    setG4DistortionMenuHeld(false);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      cc,
      "Launchpad · distortion released (right column row 6)",
    ]);
    return true;
  }
  return false;
}

function buildColLabelsHtml(packState) {
  const maxScroll = packState?.sessionChannelsFull
    ? getSessionScrollMaxOffsetFromFull(packState.sessionChannelsFull)
    : 0;
  const off = packState?.sessionRowScrollOffset ?? 0;
  const corner =
    maxScroll > 0
      ? `<span class="corner pack-scroll-nav" role="group" aria-label="Clip row scroll">
      <button type="button" class="pack-scroll-btn" data-scroll-delta="-1"${off <= 0 ? " disabled" : ""} title="Previous clip rows (▲)">▲</button>
      <button type="button" class="pack-scroll-btn" data-scroll-delta="1"${off >= maxScroll ? " disabled" : ""} title="Next clip rows (▼)">▼</button>
    </span>`
      : '<span class="corner" aria-hidden="true"></span>';
  return (
    corner +
    Array.from({ length: 8 }, (_, i) => `<span>${i + 1}</span>`).join("") +
    '<span class="side-hdr" title="Right column (scene)">▸</span>'
  );
}

function wireColLabelScrollButtons() {
  if (!dom.cols) return;
  for (const btn of dom.cols.querySelectorAll("button.pack-scroll-btn")) {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const delta = Number(btn.dataset.scrollDelta);
      if (Number.isFinite(delta)) applySessionRowScroll(delta);
    });
  }
}

/** Mini MK3 ◀ ▶ sample-set + ▲ ▼ session row scroll (CC colours on DAW out). */
function refreshLaunchpadMiniMk3PackNavLeds() {
  if (!store.midiAccess) return;
  const packNavV = Math.min(127, Math.max(0, MINI_MK3_PACK_NAV_LED_PALETTE));
  const maxScroll = store.pack?.sessionChannelsFull
    ? getSessionScrollMaxOffsetFromFull(store.pack.sessionChannelsFull)
    : 0;
  const off = store.pack?.sessionRowScrollOffset ?? 0;
  const upV = maxScroll > 0 && off > 0 ? packNavV : 0;
  const downV = maxScroll > 0 && off < maxScroll ? packNavV : 0;
  eachLaunchpadSessionLightOutput((output, name) => {
    if (!portLooksLikeNovationLaunchpad(name)) return;
    try {
      output.send(new Uint8Array([0xb0, MINI_MK3_ARROW_LEFT_CC & 0x7f, packNavV]));
      output.send(new Uint8Array([0xb0, MINI_MK3_ARROW_RIGHT_CC & 0x7f, packNavV]));
      output.send(new Uint8Array([0xb0, MINI_MK3_ARROW_UP_CC & 0x7f, upV]));
      output.send(new Uint8Array([0xb0, MINI_MK3_ARROW_DOWN_CC & 0x7f, downV]));
      const kindTopLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.clipKindLegendHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_CLIP_LEGEND_KIND_SCENE_IDLE_LED;
      const typeSceneLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.clipTypeLegendHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_CLIP_LEGEND_TYPE_SCENE_IDLE_LED;
      const stereoPanLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.g6StereoPanMenuHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_STEREO_PAN_IDLE_LED;
      const distortionLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.g4DistortionMenuHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_DISTORTION_IDLE_LED;
      output.send(new Uint8Array([0xb0, MINI_MK3_CLIP_KIND_LEGEND_CC & 0x7f, kindTopLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_CLIP_TYPE_LEGEND_CC & 0x7f, typeSceneLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_STEREO_PAN_CC & 0x7f, stereoPanLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_DISTORTION_CC & 0x7f, distortionLed]));
    } catch (err) {
      console.warn("Launchpad Mini MK3 pack-nav LED (CC) failed:", name, err);
    }
  });
}

/** Load the sample set for `slug` — remote catalog uses each entry’s pack.json URL (same as web Sample set). */
function applyPackSelection(slug) {
  if (getAssetSource() === "remote") {
    const entry = store.remoteCatalogEntries?.find((e) => e.slug === slug);
    if (!entry) return Promise.resolve();
    setRemotePackUiStatus("loading", `Loading “${entry.title}”…`);
    return applyPackFromUrl(entry.packJsonUrl);
  }
  return applyPack(slug);
}

function cyclePackFromHardware(delta) {
  if (!dom.pack || dom.pack.options.length === 0) return;
  let i = dom.pack.selectedIndex;
  if (i < 0) i = 0;
  const n = dom.pack.options.length;
  const next = (i + delta + n) % n;
  const opt = dom.pack.options[next];
  const slug = opt?.value;
  if (slug == null || slug === "") return;
  dom.pack.value = slug;
  applyPackSelection(slug).catch((e) => {
    const hint = getAssetSource() === "remote" ? remotePackFetchErrorHint(e) : assetLoadErrorHint();
    if (getAssetSource() === "remote") {
      setRemotePackUiStatus("error", `✗ ${e.message ?? e}${hint}`);
    }
    dom.midi.textContent = `Load error: ${e.message ?? e}.${hint}`;
  });
}


/** Prefer a single Launchpad *input*. Defaults to a **MIDI**-named port when both exist (Custom / User traffic lives there on Mini MK3). For **hardware Session**, pick **DAW** in the menu — Novation routes Session grid there; see status line after connect. */
function pickPreferredMidiInputId() {
  if (!store.midiAccess) return "";
  const inputs = [...store.midiAccess.inputs.values()];
  if (inputs.length === 0) return "";
  if (dom.midiSysex?.checked) {
    const daw = inputs.filter((i) => /\bdaw\b/i.test(i.name || ""));
    if (daw.length > 0) return daw[0].id;
    const lp = inputs.find((i) => portLooksLikeNovationLaunchpad(i.name || ""));
    if (lp) return lp.id;
    return inputs[0].id;
  }
  const nonDaw = inputs.filter((i) => !/\bdaw\b/i.test(i.name || ""));
  if (nonDaw.length > 0) {
    const withMidi = nonDaw.find((i) => /\bmidi\b/i.test(i.name || ""));
    if (withMidi) return withMidi.id;
    const lp = nonDaw.find((i) => portLooksLikeNovationLaunchpad(i.name || ""));
    if (lp) return lp.id;
    return nonDaw[0].id;
  }
  return inputs[0].id;
}

function populateMidiInputSelect() {
  if (!dom.midiInput || !store.midiAccess) return;
  let saved = "";
  try {
    saved = localStorage.getItem(MIDI_INPUT_STORAGE_KEY) ?? "";
  } catch {
    /* ignore */
  }
  dom.midiInput.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "__all__";
  optAll.textContent = "All inputs (only if one pad triggers twice — then pick one port above)";
  dom.midiInput.appendChild(optAll);
  const ids = new Set();
  for (const input of store.midiAccess.inputs.values()) {
    ids.add(input.id);
    const o = document.createElement("option");
    o.value = input.id;
    o.textContent = input.name || input.id;
    dom.midiInput.appendChild(o);
  }
  if (saved === "__all__" && !(dom.midiSysex?.checked && isMobileSessionHost())) {
    dom.midiInput.value = "__all__";
  } else if (saved && saved !== "__all__" && ids.has(saved)) {
    dom.midiInput.value = saved;
  } else {
    const pref = pickPreferredMidiInputId();
    dom.midiInput.value = pref && ids.has(pref) ? pref : [...ids][0] ?? "__all__";
  }
}

function bindMidiInputs() {
  if (!store.midiAccess) return;
  store.boundMidiInputSummary = "";
  for (const input of store.midiAccess.inputs.values()) {
    input.onmidimessage = null;
  }
  const sel = dom.midiInput?.value;
  if (sel === "__all__") {
    for (const input of store.midiAccess.inputs.values()) {
      input.onmidimessage = handleMidiMessage;
    }
    store.boundMidiInputSummary = `ALL (${store.midiAccess.inputs.size} ports)`;
    return;
  }
  const id =
    sel && sel !== "" && store.midiAccess.inputs.has(sel) ? sel : pickPreferredMidiInputId();
  let input = id ? store.midiAccess.inputs.get(id) : null;
  if (!input && store.midiAccess.inputs.size > 0) {
    input = [...store.midiAccess.inputs.values()][0];
    store.boundMidiInputSummary = `${input.name || input.id} (fallback — pick MIDI input manually)`;
    input.onmidimessage = handleMidiMessage;
    return;
  }
  if (input) {
    input.onmidimessage = handleMidiMessage;
    store.boundMidiInputSummary = input.name || input.id;
  }
}


function bumpOneShotPlayGeneration(loopId) {
  if (loopId == null) return;
  const sid = String(loopId);
  store.oneShotPlayGenerationByLoopId.set(sid, (store.oneShotPlayGenerationByLoopId.get(sid) ?? 0) + 1);
}

function clearOneShotPlayGenerations() {
  store.oneShotPlayGenerationByLoopId.clear();
}

/** True if this Session clip pad has audible playback (maps or `anchorPadKey` on active nodes). */
function clipPadKeyHasActivePlayback(padKey) {
  if (!padKey || !store.pack) return false;
  const loopId = getLoopIdForPad(padKey);
  if (loopId != null && (mapHasLoopId(store.activeLoops, loopId) || mapHasLoopId(store.activeOneShots, loopId))) return true;
  for (const os of store.activeOneShots.values()) {
    if (os?.anchorPadKey === padKey) return true;
  }
  for (const pl of store.activeLoops.values()) {
    if (pl?.anchorPadKey === padKey) return true;
  }
  return false;
}

/** All `loopId`s tied to pack column `logicalCol` (channel slots + active loops / one-shots in that column). */
function collectLoopIdsForPackColumn(logicalCol) {
  const ids = new Set();
  if (!store.pack || logicalCol < 0) return ids;
  const colSlots = store.pack.channels[logicalCol];
  if (colSlots) {
    for (let r = 0; r < store.pack.nRows; r += 1) {
      const lid = colSlots[r]?.loopId;
      if (lid != null) ids.add(String(lid));
    }
  }
  for (const id of store.activeLoops.keys()) {
    if (packColumnIndexForLoopId(id) === logicalCol) ids.add(String(id));
  }
  for (const id of store.activeOneShots.keys()) {
    if (packColumnIndexForLoopId(id) === logicalCol) ids.add(String(id));
  }
  return ids;
}

/**
 * Loop ids for clips that **appear** on this physical Session column (strip digit), regardless of
 * pack `channels` index. Strips G/H are keyed by physical column; merging this set fixes stop/mute
 * when pack-column bookkeeping and `packColumnIndexForLoopId` disagree (e.g. row flip edge cases).
 */
function collectLoopIdsForPhysicalSessionColumn(physicalCol) {
  const ids = new Set();
  if (!store.pack || physicalCol == null || physicalCol < 0) return ids;
  for (const [id, pl] of store.activeLoops.entries()) {
    const anchor = pl?.anchorPadKey;
    if (!anchor) continue;
    const ap = parsePadKey(anchor);
    if (ap && ap.col === physicalCol) ids.add(String(id));
  }
  for (const [id, os] of store.activeOneShots.entries()) {
    const anchor = os?.anchorPadKey;
    if (!anchor) continue;
    const ap = parsePadKey(anchor);
    if (ap && ap.col === physicalCol) ids.add(String(id));
  }
  for (let pc = 0; pc < store.pack.nCols; pc += 1) {
    for (let r = 0; r < store.pack.nRows; r += 1) {
      const pk = padKeyForPackCell(pc, r);
      if (pk == null) continue;
      const p = parsePadKey(pk);
      if (!p || p.col !== physicalCol) continue;
      const lid = store.pack.channels[pc][r]?.loopId;
      if (lid != null) ids.add(String(lid));
    }
  }
  for (const id of store.activeLoops.keys()) {
    const pk = padKeyForLoopId(id);
    if (pk == null) continue;
    const p = parsePadKey(pk);
    if (p && p.col === physicalCol) ids.add(String(id));
  }
  for (const id of store.activeOneShots.keys()) {
    const pk = padKeyForLoopId(id);
    if (pk == null) continue;
    const p = parsePadKey(pk);
    if (p && p.col === physicalCol) ids.add(String(id));
  }
  return ids;
}

function collectLoopIdsForStripActions(logicalCol, physicalCol) {
  const ids = collectLoopIdsForPackColumn(logicalCol);
  if (physicalCol != null && physicalCol >= 0) {
    for (const sid of collectLoopIdsForPhysicalSessionColumn(physicalCol)) {
      ids.add(sid);
    }
  }
  return ids;
}

function stopColumnLoops(logicalCol, physicalCol) {
  if (!store.pack) return;
  store.mutedColumns.delete(logicalCol);
  if (physicalCol != null && physicalCol >= 0) store.mutedPhysicalSessionCols.delete(physicalCol);
  if (physicalCol != null && physicalCol >= 0) {
    stopClipPlaybackForPhysicalSessionColumn(physicalCol);
  }
  for (const sid of collectLoopIdsForStripActions(logicalCol, physicalCol)) {
    stopLoop(sid);
  }
  if (physicalCol != null && physicalCol >= 0) {
    sweepStopAllVoicesOnPhysicalSessionColumn(physicalCol);
  }
}

function isHStopModifierHeldForPhysicalCol(physicalCol) {
  return physicalCol != null && physicalCol >= 0 && store.hStopModifierPhysicalCols.has(physicalCol);
}

function applyHStopModifierWebClasses() {
  if (!dom.grid) return;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    if (pad.dataset.h8ClockMenuStrip === "true") continue;
    const dc = Number(pad.dataset.displayCol);
    pad.classList.toggle(
      "h-stop-modifier-held",
      Number.isFinite(dc) && store.hStopModifierPhysicalCols.has(dc),
    );
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]')) {
    if (pad.dataset.g8VolumeHoldStrip === "true") continue;
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (!nm || !Number.isFinite(dc)) continue;
    const stopCol = store.hStopModifierPhysicalCols.has(dc);
    pad.classList.toggle("g-stop-col-active", stopCol);
    // Pan/volume menus own row-G labels (L1…L8 / mute col); do not overwrite after H-strip pointerup.
    if (
      store.g6StereoPanMenuHeld ||
      store.g7VolumeMenuHeld ||
      store.g4DistortionMenuHeld ||
      store.scene4EqMenuHeld ||
      store.scene5CompressorMenuHeld ||
      store.scene7DelayMenuHeld ||
      store.scene8ReverbMenuHeld
    ) {
      continue;
    }
    const defaultNm = pad.dataset.stripGNmDefault ?? "mute col";
    nm.textContent = stopCol ? "stop col" : defaultNm;
  }
}

function clearHStopModifierPhysicalCols() {
  if (store.hStopModifierPhysicalCols.size === 0) return;
  store.hStopModifierPhysicalCols.clear();
  applyHStopModifierWebClasses();
  if (
    store.midiAccess &&
    !store.g7VolumeMenuHeld &&
    !store.g6StereoPanMenuHeld &&
    !store.g4DistortionMenuHeld &&
    !store.scene4EqMenuHeld &&
    !store.scene5CompressorMenuHeld &&
    !store.scene7DelayMenuHeld &&
    !store.scene8ReverbMenuHeld
  ) {
    queueMicrotask(() => refreshLaunchpadStripRowHIdleHardware());
  }
}

function setHStopModifierHeld(physicalCol, on) {
  if (physicalCol == null || physicalCol < 0 || physicalCol > 6) return;
  if (on) store.hStopModifierPhysicalCols.add(physicalCol);
  else store.hStopModifierPhysicalCols.delete(physicalCol);
  applyHStopModifierWebClasses();
  if (store.midiAccess && !store.g7VolumeMenuHeld && !store.g6StereoPanMenuHeld) {
    queueMicrotask(() => refreshLaunchpadStripRowHIdleHardware());
  }
}





function packColumnIndexForLoopId(loopId) {
  if (!store.pack) return null;
  const sid = String(loopId);
  for (let c = 0; c < store.pack.nCols; c += 1) {
    for (let r = 0; r < store.pack.nRows; r += 1) {
      if (String(store.pack.channels[c]?.[r]?.loopId) === sid) return c;
    }
  }
  return null;
}

/** Row G — per-column mute: gain duck to 0 while held, restore on release (all clip columns including 7 one-shots). H strip stops playback. */
function voiceBelongsToPhysicalSessionColumn(loopId, physicalCol) {
  if (physicalCol == null || physicalCol < 0 || !store.pack) return false;
  const os = getActiveOneShot(loopId);
  if (os?.anchorPadKey) {
    const p = parsePadKey(os.anchorPadKey);
    if (p && p.col === physicalCol) return true;
  }
  let pl = store.activeLoops.get(loopId);
  if (!pl) pl = store.activeLoops.get(String(loopId));
  if (!pl && Number.isFinite(Number(loopId))) pl = store.activeLoops.get(Number(loopId));
  if (pl?.anchorPadKey) {
    const p = parsePadKey(pl.anchorPadKey);
    if (p && p.col === physicalCol) return true;
  }
  const pk = padKeyForLoopId(loopId);
  if (pk) {
    const p = parsePadKey(pk);
    if (p && p.col === physicalCol) return true;
  }
  const sid = String(loopId);
  for (let pc = 0; pc < store.pack.nCols; pc += 1) {
    const row = store.pack.channels[pc];
    if (!row) continue;
    for (let r = 0; r < store.pack.nRows; r += 1) {
      if (String(row[r]?.loopId) !== sid) continue;
      const cellPk = padKeyForPackCell(pc, r);
      const cp = cellPk ? parsePadKey(cellPk) : null;
      if (cp && cp.col === physicalCol) return true;
    }
  }
  return false;
}

function applyStripMuteDuckToSid(sid, muted) {
  let playing = store.activeLoops.get(sid);
  if (!playing && Number.isFinite(Number(sid))) playing = store.activeLoops.get(Number(sid));
  if (!playing) playing = store.activeLoops.get(String(sid));
  const oneShot = getActiveOneShot(sid);
  for (const node of [playing, oneShot]) {
    if (!node) continue;
    if (muted) {
      if (node.premuteGain == null) {
        node.premuteGain = node.gain.gain.value;
      }
      node.gain.gain.value = 0;
    } else if (node.premuteGain != null) {
      node.gain.gain.value = node.premuteGain;
      node.premuteGain = undefined;
    }
  }
}

function sweepStripMuteDuckPhysicalColumnExtras(physicalCol, muted, coveredIds) {
  if (physicalCol == null || physicalCol < 0 || !store.pack) return;
  const covered = new Set([...coveredIds].map(String));
  const extras = new Set();
  for (const id of store.activeOneShots.keys()) {
    const s = String(id);
    if (covered.has(s)) continue;
    if (voiceBelongsToPhysicalSessionColumn(id, physicalCol)) extras.add(s);
  }
  for (const id of store.activeLoops.keys()) {
    const s = String(id);
    if (covered.has(s)) continue;
    if (voiceBelongsToPhysicalSessionColumn(id, physicalCol)) extras.add(s);
  }
  for (const sid of extras) {
    applyStripMuteDuckToSid(sid, muted);
  }
}

function sweepStopAllVoicesOnPhysicalSessionColumn(physicalCol) {
  if (physicalCol == null || physicalCol < 0 || !store.pack) return;
  const toStop = new Set();
  for (const id of store.activeOneShots.keys()) {
    if (voiceBelongsToPhysicalSessionColumn(id, physicalCol)) toStop.add(String(id));
  }
  for (const id of store.activeLoops.keys()) {
    if (voiceBelongsToPhysicalSessionColumn(id, physicalCol)) toStop.add(String(id));
  }
  for (const sid of toStop) {
    stopLoop(sid);
  }
}

function isSessionPadKeyInMutedColumn(padKey) {
  const p = parsePadKey(padKey);
  if (!p || !store.pack) return false;
  if (store.mutedPhysicalSessionCols.has(p.col)) return true;
  const logicalCol = logicalColForPadCol(p.col, store.pack.nCols);
  return store.mutedColumns.has(logicalCol);
}

function applyColumnMuteWebPadForLoop(loopId) {
  const el = padEl(loopId);
  if (!el) return;
  const pk = el.dataset.padKey;
  const mutedCol = pk != null && isSessionPadKeyInMutedColumn(pk);
  el.classList.toggle(
    "column-muted-playback",
    mutedCol && el.classList.contains("active") && !el.classList.contains("pending-off"),
  );
}

function applyColumnMuteWebPadClasses() {
  if (!dom.grid) return;
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (lid != null) applyColumnMuteWebPadForLoop(lid);
  }
}

function refreshColumnMuteVisuals() {
  applyColumnMuteWebPadClasses();
  if (store.midiAccess) queueMicrotask(() => refreshLaunchpadSessionClipPadsHardwareOnly());
}





function applyColumnMuteGains(logicalCol, muted, physicalCol) {
  if (!store.pack || logicalCol < 0) return;
  const ids = collectLoopIdsForStripActions(logicalCol, physicalCol);
  for (const sid of ids) {
    applyStripMuteDuckToSid(sid, muted);
  }
  sweepStripMuteDuckPhysicalColumnExtras(physicalCol, muted, ids);
}

function clearPendingArmsInPhysicalSessionColumn(physicalCol) {
  if (!store.pack || physicalCol == null || physicalCol < 0) return;
  for (let pc = 0; pc < store.pack.nCols; pc += 1) {
    for (let r = 0; r < store.pack.nRows; r += 1) {
      const pk = padKeyForPackCell(pc, r);
      if (pk == null) continue;
      const p = parsePadKey(pk);
      if (!p || p.col !== physicalCol) continue;
      const loopId = store.pack.channels[pc][r]?.loopId;
      if (loopId == null) continue;
      const tid =
        store.pendingLoopStartTimers.get(loopId) ??
        store.pendingLoopStartTimers.get(String(loopId)) ??
        (Number.isFinite(Number(loopId)) ? store.pendingLoopStartTimers.get(Number(loopId)) : undefined);
      if (tid == null) continue;
      clearTimeout(tid);
      store.pendingLoopStartTimers.delete(loopId);
      store.pendingLoopStartTimers.delete(String(loopId));
      if (Number.isFinite(Number(loopId))) store.pendingLoopStartTimers.delete(Number(loopId));
      setPadArmed(loopId, false);
    }
  }
}

function muteColumnOn(logicalCol, physicalCol) {
  if (!store.pack) return;
  clearPendingArmsInColumn(logicalCol);
  if (physicalCol != null) clearPendingArmsInPhysicalSessionColumn(physicalCol);
  store.mutedColumns.add(logicalCol);
  if (physicalCol != null && physicalCol >= 0) store.mutedPhysicalSessionCols.add(physicalCol);
  applyColumnMuteGains(logicalCol, true, physicalCol);
  refreshColumnMuteVisuals();
}

function muteColumnOff(logicalCol, physicalCol) {
  if (!store.pack) return;
  store.mutedColumns.delete(logicalCol);
  if (physicalCol != null && physicalCol >= 0) store.mutedPhysicalSessionCols.delete(physicalCol);
  applyColumnMuteGains(logicalCol, false, physicalCol);
  refreshColumnMuteVisuals();
}

function toggleMuteColumnGStrip(logicalCol, physicalCol) {
  if (!store.pack) return;
  clearPendingArmsInColumn(logicalCol);
  if (physicalCol != null) clearPendingArmsInPhysicalSessionColumn(physicalCol);
  if (store.mutedColumns.has(logicalCol)) muteColumnOff(logicalCol, physicalCol);
  else muteColumnOn(logicalCol, physicalCol);
}

/** Audio-time origin for bar/beat grid (reset when changing pack). */

function ensureTransportOrigin(ctx) {
  if (Number.isFinite(store.transportOriginAudioSec)) return;
  const now = ctx.currentTime;
  if (store.pack != null && Number.isFinite(store.audioBarClockOriginSec)) {
    const loopDur = patternLoopDurationSeconds(store.pack.tempo, store.pack.patternLength);
    if (loopDur > 0 && Number.isFinite(loopDur)) {
      const phase = ((now - store.audioBarClockOriginSec) % loopDur + loopDur) % loopDur;
      if (Number.isFinite(phase)) {
        const aligned = now - phase;
        if (Number.isFinite(aligned)) {
          store.transportOriginAudioSec = aligned;
          return;
        }
      }
    }
  }
  store.transportOriginAudioSec = now;
}


function getTriggerSync(loop) {
  return loop?.padData?.pad?.trigger?.syncTo ?? null;
}

function secondsPerBeat(tempo) {
  return 60 / Math.max(1, tempo);
}

/** Arcade `session.patternLength` is in sixteenth-note steps; 16 ≈ one 4/4 bar at pack tempo. */
function patternLoopDurationSeconds(tempo, patternLength) {
  const pl = Math.max(1, Math.floor(Number(patternLength)) || 16);
  const beat = secondsPerBeat(tempo);
  return (pl / 16) * 4 * beat;
}

/** Pattern-loop **Clock sync** (web + **H8**+**8A…8F**): stored value = **purple G-row ticks** per quantize step (`0` = immediate). Snap interval = loopDuration × (value ÷ 8). */
function getSyncLoopTicks() {
  return store.syncLoopTicksState;
}

/** Subdivisions for the **purple** row-G clock only (one step per `1G`…`8G`; do not tie to `getSyncLoopTicks()` or 4-tick mode skips columns). */
function getVisualClockStripTicks() {
  return 8;
}

const SYNC_LOOP_TICK_PAD_KEYS = ["8A", "8B", "8C", "8D", "8E", "8F"];
const SYNC_LOOP_TICK_VALUES = [0, 1, 2, 4, 8, 16];

/** Web pad title row while H8 menu is held (`8A`…`8F`). */
const H8_CLOCK_MENU_WEB_LABEL_BY_PAD = {
  "8A": "now",
  "8B": "1 tick",
  "8C": "2 ticks",
  "8D": "4 ticks",
  "8E": "8 ticks",
  "8F": "2 cycles",
};

function padKeyToSyncLoopTicksChoice(padKey) {
  const i = SYNC_LOOP_TICK_PAD_KEYS.indexOf(padKey);
  if (i < 0) return null;
  return SYNC_LOOP_TICK_VALUES[i];
}

function clockSyncHumanLabel(ticks) {
  const n = Number(ticks);
  if (n === 0) return "immediate";
  if (n === 1) return "1 tick per snap";
  if (n === 16) return "16 ticks (2 loops) per snap";
  return `${n} ticks per snap`;
}

function syncLoopTicksToPadKey(ticks) {
  const i = SYNC_LOOP_TICK_VALUES.indexOf(Number(ticks));
  if (i < 0) return "8D";
  return SYNC_LOOP_TICK_PAD_KEYS[i];
}

/** Apply **Clock sync** quantize grid from UI or hardware (purple G-row animation stays 8 steps per loop). */
function applySyncLoopTicksUserValue(ticks) {
  const t = Number(ticks);
  if (!SYNC_LOOP_TICK_VALUES.includes(t)) return;
  store.syncLoopTicksState = t;
  if (dom.syncLoopTicks) dom.syncLoopTicks.value = String(t);
  try {
    localStorage.setItem(SYNC_LOOP_TICKS_STORAGE_KEY, String(t));
  } catch {
    /* ignore */
  }
  store.lastSyncClockGColumn = -1;
  if (store.pack && store.audioCtx) {
    const col = syncClockTickDisplayColumn8();
    updateWebSyncClockRowG(col);
    if (store.midiAccess) refreshLaunchpadSyncClockRowG(col);
  }
  if (store.h8ClockStripMenuHeld) {
    applyH8ClockStripMenuWebClasses();
  }
}

function applyH8ClockStripMenuWebClasses() {
  if (!dom.grid) return;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-h8-clock-menu-strip="true"]')) {
    const nm = pad.querySelector(".nm");
    const def = pad.dataset.stripHNmDefault ?? "clock tick sync";
    if (nm) nm.textContent = store.h8ClockStripMenuHeld ? `${def} ·` : def;
    pad.classList.toggle("h8-clock-menu-held", store.h8ClockStripMenuHeld);
    pad.setAttribute("aria-pressed", store.h8ClockStripMenuHeld ? "true" : "false");
  }
  const sel = syncLoopTicksToPadKey(getSyncLoopTicks());
  for (const el of dom.grid.querySelectorAll("button.pad[data-h8-clock-tick-row]")) {
    const nm = el.querySelector(".nm");
    if (nm && store.h8ClockStripMenuHeld && el.dataset.clockMenuNm) {
      nm.textContent = el.dataset.clockMenuNm;
    }
    el.classList.toggle("h8-clock-menu-dim", store.h8ClockStripMenuHeld);
    el.classList.toggle("h8-clock-menu-selected", store.h8ClockStripMenuHeld && el.dataset.padKey === sel);
  }
}

function clearH8ClockStripMenuWebClasses() {
  if (!dom.grid) return;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-h8-clock-menu-strip="true"]')) {
    const nm = pad.querySelector(".nm");
    if (nm && pad.dataset.stripHNmDefault != null) nm.textContent = pad.dataset.stripHNmDefault;
    pad.classList.remove("h8-clock-menu-held");
    pad.setAttribute("aria-pressed", "false");
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-h8-clock-tick-row]")) {
    const nm = el.querySelector(".nm");
    if (nm && el.dataset.nmDefault != null) nm.textContent = el.dataset.nmDefault;
    el.classList.remove("h8-clock-menu-dim", "h8-clock-menu-selected");
  }
}

function setH8ClockStripMenuHeld(on) {
  if (!on) store.h8ClockStripMenuLatched = false;
  if (store.h8ClockStripMenuHeld === on) return;
  if (on && store.g7VolumeMenuHeld) setG7VolumeMenuHeld(false);
  if (on && store.g6StereoPanMenuHeld) setG6StereoPanMenuHeld(false);
  if (on && store.g4DistortionMenuHeld) setG4DistortionMenuHeld(false);
  if (on && store.scene4EqMenuHeld) setScene4EqMenuHeld(false);
  if (on && store.scene5CompressorMenuHeld) setScene5CompressorMenuHeld(false);
  if (on && store.scene7DelayMenuHeld) setScene7DelayMenuHeld(false);
  if (on && store.scene8ReverbMenuHeld) setScene8ReverbMenuHeld(false);
  if (on) clearHStopModifierPhysicalCols();
  store.h8ClockStripMenuHeld = on;
  if (dom.grid) dom.grid.classList.toggle("h8-clock-menu-active", on);
  if (on) {
    applyH8ClockStripMenuWebClasses();
    const col = syncClockTickDisplayColumn8();
    if (store.midiAccess) {
      refreshLaunchpadCol8ClockTickMenuOverlay();
      refreshLaunchpadSyncClockRowG(col);
    }
  } else {
    clearH8ClockStripMenuWebClasses();
    if (store.midiAccess) queueMicrotask(() => refreshAllLaunchpadClipLeds());
  }
}

function toggleH8ClockStripMenuLatch() {
  const next = !store.h8ClockStripMenuLatched;
  store.h8ClockStripMenuLatched = next;
  setH8ClockStripMenuHeld(next);
}

function releaseH8ClockStripMenuPointer() {
  if (!store.h8ClockStripMenuLatched) setH8ClockStripMenuHeld(false);
}

function getClipG7VolumeStep(loopId) {
  if (loopId == null) return 8;
  const sid = String(loopId);
  if (store.g7ClipVolumeStepByLoopId.has(sid)) return store.g7ClipVolumeStepByLoopId.get(sid);
  const n = Number(loopId);
  if (Number.isFinite(n) && store.g7ClipVolumeStepByLoopId.has(n)) return store.g7ClipVolumeStepByLoopId.get(n);
  return 8;
}

function getClipG7VolumeRatio(loopId) {
  return getClipG7VolumeStep(loopId) / 8;
}

const PAN_STEP_SUM = 8;
const PAN_STEP_DEFAULT_RIGHT = 4;

function clampPanStep(step) {
  const n = Math.floor(Number(step));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(PAN_STEP_SUM, n));
}

/** Normalize stored pan (0…8; legacy 0…7 sum-7 bumps max to 8). */
function normalizePanStepStored(step) {
  const n = Math.floor(Number(step));
  if (!Number.isFinite(n)) return PAN_STEP_DEFAULT_RIGHT;
  if (n >= 0 && n <= PAN_STEP_SUM) return n;
  return clampPanStep(n);
}

/** Map strip column 0…7 (pads **1**…**8**) to pan step **1**…**8** (L+R=8). */
function panStepFromStripCol(dc) {
  const d = Math.floor(Number(dc));
  if (!Number.isFinite(d)) return 1;
  return Math.max(1, Math.min(PAN_STEP_SUM, d + 1));
}

/** Right pan step 0…8 (default 4 = center). Left = 8 − right (L+R=8). */
function getClipRightPanStep(loopId) {
  if (loopId == null) return PAN_STEP_DEFAULT_RIGHT;
  const sid = String(loopId);
  if (store.g6ClipRightPanStepByLoopId.has(sid)) {
    return normalizePanStepStored(store.g6ClipRightPanStepByLoopId.get(sid));
  }
  const n = Number(loopId);
  if (Number.isFinite(n) && store.g6ClipRightPanStepByLoopId.has(n)) {
    return normalizePanStepStored(store.g6ClipRightPanStepByLoopId.get(n));
  }
  return PAN_STEP_DEFAULT_RIGHT;
}

function getClipLeftPanStep(loopId) {
  return PAN_STEP_SUM - getClipRightPanStep(loopId);
}

function getClipLeftPanStripStep(loopId) {
  return getClipLeftPanStep(loopId);
}

function setClipRightPanStep(loopId, rightStep) {
  const r = clampPanStep(rightStep);
  store.g6ClipRightPanStepByLoopId.set(String(loopId), r);
  if (Number.isFinite(Number(loopId))) store.g6ClipRightPanStepByLoopId.set(Number(loopId), r);
}

function setClipLeftPanStep(loopId, leftStep) {
  setClipRightPanStep(loopId, PAN_STEP_SUM - clampPanStep(leftStep));
}

/** Filled stars only: count = volume step (1…8 → ★…★★★★★★★★). */
function clipVolumeStarsForStep(step) {
  const n = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  return "★".repeat(n);
}

/** Web clip pads: lower-left row of filled stars (count = volume step). */
function refreshClipVolumeLevelBadges() {
  if (!dom.grid) return;
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    let badge = el.querySelector(".vol-lvl");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "vol-lvl";
      badge.setAttribute("aria-hidden", "true");
      el.append(badge);
    }
    badge.textContent = clipVolumeStarsForStep(getClipG7VolumeStep(lid));
  }
}

/** L/R pan bar widths for clip pad top indicator (steps 0…8, L+R=8). */
function clipPanBarFlexWeights(loopId) {
  const l = getClipLeftPanStep(loopId);
  const r = getClipRightPanStep(loopId);
  return { left: l, right: r };
}

/** Web clip pads: top bar — blue = left, amber = right (L+R=8). */
function refreshClipPanBars() {
  if (!dom.grid) return;
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    let bar = el.querySelector(".pan-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "pan-bar";
      bar.setAttribute("aria-hidden", "true");
      const segL = document.createElement("span");
      segL.className = "pan-bar-l";
      const segR = document.createElement("span");
      segR.className = "pan-bar-r";
      bar.append(segL, segR);
      el.prepend(bar);
    }
    const { left, right } = clipPanBarFlexWeights(lid);
    const segL = bar.querySelector(".pan-bar-l");
    const segR = bar.querySelector(".pan-bar-r");
    if (segL) segL.style.flex = String(Math.max(0.05, left));
    if (segR) segR.style.flex = String(Math.max(0.05, right));
    bar.title = `Pan L${getClipLeftPanStripStep(lid)} · R${getClipRightPanStep(lid)}`;
  }
}

function loopAudioCacheKey(loop) {
  const slug = store.pack?.slug ?? store.currentPackSlug ?? "";
  return `${slug}\0${loop?.url ?? ""}`;
}

function rememberLoopChannelCount(loop, ch) {
  if (!loop?.url || ch == null || !Number.isFinite(ch) || ch < 1) return;
  store.loopChannelCountByUrl.set(loopAudioCacheKey(loop), ch);
}

function getLoopChannelCount(loop) {
  if (!loop?.url) return null;
  const key = loopAudioCacheKey(loop);
  const cached = store.loopChannelCountByUrl.get(key);
  if (cached != null) return cached;
  const buf = store.bufferCache.get(key);
  if (buf) {
    rememberLoopChannelCount(loop, buf.numberOfChannels);
    return buf.numberOfChannels;
  }
  return null;
}

async function probeLoopChannelCount(loop) {
  if (!loop?.url) return null;
  const existing = getLoopChannelCount(loop);
  if (existing != null) return existing;
  const res = await fetch(absoluteUrl(loop.url), { cache: "no-store" });
  if (!res.ok) throw new Error(`wav ${res.status}`);
  const arr = await res.arrayBuffer();
  const ch = wavChannelCountFromArrayBuffer(arr);
  if (ch != null) rememberLoopChannelCount(loop, ch);
  return ch;
}

async function probeAllPackChannelCounts(packState) {
  const loops = packState?.raw?.loops;
  if (!loops?.length) return;
  await Promise.all(loops.map((l) => probeLoopChannelCount(l).catch(() => null)));
  refreshClipChannelBadges();
}

/** Wrap `.tp` + `.ch-lvl` so mono/stereo sits beside loop/oneshot (not over volume stars). */
function ensureClipTpRow(padEl) {
  let tpRow = padEl.querySelector(".tp-row");
  if (tpRow) return tpRow;
  const tp = padEl.querySelector(".tp");
  tpRow = document.createElement("div");
  tpRow.className = "tp-row";
  if (tp) {
    tp.replaceWith(tpRow);
    tpRow.append(tp);
  } else {
    const vol = padEl.querySelector(".vol-lvl");
    if (vol) padEl.insertBefore(tpRow, vol);
    else padEl.append(tpRow);
  }
  const orphan = padEl.querySelector(":scope > .ch-lvl");
  if (orphan) tpRow.append(orphan);
  return tpRow;
}

/** Web clip pads: **m** / **s** beside loop/oneshot type from WAV channel count. */
function refreshClipChannelBadges() {
  if (!dom.grid) return;
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    const loop = store.pack?.byId.get(String(lid));
    const tpRow = ensureClipTpRow(el);
    let badge = tpRow.querySelector(".ch-lvl");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ch-lvl";
      badge.setAttribute("aria-hidden", "true");
      tpRow.append(badge);
    }
    const ch = loop ? getLoopChannelCount(loop) : null;
    const mark = clipChannelMark(ch);
    badge.textContent = mark;
    badge.hidden = !mark;
    if (ch != null) {
      el.dataset.audioChannels = ch >= 2 ? "stereo" : "mono";
    } else {
      delete el.dataset.audioChannels;
    }
    const base = el.dataset.padTitleBase;
    const mode = clipChannelModeLabel(ch);
    if (base) {
      el.title = mode ? `${base} · ${mode} WAV` : base;
    }
  }
}

/** When exactly one clip is selected in the **8G** volume menu, return its `loopId`. */
function soleG7SelectedClipLoopId() {
  if (store.g7SelectedClipLoopIds.size !== 1) return null;
  return [...store.g7SelectedClipLoopIds][0];
}



/** Normalize stored pan (0…8; legacy 0…7 sum-7 bumps max to 8). */

/** Map strip column 0…7 (pads **1**…**8**) to pan step **1**…**8** (L+R=8). */

/** Right pan step 0…8 (default 4 = center). Left = 8 − right (L+R=8). */





/** Filled stars only: count = volume step (1…8 → ★…★★★★★★★★). */

/** Web clip pads: lower-left row of filled stars (count = volume step). */

/** L/R pan bar widths for clip pad top indicator (steps 0…8, L+R=8). */

/** Web clip pads: top bar — blue = left, amber = right (L+R=8). */





/** Wrap `.tp` + `.ch-lvl` so mono/stereo sits beside loop/oneshot (not over volume stars). */

/** Web clip pads: **m** / **s** beside loop/oneshot type from WAV channel count. */

/** When exactly one clip is selected in the **8G** volume menu, return its `loopId`. */

function applyVoiceGainLevels(voice, loopId, loop) {
  if (!voice?.gain || !loop) return;
  const velN = voice.gainVelNorm ?? Math.max(0.05, Math.min(1, 100 / 127));
  const targetLinear = dbToLinear(loop.gain ?? "0") * velN * getClipG7VolumeRatio(loopId);
  const l = getClipLeftPanStep(loopId) / PAN_STEP_SUM;
  const r = getClipRightPanStep(loopId) / PAN_STEP_SUM;
  if (voice.leftGain && voice.rightGain) {
    voice.leftGain.gain.value = l;
    voice.rightGain.gain.value = r;
  }
  const ap = voice.anchorPadKey ? parsePadKey(voice.anchorPadKey) : null;
  const pc = packColumnIndexForLoopId(loopId);
  const packMuted = pc != null && store.mutedColumns.has(pc);
  const physMuted = ap != null && store.mutedPhysicalSessionCols.has(ap.col);
  if (packMuted || physMuted) {
    voice.premuteGain = targetLinear;
    voice.gain.gain.value = 0;
  } else {
    voice.gain.gain.value = targetLinear;
    if (voice.premuteGain != null) voice.premuteGain = undefined;
  }
}

function updateG7VoiceGainForLoop(loopId) {
  if (!store.pack || loopId == null) return;
  const sid = String(loopId);
  const loop = store.pack.byId.get(sid);
  if (!loop) return;
  let playing = store.activeLoops.get(loopId);
  if (!playing && Number.isFinite(Number(loopId))) playing = store.activeLoops.get(Number(loopId));
  if (!playing) playing = store.activeLoops.get(sid);
  if (playing) applyVoiceGainLevels(playing, loopId, loop);
  const os = getActiveOneShot(loopId);
  if (os) applyVoiceGainLevels(os, loopId, loop);
}

function wireStereoVoice(src, loopId, velN, loop) {
  let voice = wireBufferSourceWithStereoPan(store.audioCtx, src, connectVoiceToMaster);
  voice = attachSpectrumEqToVoice(store.audioCtx, voice);
  voice = attachCompressorToVoice(store.audioCtx, voice);
  voice = attachDistortionToVoice(store.audioCtx, voice);
  voice = attachDelayToVoice(store.audioCtx, voice);
  voice = attachReverbToVoice(store.audioCtx, voice);
  voice.gainVelNorm = velN;
  applyVoiceGainLevels(voice, loopId, loop);
  applyClipSpectrumEqToVoice(voice, getClipSpectrumEqParams(loopId));
  applyClipCompressorToVoice(voice, getClipCompressorParams(loopId));
  applyClipDistortionToVoice(voice, getClipDistortionParams(loopId));
  applyClipDelayToVoice(voice, getClipDelayParams(loopId));
  applyClipReverbToVoice(voice, getClipReverbParams(loopId));
  connectVoiceToMaster(voice.gain);
  return voice;
}

function getClipSpectrumEqParams(loopId) {
  if (loopId == null) return defaultClipSpectrumEqParams();
  const sid = String(loopId);
  if (store.scene4ClipEqByLoopId.has(sid)) {
    return { ...defaultClipSpectrumEqParams(), ...store.scene4ClipEqByLoopId.get(sid) };
  }
  const n = Number(loopId);
  if (Number.isFinite(n) && store.scene4ClipEqByLoopId.has(n)) {
    return { ...defaultClipSpectrumEqParams(), ...store.scene4ClipEqByLoopId.get(n) };
  }
  return defaultClipSpectrumEqParams();
}

function setClipSpectrumEqParams(loopId, partial) {
  const cur = getClipSpectrumEqParams(loopId);
  const next = {
    highPassStep: Math.max(1, Math.min(8, Math.floor(Number(partial.highPassStep ?? cur.highPassStep)) || 1)),
    lowPassStep: Math.max(1, Math.min(8, Math.floor(Number(partial.lowPassStep ?? cur.lowPassStep)) || 8)),
  };
  store.scene4ClipEqByLoopId.set(String(loopId), next);
  if (Number.isFinite(Number(loopId))) store.scene4ClipEqByLoopId.set(Number(loopId), next);
}

function updateScene4EqVoiceForLoop(loopId) {
  if (!store.pack || loopId == null) return;
  const params = getClipSpectrumEqParams(loopId);
  const sid = String(loopId);
  let playing = store.activeLoops.get(loopId);
  if (!playing && Number.isFinite(Number(loopId))) playing = store.activeLoops.get(Number(loopId));
  if (!playing) playing = store.activeLoops.get(sid);
  if (playing) applyClipSpectrumEqToVoice(playing, params);
  const os = getActiveOneShot(loopId);
  if (os) applyClipSpectrumEqToVoice(os, params);
}

function soleScene4SelectedClipLoopId() {
  if (store.scene4SelectedClipLoopIds.size !== 1) return null;
  return [...store.scene4SelectedClipLoopIds][0];
}

function clipEqStepLabel(prefix, step) {
  const n = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  return `${prefix}${n}`;
}

function refreshClipSpectrumEqLevelBadges() {
  if (!dom.grid) return;
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    const p = getClipSpectrumEqParams(lid);
    let badge = el.querySelector(".eq-lvl");
    if (p.highPassStep <= 1 && p.lowPassStep >= 8) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "eq-lvl";
      badge.setAttribute("aria-hidden", "true");
      const vol = el.querySelector(".vol-lvl");
      if (vol) vol.before(badge);
      else el.append(badge);
    }
    badge.textContent = [
      p.highPassStep > 1 ? clipEqStepLabel("HP", p.highPassStep) : null,
      p.lowPassStep < 8 ? clipEqStepLabel("LP", p.lowPassStep) : null,
    ]
      .filter(Boolean)
      .join(" ");
    badge.title = `Spectrum EQ · HPF ${p.highPassStep}/8 · LPF ${p.lowPassStep}/8 (before distortion)`;
  }
}

function applyScene4HighPassStep(step) {
  const s = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  store.scene4HighPassStepSelection = s;
  if (store.scene4SelectedClipLoopIds.size > 0) {
    for (const id of store.scene4SelectedClipLoopIds) {
      setClipSpectrumEqParams(id, { highPassStep: s });
      updateScene4EqVoiceForLoop(id);
    }
    if (store.scene4SelectedClipLoopIds.size === 1) store.scene4HighPassStepSelection = null;
  }
  applyScene4EqMenuWebClasses();
  refreshClipSpectrumEqLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene4EqStripHardware();
    });
  }
}

function applyScene4LowPassStep(step) {
  const s = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  store.scene4LowPassStepSelection = s;
  if (store.scene4SelectedClipLoopIds.size > 0) {
    for (const id of store.scene4SelectedClipLoopIds) {
      setClipSpectrumEqParams(id, { lowPassStep: s });
      updateScene4EqVoiceForLoop(id);
    }
    if (store.scene4SelectedClipLoopIds.size === 1) store.scene4LowPassStepSelection = null;
  }
  applyScene4EqMenuWebClasses();
  refreshClipSpectrumEqLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene4EqStripHardware();
    });
  }
}

function toggleScene4ClipLoopSelection(loopId) {
  const sid = String(loopId);
  if (store.scene4SelectedClipLoopIds.has(sid)) store.scene4SelectedClipLoopIds.delete(sid);
  else {
    if (store.scene4SelectedClipLoopIds.size === 0) {
      store.scene4HighPassStepSelection = null;
      store.scene4LowPassStepSelection = null;
    }
    store.scene4SelectedClipLoopIds.add(sid);
  }
  if (store.scene4SelectedClipLoopIds.size === 1) {
    store.scene4HighPassStepSelection = null;
    store.scene4LowPassStepSelection = null;
  }
  applyScene4EqMenuWebClasses();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene4EqStripHardware();
    });
  }
}

function applyScene4EqMenuWebClasses() {
  if (!dom.grid) return;
  const soleId = soleScene4SelectedClipLoopId();
  const soleEq = soleId != null ? getClipSpectrumEqParams(soleId) : null;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]')) {
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (nm && Number.isFinite(dc)) {
      if (store.scene4EqMenuHeld) nm.textContent = `${dc + 1}/8`;
      else if (pad.dataset.stripGNmDefault != null) nm.textContent = pad.dataset.stripGNmDefault;
    }
    const stepOnPad =
      store.scene4EqMenuHeld &&
      store.scene4HighPassStepSelection != null &&
      store.scene4HighPassStepSelection === dc + 1;
    const isCurrent =
      store.scene4EqMenuHeld && soleEq != null && soleEq.highPassStep === dc + 1 && !stepOnPad;
    pad.classList.toggle("scene4-g-hp-strip", store.scene4EqMenuHeld);
    pad.classList.toggle("scene4-g-strip-step-apply", stepOnPad && store.scene4SelectedClipLoopIds.size > 0);
    pad.classList.toggle("scene4-g-strip-step-query", stepOnPad && store.scene4SelectedClipLoopIds.size === 0);
    pad.classList.toggle("scene4-g-strip-step-current", isCurrent);
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (nm && Number.isFinite(dc)) {
      if (store.scene4EqMenuHeld) nm.textContent = `${dc + 1}/8`;
      else if (pad.dataset.stripHNmDefault != null) nm.textContent = pad.dataset.stripHNmDefault;
    }
    const stepOnPad =
      store.scene4EqMenuHeld &&
      store.scene4LowPassStepSelection != null &&
      store.scene4LowPassStepSelection === dc + 1;
    const isCurrent =
      store.scene4EqMenuHeld && soleEq != null && soleEq.lowPassStep === dc + 1 && !stepOnPad;
    pad.classList.toggle("scene4-h-lp-strip", store.scene4EqMenuHeld);
    pad.classList.toggle("scene4-h-strip-step-apply", stepOnPad && store.scene4SelectedClipLoopIds.size > 0);
    pad.classList.toggle("scene4-h-strip-step-query", stepOnPad && store.scene4SelectedClipLoopIds.size === 0);
    pad.classList.toggle("scene4-h-strip-step-current", isCurrent);
    pad.classList.toggle(
      "scene4-h8-lp-max-strip",
      store.scene4EqMenuHeld && pad.dataset.h8ClockMenuStrip === "true",
    );
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    el.classList.toggle("scene4-clip-selected", store.scene4EqMenuHeld && store.scene4SelectedClipLoopIds.has(lid));
    const eq = getClipSpectrumEqParams(lid);
    const hpMatch =
      store.scene4EqMenuHeld &&
      store.scene4HighPassStepSelection != null &&
      store.scene4SelectedClipLoopIds.size === 0 &&
      eq.highPassStep === store.scene4HighPassStepSelection &&
      !store.scene4SelectedClipLoopIds.has(lid);
    const lpMatch =
      store.scene4EqMenuHeld &&
      store.scene4LowPassStepSelection != null &&
      store.scene4SelectedClipLoopIds.size === 0 &&
      eq.lowPassStep === store.scene4LowPassStepSelection &&
      !store.scene4SelectedClipLoopIds.has(lid);
    el.classList.toggle("scene4-clip-eq-match", hpMatch || lpMatch);
  }
}

function clearScene4EqMenuWebClasses() {
  if (!dom.grid) return;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]')) {
    const nm = pad.querySelector(".nm");
    if (nm && pad.dataset.stripGNmDefault != null) nm.textContent = pad.dataset.stripGNmDefault;
    pad.classList.remove(
      "scene4-g-hp-strip",
      "scene4-g-strip-step-apply",
      "scene4-g-strip-step-query",
      "scene4-g-strip-step-current",
    );
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    const nm = pad.querySelector(".nm");
    if (nm && pad.dataset.stripHNmDefault != null) nm.textContent = pad.dataset.stripHNmDefault;
    pad.classList.remove(
      "scene4-h-lp-strip",
      "scene4-h-strip-step-apply",
      "scene4-h-strip-step-query",
      "scene4-h-strip-step-current",
      "scene4-h8-lp-max-strip",
    );
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    el.classList.remove("scene4-clip-selected", "scene4-clip-eq-match");
  }
}

function refreshLaunchpadScene4EqStripHardware() {
  if (!store.midiAccess || !store.pack || !store.scene4EqMenuHeld) return;
  const soleEq =
    store.scene4SelectedClipLoopIds.size === 1
      ? getClipSpectrumEqParams(soleScene4SelectedClipLoopId())
      : null;
  for (let dc = 0; dc < 8; dc += 1) {
    const pkG = padKeyFromPhysicalCell(dc, 6);
    let vG = LP_SESSION_SCENE4_EQ_MENU.stripRowG;
    const stepHp = dc + 1;
    if (store.scene4HighPassStepSelection != null && store.scene4HighPassStepSelection === stepHp) {
      vG =
        store.scene4SelectedClipLoopIds.size > 0
          ? LP_SESSION_SCENE4_EQ_MENU.stripStepApplyOrange
          : LP_SESSION_SCENE4_EQ_MENU.stripStepQueryPurple;
    } else if (soleEq != null && soleEq.highPassStep === stepHp) {
      vG = LP_SESSION_SCENE4_EQ_MENU.stripStepCurrentG;
    }
    sendSessionPadLightingRowG(pkG, vG);
    const pkH = padKeyFromPhysicalCell(dc, 7);
    let vH = LP_SESSION_SCENE4_EQ_MENU.stripRowH;
    const stepLp = dc + 1;
    if (store.scene4LowPassStepSelection != null && store.scene4LowPassStepSelection === stepLp) {
      vH =
        store.scene4SelectedClipLoopIds.size > 0
          ? LP_SESSION_SCENE4_EQ_MENU.stripStepApplyYellow
          : LP_SESSION_SCENE4_EQ_MENU.stripStepQueryPurple;
    } else if (soleEq != null && soleEq.lowPassStep === stepLp) {
      vH = LP_SESSION_SCENE4_EQ_MENU.stripStepCurrentH;
    }
    sendSessionPadLightingRowH(pkH, vH);
  }
}

function toggleScene4EqMenuLatch() {
  const next = !store.scene4EqMenuLatched;
  store.scene4EqMenuLatched = next;
  setScene4EqMenuHeld(next);
}

function releaseScene4EqMenuPointer() {
  if (!store.scene4EqMenuLatched) setScene4EqMenuHeld(false);
}

function setScene4EqMenuHeld(on) {
  if (!on) store.scene4EqMenuLatched = false;
  const wasHeld = store.scene4EqMenuHeld;
  if (on) {
    if (store.g7VolumeMenuHeld) setG7VolumeMenuHeld(false);
    if (store.g6StereoPanMenuHeld) setG6StereoPanMenuHeld(false);
    if (store.g4DistortionMenuHeld) setG4DistortionMenuHeld(false);
    if (store.scene5CompressorMenuHeld) setScene5CompressorMenuHeld(false);
    if (store.scene7DelayMenuHeld) setScene7DelayMenuHeld(false);
    if (store.scene8ReverbMenuHeld) setScene8ReverbMenuHeld(false);
    if (store.h8ClockStripMenuHeld) setH8ClockStripMenuHeld(false);
    clearHStopModifierPhysicalCols();
    if (store.clipKindLegendHeld) endClipKindLegendHold();
    if (store.clipTypeLegendHeld) endClipTypeLegendHold();
  }
  store.scene4EqMenuHeld = on;
  if (dom.grid) dom.grid.classList.toggle("scene4-eq-menu-active", on);
  syncSidePanelLegendsWeb();
  if (on) {
    applyScene4EqMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshLaunchpadSessionClipPadsHardwareOnly();
        refreshLaunchpadScene4EqStripHardware();
      });
    }
  } else if (wasHeld) {
    store.scene4HighPassStepSelection = null;
    store.scene4LowPassStepSelection = null;
    store.scene4SelectedClipLoopIds.clear();
    clearScene4EqMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshAllLaunchpadClipLeds();
        refreshLaunchpadSyncClockRowG(syncClockTickDisplayColumn8());
        refreshLaunchpadStripRowHIdleHardware();
      });
    }
  } else if (store.midiAccess) {
    refreshLaunchpadSceneSideCcLeds();
  }
}

function getClipCompressorParams(loopId) {
  if (loopId == null) return defaultClipCompressorParams();
  const sid = String(loopId);
  if (store.scene5ClipCompressorByLoopId.has(sid)) {
    return { ...defaultClipCompressorParams(), ...store.scene5ClipCompressorByLoopId.get(sid) };
  }
  const n = Number(loopId);
  if (Number.isFinite(n) && store.scene5ClipCompressorByLoopId.has(n)) {
    return { ...defaultClipCompressorParams(), ...store.scene5ClipCompressorByLoopId.get(n) };
  }
  return defaultClipCompressorParams();
}

function setClipCompressorParams(loopId, partial) {
  const cur = getClipCompressorParams(loopId);
  const next = {
    thresholdStep: Math.max(1, Math.min(8, Math.floor(Number(partial.thresholdStep ?? cur.thresholdStep)) || 8)),
    ratioStep: Math.max(1, Math.min(4, Math.floor(Number(partial.ratioStep ?? cur.ratioStep)) || 1)),
    makeupStep: Math.max(1, Math.min(8, Math.floor(Number(partial.makeupStep ?? cur.makeupStep)) || 1)),
  };
  store.scene5ClipCompressorByLoopId.set(String(loopId), next);
  if (Number.isFinite(Number(loopId))) store.scene5ClipCompressorByLoopId.set(Number(loopId), next);
}

function updateScene5CompressorVoiceForLoop(loopId) {
  if (!store.pack || loopId == null) return;
  const params = getClipCompressorParams(loopId);
  const sid = String(loopId);
  let playing = store.activeLoops.get(loopId);
  if (!playing && Number.isFinite(Number(loopId))) playing = store.activeLoops.get(Number(loopId));
  if (!playing) playing = store.activeLoops.get(sid);
  if (playing) applyClipCompressorToVoice(playing, params);
  const os = getActiveOneShot(loopId);
  if (os) applyClipCompressorToVoice(os, params);
}

function soleScene5SelectedClipLoopId() {
  if (store.scene5SelectedClipLoopIds.size !== 1) return null;
  return [...store.scene5SelectedClipLoopIds][0];
}

function allScene5SelectedClipsHaveThreshold(step) {
  if (store.scene5SelectedClipLoopIds.size === 0) return false;
  for (const id of store.scene5SelectedClipLoopIds) {
    if (getClipCompressorParams(id).thresholdStep !== step) return false;
  }
  return true;
}

function refreshClipCompressorLevelBadges() {
  if (!dom.grid) return;
  const def = defaultClipCompressorParams();
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    const p = getClipCompressorParams(lid);
    let badge = el.querySelector(".comp-lvl");
    if (
      p.thresholdStep === def.thresholdStep &&
      p.ratioStep === def.ratioStep &&
      p.makeupStep === def.makeupStep
    ) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "comp-lvl";
      badge.setAttribute("aria-hidden", "true");
      const eq = el.querySelector(".eq-lvl");
      if (eq) eq.before(badge);
      else {
        const vol = el.querySelector(".vol-lvl");
        if (vol) vol.before(badge);
        else el.append(badge);
      }
    }
    badge.textContent = `T${p.thresholdStep} R${p.ratioStep} M${p.makeupStep}`;
    badge.title = `Compressor · threshold ${p.thresholdStep}/8 · ratio ${p.ratioStep}/4 · makeup ${p.makeupStep}/8`;
  }
}

function applyScene5ThresholdStep(step) {
  const s = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  store.scene5ThresholdStepSelection = s;
  if (store.scene5SelectedClipLoopIds.size > 0) {
    for (const id of store.scene5SelectedClipLoopIds) {
      setClipCompressorParams(id, { thresholdStep: s });
      updateScene5CompressorVoiceForLoop(id);
    }
    if (store.scene5SelectedClipLoopIds.size === 1) store.scene5ThresholdStepSelection = null;
  }
  applyScene5CompressorMenuWebClasses();
  refreshClipCompressorLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene5CompStripHardware();
    });
  }
}

function applyScene5RatioStep(step) {
  const s = Math.max(1, Math.min(4, Math.floor(Number(step)) || 1));
  store.scene5RatioStepSelection = s;
  if (store.scene5SelectedClipLoopIds.size > 0) {
    for (const id of store.scene5SelectedClipLoopIds) {
      setClipCompressorParams(id, { ratioStep: s });
      updateScene5CompressorVoiceForLoop(id);
    }
    if (store.scene5SelectedClipLoopIds.size === 1) store.scene5RatioStepSelection = null;
  }
  applyScene5CompressorMenuWebClasses();
  refreshClipCompressorLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene5CompStripHardware();
    });
  }
}

function applyScene5MakeupStep(step) {
  const s = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  store.scene5MakeupStepSelection = s;
  if (store.scene5SelectedClipLoopIds.size > 0) {
    for (const id of store.scene5SelectedClipLoopIds) {
      setClipCompressorParams(id, { makeupStep: s });
      updateScene5CompressorVoiceForLoop(id);
    }
    if (store.scene5SelectedClipLoopIds.size === 1) store.scene5MakeupStepSelection = null;
  }
  applyScene5CompressorMenuWebClasses();
  refreshClipCompressorLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene5CompStripHardware();
    });
  }
}

function toggleScene5ClipLoopSelection(loopId) {
  const sid = String(loopId);
  if (store.scene5SelectedClipLoopIds.has(sid)) store.scene5SelectedClipLoopIds.delete(sid);
  else {
    if (store.scene5SelectedClipLoopIds.size === 0) {
      store.scene5ThresholdStepSelection = null;
      store.scene5RatioStepSelection = null;
      store.scene5MakeupStepSelection = null;
    }
    store.scene5SelectedClipLoopIds.add(sid);
  }
  if (store.scene5SelectedClipLoopIds.size === 1) {
    store.scene5ThresholdStepSelection = null;
    store.scene5RatioStepSelection = null;
    store.scene5MakeupStepSelection = null;
  }
  applyScene5CompressorMenuWebClasses();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene5CompStripHardware();
    });
  }
}

function applyScene5CompressorMenuWebClasses() {
  if (!dom.grid) return;
  const soleId = soleScene5SelectedClipLoopId();
  const sole = soleId != null ? getClipCompressorParams(soleId) : null;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]')) {
    if (pad.dataset.g8VolumeHoldStrip === "true") continue;
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (nm && Number.isFinite(dc)) {
      if (store.scene5CompressorMenuHeld) nm.textContent = `${dc + 1}/8`;
      else if (pad.dataset.stripGNmDefault != null) nm.textContent = pad.dataset.stripGNmDefault;
    }
    pad.classList.toggle("scene5-g-thr-strip", store.scene5CompressorMenuHeld);
    pad.classList.remove("scene5-g-strip-step-apply", "scene5-g-strip-step-query", "scene5-g-strip-step-current");
    if (!store.scene5CompressorMenuHeld || !Number.isFinite(dc)) continue;
    const step = dc + 1;
    const stepOnPad =
      store.scene5ThresholdStepSelection != null && store.scene5ThresholdStepSelection === step;
    const isCurrent = !stepOnPad && allScene5SelectedClipsHaveThreshold(step);
    pad.classList.toggle("scene5-g-strip-step-apply", stepOnPad && store.scene5SelectedClipLoopIds.size > 0);
    pad.classList.toggle("scene5-g-strip-step-query", stepOnPad && store.scene5SelectedClipLoopIds.size === 0);
    pad.classList.toggle("scene5-g-strip-step-current", isCurrent);
    if (nm && isCurrent) nm.textContent = `${step}/8 ·`;
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (!store.scene5CompressorMenuHeld || !Number.isFinite(dc)) {
      pad.classList.remove(
        "scene5-h-ratio-strip",
        "scene5-h-makeup-strip",
        "scene5-h-strip-lit",
      );
      continue;
    }
    pad.classList.add(dc <= 3 ? "scene5-h-ratio-strip" : "scene5-h-makeup-strip");
    pad.classList.remove("scene5-h-strip-lit");
    let lit = false;
    if (dc <= 3) {
      const r = dc + 1;
      if (nm) nm.textContent = `R${r}`;
      lit = sole != null && sole.ratioStep === r;
    } else {
      const m = dc + 1;
      if (nm) nm.textContent = `M${m}`;
      lit = sole != null && sole.makeupStep === m;
    }
    pad.classList.toggle("scene5-h-strip-lit", lit);
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    el.classList.toggle(
      "scene5-clip-selected",
      store.scene5CompressorMenuHeld && store.scene5SelectedClipLoopIds.has(lid),
    );
    const p = getClipCompressorParams(lid);
    const thrMatch =
      store.scene5CompressorMenuHeld &&
      store.scene5ThresholdStepSelection != null &&
      store.scene5SelectedClipLoopIds.size === 0 &&
      p.thresholdStep === store.scene5ThresholdStepSelection;
    el.classList.toggle("scene5-clip-comp-match", thrMatch);
  }
}

function clearScene5CompressorMenuWebClasses() {
  if (!dom.grid) return;
  for (const pad of dom.grid.querySelectorAll("button.pad.utility")) {
    pad.classList.remove(
      "scene5-g-thr-strip",
      "scene5-g-strip-step-apply",
      "scene5-g-strip-step-query",
      "scene5-g-strip-step-current",
      "scene5-h-ratio-strip",
      "scene5-h-makeup-strip",
      "scene5-h-strip-lit",
    );
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    el.classList.remove("scene5-clip-selected", "scene5-clip-comp-match");
  }
}

function refreshLaunchpadScene5CompStripHardware() {
  if (!store.midiAccess || !store.pack || !store.scene5CompressorMenuHeld) return;
  const sole =
    store.scene5SelectedClipLoopIds.size === 1
      ? getClipCompressorParams(soleScene5SelectedClipLoopId())
      : null;
  const soleThr = sole?.thresholdStep ?? null;
  for (let dc = 0; dc < 8; dc += 1) {
    const pkG = padKeyFromPhysicalCell(dc, 6);
    let vG = LP_SESSION_SCENE5_COMP_MENU.stripRowG;
    const stepG = dc + 1;
    if (store.scene5ThresholdStepSelection != null && store.scene5ThresholdStepSelection === stepG) {
      vG =
        store.scene5SelectedClipLoopIds.size > 0
          ? LP_SESSION_SCENE5_COMP_MENU.stripStepApplyYellow
          : LP_SESSION_SCENE5_COMP_MENU.stripStepQueryPurple;
    } else if (soleThr != null && soleThr === stepG) {
      vG = LP_SESSION_SCENE5_COMP_MENU.stripStepCurrentG;
    }
    sendSessionPadLightingRowG(pkG, vG);
    const pkH = padKeyFromPhysicalCell(dc, 7);
    let vH = LP_SESSION_SCENE5_COMP_MENU.stripRowH;
    if (sole != null) {
      if (dc <= 3 && sole.ratioStep === dc + 1) {
        vH = LP_SESSION_SCENE5_COMP_MENU.stripRatioLit[dc];
      } else if (dc >= 4 && sole.makeupStep === dc + 1) {
        vH = LP_SESSION_SCENE5_COMP_MENU.stripMakeupLit[dc - 4];
      }
    }
    sendSessionPadLightingRowH(pkH, vH);
  }
}

function toggleScene5CompressorMenuLatch() {
  const next = !store.scene5CompressorMenuLatched;
  store.scene5CompressorMenuLatched = next;
  setScene5CompressorMenuHeld(next);
}

function releaseScene5CompressorMenuPointer() {
  if (!store.scene5CompressorMenuLatched) setScene5CompressorMenuHeld(false);
}

function setScene5CompressorMenuHeld(on) {
  if (!on) store.scene5CompressorMenuLatched = false;
  const wasHeld = store.scene5CompressorMenuHeld;
  if (on) {
    if (store.g7VolumeMenuHeld) setG7VolumeMenuHeld(false);
    if (store.g6StereoPanMenuHeld) setG6StereoPanMenuHeld(false);
    if (store.scene4EqMenuHeld) setScene4EqMenuHeld(false);
    if (store.g4DistortionMenuHeld) setG4DistortionMenuHeld(false);
    if (store.scene7DelayMenuHeld) setScene7DelayMenuHeld(false);
    if (store.scene8ReverbMenuHeld) setScene8ReverbMenuHeld(false);
    if (store.h8ClockStripMenuHeld) setH8ClockStripMenuHeld(false);
    clearHStopModifierPhysicalCols();
    if (store.clipKindLegendHeld) endClipKindLegendHold();
    if (store.clipTypeLegendHeld) endClipTypeLegendHold();
  }
  store.scene5CompressorMenuHeld = on;
  if (dom.grid) dom.grid.classList.toggle("scene5-comp-menu-active", on);
  syncSidePanelLegendsWeb();
  if (on) {
    applyScene5CompressorMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshLaunchpadSessionClipPadsHardwareOnly();
        refreshLaunchpadScene5CompStripHardware();
      });
    }
  } else if (wasHeld) {
    store.scene5ThresholdStepSelection = null;
    store.scene5RatioStepSelection = null;
    store.scene5MakeupStepSelection = null;
    store.scene5SelectedClipLoopIds.clear();
    clearScene5CompressorMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshAllLaunchpadClipLeds();
        refreshLaunchpadSyncClockRowG(syncClockTickDisplayColumn8());
        refreshLaunchpadStripRowHIdleHardware();
      });
    }
  } else if (store.midiAccess) {
    refreshLaunchpadSceneSideCcLeds();
  }
}

function getClipDelayParams(loopId) {
  if (loopId == null) return defaultClipDelayParams();
  const sid = String(loopId);
  if (store.scene7ClipDelayByLoopId.has(sid)) {
    return { ...defaultClipDelayParams(), ...store.scene7ClipDelayByLoopId.get(sid) };
  }
  const n = Number(loopId);
  if (Number.isFinite(n) && store.scene7ClipDelayByLoopId.has(n)) {
    return { ...defaultClipDelayParams(), ...store.scene7ClipDelayByLoopId.get(n) };
  }
  return defaultClipDelayParams();
}

function setClipDelayParams(loopId, partial) {
  const cur = getClipDelayParams(loopId);
  const next = {
    timeStep: Math.max(1, Math.min(4, Math.floor(Number(partial.timeStep ?? cur.timeStep)) || 1)),
    feedbackStep: Math.max(1, Math.min(4, Math.floor(Number(partial.feedbackStep ?? cur.feedbackStep)) || 1)),
    mixStep: Math.max(1, Math.min(4, Math.floor(Number(partial.mixStep ?? cur.mixStep)) || 1)),
    toneStep: Math.max(1, Math.min(4, Math.floor(Number(partial.toneStep ?? cur.toneStep)) || 4)),
  };
  store.scene7ClipDelayByLoopId.set(String(loopId), next);
  if (Number.isFinite(Number(loopId))) store.scene7ClipDelayByLoopId.set(Number(loopId), next);
}

function updateScene7DelayVoiceForLoop(loopId) {
  if (!store.pack || loopId == null) return;
  const params = getClipDelayParams(loopId);
  const sid = String(loopId);
  let playing = store.activeLoops.get(loopId);
  if (!playing && Number.isFinite(Number(loopId))) playing = store.activeLoops.get(Number(loopId));
  if (!playing) playing = store.activeLoops.get(sid);
  if (playing) applyClipDelayToVoice(playing, params);
  const os = getActiveOneShot(loopId);
  if (os) applyClipDelayToVoice(os, params);
}

function soleScene7SelectedClipLoopId() {
  if (store.scene7SelectedClipLoopIds.size !== 1) return null;
  return [...store.scene7SelectedClipLoopIds][0];
}

function refreshClipDelayLevelBadges() {
  if (!dom.grid) return;
  const def = defaultClipDelayParams();
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    const p = getClipDelayParams(lid);
    let badge = el.querySelector(".dly-lvl");
    if (
      p.timeStep === def.timeStep &&
      p.feedbackStep === def.feedbackStep &&
      p.mixStep === def.mixStep &&
      p.toneStep === def.toneStep
    ) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "dly-lvl";
      badge.setAttribute("aria-hidden", "true");
      const comp = el.querySelector(".comp-lvl");
      if (comp) comp.before(badge);
      else {
        const eq = el.querySelector(".eq-lvl");
        if (eq) eq.before(badge);
        else el.append(badge);
      }
    }
    badge.textContent = `T${p.timeStep} F${p.feedbackStep} M${p.mixStep} N${p.toneStep}`;
    badge.title = `Delay · time ${p.timeStep}/4 · feedback ${p.feedbackStep}/4 · mix ${p.mixStep}/4 · tone ${p.toneStep}/4`;
  }
}

function applyScene7TimeStep(step) {
  applyScene7DelayParamToSelection({ timeStep: step }, "time");
}

function applyScene7FeedbackStep(step) {
  applyScene7DelayParamToSelection({ feedbackStep: step }, "feedback");
}

function applyScene7MixStep(step) {
  applyScene7DelayParamToSelection({ mixStep: step }, "mix");
}

function applyScene7ToneStep(step) {
  applyScene7DelayParamToSelection({ toneStep: step }, "tone");
}

function applyScene7DelayParamToSelection(partial, kind) {
  if (kind === "time") {
    const s = Math.max(1, Math.min(4, Math.floor(Number(partial.timeStep)) || 1));
    store.scene7TimeStepSelection = s;
    if (store.scene7SelectedClipLoopIds.size > 0) {
      for (const id of store.scene7SelectedClipLoopIds) {
        setClipDelayParams(id, { timeStep: s });
        updateScene7DelayVoiceForLoop(id);
      }
      if (store.scene7SelectedClipLoopIds.size === 1) store.scene7TimeStepSelection = null;
    }
  } else if (kind === "feedback") {
    const s = Math.max(1, Math.min(4, Math.floor(Number(partial.feedbackStep)) || 1));
    store.scene7FeedbackStepSelection = s;
    if (store.scene7SelectedClipLoopIds.size > 0) {
      for (const id of store.scene7SelectedClipLoopIds) {
        setClipDelayParams(id, { feedbackStep: s });
        updateScene7DelayVoiceForLoop(id);
      }
      if (store.scene7SelectedClipLoopIds.size === 1) store.scene7FeedbackStepSelection = null;
    }
  } else if (kind === "mix") {
    const s = Math.max(1, Math.min(4, Math.floor(Number(partial.mixStep)) || 1));
    store.scene7MixStepSelection = s;
    if (store.scene7SelectedClipLoopIds.size > 0) {
      for (const id of store.scene7SelectedClipLoopIds) {
        setClipDelayParams(id, { mixStep: s });
        updateScene7DelayVoiceForLoop(id);
      }
      if (store.scene7SelectedClipLoopIds.size === 1) store.scene7MixStepSelection = null;
    }
  } else if (kind === "tone") {
    const s = Math.max(1, Math.min(4, Math.floor(Number(partial.toneStep)) || 1));
    store.scene7ToneStepSelection = s;
    if (store.scene7SelectedClipLoopIds.size > 0) {
      for (const id of store.scene7SelectedClipLoopIds) {
        setClipDelayParams(id, { toneStep: s });
        updateScene7DelayVoiceForLoop(id);
      }
      if (store.scene7SelectedClipLoopIds.size === 1) store.scene7ToneStepSelection = null;
    }
  }
  applyScene7DelayMenuWebClasses();
  refreshClipDelayLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene7DelayStripHardware();
    });
  }
}

function applyScene7StripG(dc) {
  if (dc <= 3) applyScene7TimeStep(dc + 1);
  else applyScene7FeedbackStep(dc - 3);
}

function applyScene7StripH(dc) {
  if (dc <= 3) applyScene7MixStep(dc + 1);
  else applyScene7ToneStep(dc - 3);
}

function toggleScene7ClipLoopSelection(loopId) {
  const sid = String(loopId);
  if (store.scene7SelectedClipLoopIds.has(sid)) store.scene7SelectedClipLoopIds.delete(sid);
  else {
    if (store.scene7SelectedClipLoopIds.size === 0) {
      store.scene7TimeStepSelection = null;
      store.scene7FeedbackStepSelection = null;
      store.scene7MixStepSelection = null;
      store.scene7ToneStepSelection = null;
    }
    store.scene7SelectedClipLoopIds.add(sid);
  }
  if (store.scene7SelectedClipLoopIds.size === 1) {
    store.scene7TimeStepSelection = null;
    store.scene7FeedbackStepSelection = null;
    store.scene7MixStepSelection = null;
    store.scene7ToneStepSelection = null;
  }
  applyScene7DelayMenuWebClasses();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene7DelayStripHardware();
    });
  }
}

function applyScene7DelayMenuWebClasses() {
  if (!dom.grid) return;
  const sole = soleScene7SelectedClipLoopId() != null ? getClipDelayParams(soleScene7SelectedClipLoopId()) : null;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]')) {
    if (pad.dataset.g8VolumeHoldStrip === "true") continue;
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (!Number.isFinite(dc)) continue;
    pad.classList.toggle("scene7-delay-menu-held", store.scene7DelayMenuHeld);
    pad.classList.remove(
      "scene7-g-time-zone",
      "scene7-g-fb-zone",
      "scene7-g-strip-lit",
      "scene7-g-strip-step-apply",
      "scene7-g-strip-step-query",
    );
    if (!store.scene7DelayMenuHeld) {
      if (nm && pad.dataset.stripGNmDefault != null) nm.textContent = pad.dataset.stripGNmDefault;
      continue;
    }
    const isTime = dc <= 3;
    pad.classList.add(isTime ? "scene7-g-time-zone" : "scene7-g-fb-zone");
    const step = isTime ? dc + 1 : dc - 3;
    if (nm) nm.textContent = isTime ? `T${step}` : `F${step}`;
    let lit = false;
    if (sole) lit = isTime ? sole.timeStep === step : sole.feedbackStep === step;
    const pending =
      (isTime && store.scene7TimeStepSelection === step) ||
      (!isTime && store.scene7FeedbackStepSelection === step);
    pad.classList.toggle("scene7-g-strip-lit", lit && !pending);
    pad.classList.toggle("scene7-g-strip-step-apply", pending && store.scene7SelectedClipLoopIds.size > 0);
    pad.classList.toggle("scene7-g-strip-step-query", pending && store.scene7SelectedClipLoopIds.size === 0);
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (!Number.isFinite(dc)) continue;
    pad.classList.remove(
      "scene7-h-mix-zone",
      "scene7-h-tone-zone",
      "scene7-h-strip-lit",
      "scene7-h-strip-step-apply",
      "scene7-h-strip-step-query",
    );
    if (!store.scene7DelayMenuHeld) {
      if (nm && pad.dataset.stripHNmDefault != null) nm.textContent = pad.dataset.stripHNmDefault;
      continue;
    }
    const isMix = dc <= 3;
    pad.classList.add(isMix ? "scene7-h-mix-zone" : "scene7-h-tone-zone");
    const step = isMix ? dc + 1 : dc - 3;
    if (nm) nm.textContent = isMix ? `M${step}` : `N${step}`;
    let lit = false;
    if (sole) lit = isMix ? sole.mixStep === step : sole.toneStep === step;
    const pending =
      (isMix && store.scene7MixStepSelection === step) ||
      (!isMix && store.scene7ToneStepSelection === step);
    pad.classList.toggle("scene7-h-strip-lit", lit && !pending);
    pad.classList.toggle("scene7-h-strip-step-apply", pending && store.scene7SelectedClipLoopIds.size > 0);
    pad.classList.toggle("scene7-h-strip-step-query", pending && store.scene7SelectedClipLoopIds.size === 0);
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    el.classList.toggle(
      "scene7-clip-selected",
      store.scene7DelayMenuHeld && store.scene7SelectedClipLoopIds.has(lid),
    );
    const p = getClipDelayParams(lid);
    const match =
      store.scene7DelayMenuHeld &&
      store.scene7SelectedClipLoopIds.size === 0 &&
      ((store.scene7TimeStepSelection != null && p.timeStep === store.scene7TimeStepSelection) ||
        (store.scene7FeedbackStepSelection != null && p.feedbackStep === store.scene7FeedbackStepSelection) ||
        (store.scene7MixStepSelection != null && p.mixStep === store.scene7MixStepSelection) ||
        (store.scene7ToneStepSelection != null && p.toneStep === store.scene7ToneStepSelection));
    el.classList.toggle("scene7-clip-delay-match", match);
  }
}

function clearScene7DelayMenuWebClasses() {
  if (!dom.grid) return;
  for (const pad of dom.grid.querySelectorAll("button.pad.utility")) {
    pad.classList.remove(
      "scene7-delay-menu-held",
      "scene7-g-time-zone",
      "scene7-g-fb-zone",
      "scene7-g-strip-lit",
      "scene7-g-strip-step-apply",
      "scene7-g-strip-step-query",
      "scene7-h-mix-zone",
      "scene7-h-tone-zone",
      "scene7-h-strip-lit",
      "scene7-h-strip-step-apply",
      "scene7-h-strip-step-query",
    );
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    el.classList.remove("scene7-clip-selected", "scene7-clip-delay-match");
  }
}

function refreshLaunchpadScene7DelayStripHardware() {
  if (!store.midiAccess || !store.pack || !store.scene7DelayMenuHeld) return;
  const sole = soleScene7SelectedClipLoopId() != null ? getClipDelayParams(soleScene7SelectedClipLoopId()) : null;
  for (let dc = 0; dc < 8; dc += 1) {
    const pkG = padKeyFromPhysicalCell(dc, 6);
    const isTime = dc <= 3;
    let vG = isTime ? LP_SESSION_SCENE7_DELAY_MENU.stripGTime : LP_SESSION_SCENE7_DELAY_MENU.stripGFeedback;
    const stepG = isTime ? dc + 1 : dc - 3;
    const pendingG =
      (isTime && store.scene7TimeStepSelection === stepG) ||
      (!isTime && store.scene7FeedbackStepSelection === stepG);
    if (pendingG) {
      vG =
        store.scene7SelectedClipLoopIds.size > 0
          ? LP_SESSION_SCENE7_DELAY_MENU.stripStepApplyYellow
          : LP_SESSION_SCENE7_DELAY_MENU.stripStepQueryPurple;
    } else if (sole && (isTime ? sole.timeStep === stepG : sole.feedbackStep === stepG)) {
      vG = isTime
        ? LP_SESSION_SCENE7_DELAY_MENU.stripTimeLit[dc]
        : LP_SESSION_SCENE7_DELAY_MENU.stripFeedbackLit[dc - 4];
    }
    sendSessionPadLightingRowG(pkG, vG);
    const pkH = padKeyFromPhysicalCell(dc, 7);
    const isMix = dc <= 3;
    let vH = isMix ? LP_SESSION_SCENE7_DELAY_MENU.stripHMix : LP_SESSION_SCENE7_DELAY_MENU.stripHTone;
    const stepH = isMix ? dc + 1 : dc - 3;
    const pendingH =
      (isMix && store.scene7MixStepSelection === stepH) ||
      (!isMix && store.scene7ToneStepSelection === stepH);
    if (pendingH) {
      vH =
        store.scene7SelectedClipLoopIds.size > 0
          ? LP_SESSION_SCENE7_DELAY_MENU.stripStepApplyYellow
          : LP_SESSION_SCENE7_DELAY_MENU.stripStepQueryPurple;
    } else if (sole && (isMix ? sole.mixStep === stepH : sole.toneStep === stepH)) {
      vH = isMix
        ? LP_SESSION_SCENE7_DELAY_MENU.stripMixLit[dc]
        : LP_SESSION_SCENE7_DELAY_MENU.stripToneLit[dc - 4];
    }
    sendSessionPadLightingRowH(pkH, vH);
  }
}

function toggleScene7DelayMenuLatch() {
  const next = !store.scene7DelayMenuLatched;
  store.scene7DelayMenuLatched = next;
  setScene7DelayMenuHeld(next);
}

function releaseScene7DelayMenuPointer() {
  if (!store.scene7DelayMenuLatched) setScene7DelayMenuHeld(false);
}

function setScene7DelayMenuHeld(on) {
  if (!on) store.scene7DelayMenuLatched = false;
  const wasHeld = store.scene7DelayMenuHeld;
  if (on) {
    if (store.g7VolumeMenuHeld) setG7VolumeMenuHeld(false);
    if (store.g6StereoPanMenuHeld) setG6StereoPanMenuHeld(false);
    if (store.scene4EqMenuHeld) setScene4EqMenuHeld(false);
    if (store.scene5CompressorMenuHeld) setScene5CompressorMenuHeld(false);
    if (store.g4DistortionMenuHeld) setG4DistortionMenuHeld(false);
    if (store.scene8ReverbMenuHeld) setScene8ReverbMenuHeld(false);
    if (store.h8ClockStripMenuHeld) setH8ClockStripMenuHeld(false);
    clearHStopModifierPhysicalCols();
    if (store.clipKindLegendHeld) endClipKindLegendHold();
    if (store.clipTypeLegendHeld) endClipTypeLegendHold();
  }
  store.scene7DelayMenuHeld = on;
  if (dom.grid) dom.grid.classList.toggle("scene7-delay-menu-active", on);
  syncSidePanelLegendsWeb();
  if (on) {
    applyScene7DelayMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshLaunchpadSessionClipPadsHardwareOnly();
        refreshLaunchpadScene7DelayStripHardware();
      });
    }
  } else if (wasHeld) {
    store.scene7TimeStepSelection = null;
    store.scene7FeedbackStepSelection = null;
    store.scene7MixStepSelection = null;
    store.scene7ToneStepSelection = null;
    store.scene7SelectedClipLoopIds.clear();
    clearScene7DelayMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshAllLaunchpadClipLeds();
        refreshLaunchpadSyncClockRowG(syncClockTickDisplayColumn8());
        refreshLaunchpadStripRowHIdleHardware();
      });
    }
  } else if (store.midiAccess) {
    refreshLaunchpadSceneSideCcLeds();
  }
}

function getClipReverbParams(loopId) {
  if (loopId == null) return defaultClipReverbParams();
  const sid = String(loopId);
  const n = Number(loopId);
  if (store.scene8ClipReverbByLoopId.has(sid)) {
    return { ...defaultClipReverbParams(), ...store.scene8ClipReverbByLoopId.get(sid) };
  }
  if (Number.isFinite(n) && store.scene8ClipReverbByLoopId.has(n)) {
    return { ...defaultClipReverbParams(), ...store.scene8ClipReverbByLoopId.get(n) };
  }
  return defaultClipReverbParams();
}

function setClipReverbParams(loopId, partial) {
  const cur = getClipReverbParams(loopId);
  const next = {
    decayStep: Math.max(1, Math.min(4, Math.floor(Number(partial.decayStep ?? cur.decayStep)) || 1)),
    roomStep: Math.max(1, Math.min(4, Math.floor(Number(partial.roomStep ?? cur.roomStep)) || 1)),
    preDelayStep: Math.max(1, Math.min(4, Math.floor(Number(partial.preDelayStep ?? cur.preDelayStep)) || 1)),
    mixStep: Math.max(1, Math.min(4, Math.floor(Number(partial.mixStep ?? cur.mixStep)) || 1)),
  };
  store.scene8ClipReverbByLoopId.set(String(loopId), next);
  if (Number.isFinite(Number(loopId))) store.scene8ClipReverbByLoopId.set(Number(loopId), next);
}

function updateScene8ReverbVoiceForLoop(loopId) {
  if (!store.pack || loopId == null) return;
  const params = getClipReverbParams(loopId);
  const sid = String(loopId);
  let playing = store.activeLoops.get(loopId);
  if (!playing && Number.isFinite(Number(loopId))) playing = store.activeLoops.get(Number(loopId));
  if (!playing) playing = store.activeLoops.get(sid);
  if (playing) applyClipReverbToVoice(playing, params);
  const os = getActiveOneShot(loopId);
  if (os) applyClipReverbToVoice(os, params);
}

function soleScene8SelectedClipLoopId() {
  if (store.scene8SelectedClipLoopIds.size !== 1) return null;
  return [...store.scene8SelectedClipLoopIds][0];
}

function refreshClipReverbLevelBadges() {
  if (!dom.grid) return;
  const def = defaultClipReverbParams();
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    const p = getClipReverbParams(lid);
    let badge = el.querySelector(".rev-lvl");
    if (
      p.decayStep === def.decayStep &&
      p.roomStep === def.roomStep &&
      p.preDelayStep === def.preDelayStep &&
      p.mixStep === def.mixStep
    ) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "rev-lvl";
      badge.setAttribute("aria-hidden", "true");
      const dly = el.querySelector(".dly-lvl");
      if (dly) dly.before(badge);
      else {
        const comp = el.querySelector(".comp-lvl");
        if (comp) comp.before(badge);
        else el.append(badge);
      }
    }
    badge.textContent = `D${p.decayStep} R${p.roomStep} P${p.preDelayStep} W${p.mixStep}`;
    badge.title = `Reverb · decay ${p.decayStep}/4 · room ${p.roomStep}/4 · pre-delay ${p.preDelayStep}/4 · wet ${p.mixStep}/4`;
  }
}

function applyScene8DecayStep(step) {
  applyScene8ReverbParamToSelection({ decayStep: step }, "decay");
}

function applyScene8RoomStep(step) {
  applyScene8ReverbParamToSelection({ roomStep: step }, "room");
}

function applyScene8PreDelayStep(step) {
  applyScene8ReverbParamToSelection({ preDelayStep: step }, "preDelay");
}

function applyScene8MixStep(step) {
  applyScene8ReverbParamToSelection({ mixStep: step }, "mix");
}

function applyScene8ReverbParamToSelection(partial, kind) {
  const s = Math.max(1, Math.min(4, Math.floor(Number(Object.values(partial)[0])) || 1));
  if (kind === "decay") {
    store.scene8DecayStepSelection = s;
    if (store.scene8SelectedClipLoopIds.size > 0) {
      for (const id of store.scene8SelectedClipLoopIds) {
        setClipReverbParams(id, partial);
        updateScene8ReverbVoiceForLoop(id);
      }
      if (store.scene8SelectedClipLoopIds.size === 1) store.scene8DecayStepSelection = null;
    }
  } else if (kind === "room") {
    store.scene8RoomStepSelection = s;
    if (store.scene8SelectedClipLoopIds.size > 0) {
      for (const id of store.scene8SelectedClipLoopIds) {
        setClipReverbParams(id, partial);
        updateScene8ReverbVoiceForLoop(id);
      }
      if (store.scene8SelectedClipLoopIds.size === 1) store.scene8RoomStepSelection = null;
    }
  } else if (kind === "preDelay") {
    store.scene8PreDelayStepSelection = s;
    if (store.scene8SelectedClipLoopIds.size > 0) {
      for (const id of store.scene8SelectedClipLoopIds) {
        setClipReverbParams(id, partial);
        updateScene8ReverbVoiceForLoop(id);
      }
      if (store.scene8SelectedClipLoopIds.size === 1) store.scene8PreDelayStepSelection = null;
    }
  } else if (kind === "mix") {
    store.scene8MixStepSelection = s;
    if (store.scene8SelectedClipLoopIds.size > 0) {
      for (const id of store.scene8SelectedClipLoopIds) {
        setClipReverbParams(id, partial);
        updateScene8ReverbVoiceForLoop(id);
      }
      if (store.scene8SelectedClipLoopIds.size === 1) store.scene8MixStepSelection = null;
    }
  }
  applyScene8ReverbMenuWebClasses();
  refreshClipReverbLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene8ReverbStripHardware();
    });
  }
}

function applyScene8StripG(dc) {
  if (dc <= 3) applyScene8DecayStep(dc + 1);
  else applyScene8RoomStep(dc - 3);
}

function applyScene8StripH(dc) {
  if (dc <= 3) applyScene8PreDelayStep(dc + 1);
  else applyScene8MixStep(dc - 3);
}

function toggleScene8ClipLoopSelection(loopId) {
  const sid = String(loopId);
  if (store.scene8SelectedClipLoopIds.has(sid)) store.scene8SelectedClipLoopIds.delete(sid);
  else {
    if (store.scene8SelectedClipLoopIds.size === 0) {
      store.scene8DecayStepSelection = null;
      store.scene8RoomStepSelection = null;
      store.scene8PreDelayStepSelection = null;
      store.scene8MixStepSelection = null;
    }
    store.scene8SelectedClipLoopIds.add(sid);
  }
  if (store.scene8SelectedClipLoopIds.size === 1) {
    store.scene8DecayStepSelection = null;
    store.scene8RoomStepSelection = null;
    store.scene8PreDelayStepSelection = null;
    store.scene8MixStepSelection = null;
  }
  applyScene8ReverbMenuWebClasses();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadScene8ReverbStripHardware();
    });
  }
}

function applyScene8ReverbMenuWebClasses() {
  if (!dom.grid) return;
  syncSidePanelLegendsWeb();
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-g8-volume-hold-strip="true"]')) {
    const nm = pad.querySelector(".nm");
    if (nm) nm.textContent = store.scene8ReverbMenuHeld ? "reverb ·" : pad.dataset.stripG8NmDefault ?? "volume";
    pad.classList.toggle("scene8-reverb-menu-held", store.scene8ReverbMenuHeld);
    pad.setAttribute("aria-pressed", store.scene8ReverbMenuHeld ? "true" : "false");
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]')) {
    if (pad.dataset.g8VolumeHoldStrip === "true") continue;
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (!nm || !Number.isFinite(dc)) continue;
    pad.classList.remove(
      "scene8-g-decay-zone",
      "scene8-g-room-zone",
      "scene8-g-strip-lit",
      "scene8-g-strip-step-apply",
      "scene8-g-strip-step-query",
    );
    if (!store.scene8ReverbMenuHeld) {
      const defaultNm = pad.dataset.stripGNmDefault ?? "mute col";
      nm.textContent = defaultNm;
      continue;
    }
    const isDecay = dc <= 3;
    pad.classList.add(isDecay ? "scene8-g-decay-zone" : "scene8-g-room-zone");
    nm.textContent = isDecay ? `decay ${dc + 1}` : `room ${dc - 3}`;
    const step = isDecay ? dc + 1 : dc - 3;
    const sole = soleScene8SelectedClipLoopId();
    const lit = sole != null && (isDecay ? getClipReverbParams(sole).decayStep === step : getClipReverbParams(sole).roomStep === step);
    const pending =
      (isDecay && store.scene8DecayStepSelection === step) ||
      (!isDecay && store.scene8RoomStepSelection === step);
    pad.classList.toggle("scene8-g-strip-lit", lit && !pending);
    pad.classList.toggle("scene8-g-strip-step-apply", pending && store.scene8SelectedClipLoopIds.size > 0);
    pad.classList.toggle("scene8-g-strip-step-query", pending && store.scene8SelectedClipLoopIds.size === 0);
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    if (pad.dataset.h8ClockMenuStrip === "true") continue;
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (!nm || !Number.isFinite(dc)) continue;
    pad.classList.remove(
      "scene8-h-predelay-zone",
      "scene8-h-wet-zone",
      "scene8-h-strip-lit",
      "scene8-h-strip-step-apply",
      "scene8-h-strip-step-query",
    );
    if (!store.scene8ReverbMenuHeld) {
      const defaultNm = pad.dataset.stripHNmDefault ?? "stop col";
      nm.textContent = defaultNm;
      continue;
    }
    const isPre = dc <= 3;
    pad.classList.add(isPre ? "scene8-h-predelay-zone" : "scene8-h-wet-zone");
    nm.textContent = isPre ? `pre ${dc + 1}` : `wet ${dc - 3}`;
    const step = isPre ? dc + 1 : dc - 3;
    const sole = soleScene8SelectedClipLoopId();
    const lit = sole != null && (isPre ? getClipReverbParams(sole).preDelayStep === step : getClipReverbParams(sole).mixStep === step);
    const pending =
      (isPre && store.scene8PreDelayStepSelection === step) ||
      (!isPre && store.scene8MixStepSelection === step);
    pad.classList.toggle("scene8-h-strip-lit", lit && !pending);
    pad.classList.toggle("scene8-h-strip-step-apply", pending && store.scene8SelectedClipLoopIds.size > 0);
    pad.classList.toggle("scene8-h-strip-step-query", pending && store.scene8SelectedClipLoopIds.size === 0);
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    el.classList.toggle(
      "scene8-clip-selected",
      store.scene8ReverbMenuHeld && store.scene8SelectedClipLoopIds.has(lid),
    );
    const p = getClipReverbParams(lid);
    const match =
      store.scene8ReverbMenuHeld &&
      store.scene8SelectedClipLoopIds.size === 0 &&
      ((store.scene8DecayStepSelection != null && p.decayStep === store.scene8DecayStepSelection) ||
        (store.scene8RoomStepSelection != null && p.roomStep === store.scene8RoomStepSelection) ||
        (store.scene8PreDelayStepSelection != null && p.preDelayStep === store.scene8PreDelayStepSelection) ||
        (store.scene8MixStepSelection != null && p.mixStep === store.scene8MixStepSelection));
    el.classList.toggle("scene8-clip-reverb-match", match);
  }
}

function clearScene8ReverbMenuWebClasses() {
  if (!dom.grid) return;
  for (const pad of dom.grid.querySelectorAll("button.pad.utility")) {
    pad.classList.remove(
      "scene8-reverb-menu-held",
      "scene8-g-decay-zone",
      "scene8-g-room-zone",
      "scene8-g-strip-lit",
      "scene8-g-strip-step-apply",
      "scene8-g-strip-step-query",
      "scene8-h-predelay-zone",
      "scene8-h-wet-zone",
      "scene8-h-strip-lit",
      "scene8-h-strip-step-apply",
      "scene8-h-strip-step-query",
    );
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    el.classList.remove("scene8-clip-selected", "scene8-clip-reverb-match");
  }
}

function refreshLaunchpadScene8ReverbStripHardware() {
  if (!store.midiAccess || !store.pack || !store.scene8ReverbMenuHeld) return;
  const sole = soleScene8SelectedClipLoopId() != null ? getClipReverbParams(soleScene8SelectedClipLoopId()) : null;
  for (let dc = 0; dc < 8; dc += 1) {
    const pkG = padKeyFromPhysicalCell(dc, 6);
    const isDecay = dc <= 3;
    let vG = isDecay ? LP_SESSION_SCENE8_REVERB_MENU.stripGDecay : LP_SESSION_SCENE8_REVERB_MENU.stripGRoom;
    const stepG = isDecay ? dc + 1 : dc - 3;
    const pendingG =
      (isDecay && store.scene8DecayStepSelection === stepG) ||
      (!isDecay && store.scene8RoomStepSelection === stepG);
    if (pendingG) {
      vG =
        store.scene8SelectedClipLoopIds.size > 0
          ? LP_SESSION_SCENE8_REVERB_MENU.stripStepApplyYellow
          : LP_SESSION_SCENE8_REVERB_MENU.stripStepQueryPurple;
    } else if (sole && (isDecay ? sole.decayStep === stepG : sole.roomStep === stepG)) {
      vG = isDecay
        ? LP_SESSION_SCENE8_REVERB_MENU.stripDecayLit[dc]
        : LP_SESSION_SCENE8_REVERB_MENU.stripRoomLit[dc - 4];
    }
    sendSessionPadLightingRowG(pkG, vG);
    const pkH = padKeyFromPhysicalCell(dc, 7);
    const isPre = dc <= 3;
    let vH = isPre ? LP_SESSION_SCENE8_REVERB_MENU.stripHPreDelay : LP_SESSION_SCENE8_REVERB_MENU.stripHWet;
    const stepH = isPre ? dc + 1 : dc - 3;
    const pendingH =
      (isPre && store.scene8PreDelayStepSelection === stepH) ||
      (!isPre && store.scene8MixStepSelection === stepH);
    if (pendingH) {
      vH =
        store.scene8SelectedClipLoopIds.size > 0
          ? LP_SESSION_SCENE8_REVERB_MENU.stripStepApplyYellow
          : LP_SESSION_SCENE8_REVERB_MENU.stripStepQueryPurple;
    } else if (sole && (isPre ? sole.preDelayStep === stepH : sole.mixStep === stepH)) {
      vH = isPre
        ? LP_SESSION_SCENE8_REVERB_MENU.stripPreDelayLit[dc]
        : LP_SESSION_SCENE8_REVERB_MENU.stripWetLit[dc - 4];
    }
    sendSessionPadLightingRowH(pkH, vH);
  }
}

function toggleScene8ReverbMenuLatch() {
  const next = !store.scene8ReverbMenuLatched;
  store.scene8ReverbMenuLatched = next;
  setScene8ReverbMenuHeld(next);
}

function releaseScene8ReverbMenuPointer() {
  if (!store.scene8ReverbMenuLatched) setScene8ReverbMenuHeld(false);
}

function setScene8ReverbMenuHeld(on) {
  if (!on) store.scene8ReverbMenuLatched = false;
  const wasHeld = store.scene8ReverbMenuHeld;
  if (on) {
    if (store.g7VolumeMenuHeld) setG7VolumeMenuHeld(false);
    if (store.g6StereoPanMenuHeld) setG6StereoPanMenuHeld(false);
    if (store.scene4EqMenuHeld) setScene4EqMenuHeld(false);
    if (store.scene5CompressorMenuHeld) setScene5CompressorMenuHeld(false);
    if (store.g4DistortionMenuHeld) setG4DistortionMenuHeld(false);
    if (store.scene7DelayMenuHeld) setScene7DelayMenuHeld(false);
    if (store.h8ClockStripMenuHeld) setH8ClockStripMenuHeld(false);
    clearHStopModifierPhysicalCols();
    if (store.clipKindLegendHeld) endClipKindLegendHold();
    if (store.clipTypeLegendHeld) endClipTypeLegendHold();
  }
  store.scene8ReverbMenuHeld = on;
  if (dom.grid) dom.grid.classList.toggle("scene8-reverb-menu-active", on);
  syncSidePanelLegendsWeb();
  if (on) {
    applyScene8ReverbMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshLaunchpadSessionClipPadsHardwareOnly();
        refreshLaunchpadScene8ReverbStripHardware();
      });
    }
  } else if (wasHeld) {
    store.scene8DecayStepSelection = null;
    store.scene8RoomStepSelection = null;
    store.scene8PreDelayStepSelection = null;
    store.scene8MixStepSelection = null;
    store.scene8SelectedClipLoopIds.clear();
    clearScene8ReverbMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshAllLaunchpadClipLeds();
        refreshLaunchpadSyncClockRowG(syncClockTickDisplayColumn8());
        refreshLaunchpadStripRowHIdleHardware();
      });
    }
  } else if (store.midiAccess) {
    refreshLaunchpadSceneSideCcLeds();
  }
}

function applyG7VolumeStep(step) {
  const s = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  store.g7VolumeStepSelection = s;
  if (store.g7SelectedClipLoopIds.size > 0) {
    for (const id of store.g7SelectedClipLoopIds) {
      store.g7ClipVolumeStepByLoopId.set(String(id), s);
      updateG7VoiceGainForLoop(id);
    }
    if (store.g7SelectedClipLoopIds.size === 1) store.g7VolumeStepSelection = null;
  }
  applyG7VolumeMenuWebClasses();
  refreshClipVolumeLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG7HStripHardware();
    });
  }
}

function toggleG7ClipLoopSelection(loopId) {
  const sid = String(loopId);
  if (store.g7SelectedClipLoopIds.has(sid)) store.g7SelectedClipLoopIds.delete(sid);
  else {
    if (store.g7SelectedClipLoopIds.size === 0 && store.g7VolumeStepSelection != null) {
      store.g7VolumeStepSelection = null;
    }
    store.g7SelectedClipLoopIds.add(sid);
  }
  if (store.g7SelectedClipLoopIds.size === 1) {
    store.g7VolumeStepSelection = null;
  }
  applyG7VolumeMenuWebClasses();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG7HStripHardware();
    });
  }
}

function applyG7VolumeMenuWebClasses() {
  if (!dom.grid) return;
  const soleId = soleG7SelectedClipLoopId();
  const soleStep = soleId != null ? getClipG7VolumeStep(soleId) : null;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-g8-volume-hold-strip="true"]')) {
    const nm = pad.querySelector(".nm");
    if (nm) nm.textContent = store.g7VolumeMenuHeld ? "volume ·" : pad.dataset.stripG8NmDefault ?? "volume";
    pad.classList.toggle("g8-volume-menu-held", store.g7VolumeMenuHeld);
    pad.setAttribute("aria-pressed", store.g7VolumeMenuHeld ? "true" : "false");
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    if (pad.dataset.h8ClockMenuStrip === "true") continue;
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (nm && Number.isFinite(dc)) {
      if (store.g7VolumeMenuHeld) nm.textContent = `${dc + 1}/8`;
      else if (pad.dataset.stripHNmDefault != null) nm.textContent = pad.dataset.stripHNmDefault;
    }
    const stepOnPad =
      store.g7VolumeMenuHeld && store.g7VolumeStepSelection != null && store.g7VolumeStepSelection === dc + 1;
    const isCurrent =
      store.g7VolumeMenuHeld && soleStep != null && soleStep === dc + 1 && !stepOnPad;
    pad.classList.toggle("g7-h-strip-step-apply", stepOnPad && store.g7SelectedClipLoopIds.size > 0);
    pad.classList.toggle("g7-h-strip-step-query", stepOnPad && store.g7SelectedClipLoopIds.size === 0);
    pad.classList.toggle("g7-h-strip-step-current", isCurrent);
    pad.classList.toggle("h8-volume-step-strip", store.g7VolumeMenuHeld && pad.dataset.h8ClockMenuStrip === "true");
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    el.classList.toggle("g7-clip-selected", store.g7VolumeMenuHeld && store.g7SelectedClipLoopIds.has(lid));
    const st = getClipG7VolumeStep(lid);
    const volumeMatch =
      store.g7VolumeMenuHeld &&
      store.g7VolumeStepSelection != null &&
      store.g7SelectedClipLoopIds.size === 0 &&
      st === store.g7VolumeStepSelection &&
      !store.g7SelectedClipLoopIds.has(lid);
    el.classList.toggle("g7-clip-volume-match", volumeMatch);
  }
}

function clearG7VolumeMenuWebClasses() {
  if (!dom.grid) return;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-g8-volume-hold-strip="true"]')) {
    const nm = pad.querySelector(".nm");
    if (nm && pad.dataset.stripG8NmDefault != null) nm.textContent = pad.dataset.stripG8NmDefault;
    pad.classList.remove("g8-volume-menu-held");
    pad.setAttribute("aria-pressed", "false");
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    const nm = pad.querySelector(".nm");
    if (nm && pad.dataset.stripHNmDefault != null) nm.textContent = pad.dataset.stripHNmDefault;
    pad.classList.remove(
      "g7-h-strip-step-apply",
      "g7-h-strip-step-query",
      "g7-h-strip-step-current",
      "h8-volume-step-strip",
    );
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    el.classList.remove("g7-clip-selected", "g7-clip-volume-match");
  }
}

function refreshLaunchpadG7HStripHardware() {
  if (!store.midiAccess || !store.pack || !store.g7VolumeMenuHeld) return;
  const soleStep =
    store.g7SelectedClipLoopIds.size === 1
      ? getClipG7VolumeStep(soleG7SelectedClipLoopId())
      : null;
  for (let dc = 0; dc < 8; dc += 1) {
    const pk = padKeyFromPhysicalCell(dc, 7);
    let v = LP_SESSION_G7_VOLUME_MENU.stripDark;
    const step = dc + 1;
    if (store.g7VolumeStepSelection != null && store.g7VolumeStepSelection === step) {
      v =
        store.g7SelectedClipLoopIds.size > 0
          ? LP_SESSION_G7_VOLUME_MENU.stripStepApplyYellow
          : LP_SESSION_G7_VOLUME_MENU.stripStepQueryPurple;
    } else if (soleStep != null && soleStep === step) {
      v = LP_SESSION_G7_VOLUME_MENU.stripStepCurrent;
    }
    sendSessionPadLightingRowH(pk, v);
  }
}

function getClipDistortionParams(loopId) {
  if (loopId == null) return defaultClipDistortionParams();
  const sid = String(loopId);
  if (store.g4ClipDistortionByLoopId.has(sid)) {
    return { ...defaultClipDistortionParams(), ...store.g4ClipDistortionByLoopId.get(sid) };
  }
  const n = Number(loopId);
  if (Number.isFinite(n) && store.g4ClipDistortionByLoopId.has(n)) {
    return { ...defaultClipDistortionParams(), ...store.g4ClipDistortionByLoopId.get(n) };
  }
  return defaultClipDistortionParams();
}

function setClipDistortionParams(loopId, partial) {
  const cur = getClipDistortionParams(loopId);
  const next = {
    drive: Math.max(1, Math.min(8, Math.floor(Number(partial.drive ?? cur.drive)) || 1)),
    oversample: Math.max(0, Math.min(2, Math.floor(Number(partial.oversample ?? cur.oversample)) || 0)),
    softClip: partial.softClip != null ? Boolean(partial.softClip) : cur.softClip,
    tone: Math.max(0, Math.min(4, Math.floor(Number(partial.tone ?? cur.tone)) || 0)),
  };
  store.g4ClipDistortionByLoopId.set(String(loopId), next);
  if (Number.isFinite(Number(loopId))) store.g4ClipDistortionByLoopId.set(Number(loopId), next);
}

function updateG4VoiceDistortionForLoop(loopId) {
  if (!store.pack || loopId == null) return;
  const params = getClipDistortionParams(loopId);
  const sid = String(loopId);
  let playing = store.activeLoops.get(loopId);
  if (!playing && Number.isFinite(Number(loopId))) playing = store.activeLoops.get(Number(loopId));
  if (!playing) playing = store.activeLoops.get(sid);
  if (playing) applyClipDistortionToVoice(playing, params);
  const os = getActiveOneShot(loopId);
  if (os) applyClipDistortionToVoice(os, params);
}

function soleG4SelectedClipLoopId() {
  if (store.g4SelectedClipLoopIds.size !== 1) return null;
  return [...store.g4SelectedClipLoopIds][0];
}

/** Soft vs hard clip for H4 UI / LEDs (pending when no clips, or unanimous selection). */
function getG4SoftClipUiState() {
  if (store.g4SelectedClipLoopIds.size === 0) {
    return { soft: store.g4DistortionSoftClipPending, mixed: false };
  }
  let soft = null;
  for (const id of store.g4SelectedClipLoopIds) {
    const s = getClipDistortionParams(id).softClip !== false;
    if (soft === null) soft = s;
    else if (soft !== s) return { soft: store.g4DistortionSoftClipPending, mixed: true };
  }
  return { soft: soft ?? true, mixed: false };
}

function allG4SelectedClipsHaveDrive(step) {
  if (store.g4SelectedClipLoopIds.size === 0) return false;
  for (const id of store.g4SelectedClipLoopIds) {
    if (getClipDistortionParams(id).drive !== step) return false;
  }
  return true;
}

function clipDistortionDriveLabel(step) {
  const n = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  return `D${n}`;
}

function refreshClipDistortionLevelBadges() {
  if (!dom.grid) return;
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    const p = getClipDistortionParams(lid);
    let badge = el.querySelector(".dist-lvl");
    if (p.drive <= 1 && p.tone <= 0 && p.oversample === 0) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "dist-lvl";
      badge.setAttribute("aria-hidden", "true");
      const vol = el.querySelector(".vol-lvl");
      if (vol) vol.before(badge);
      else el.append(badge);
    }
    const os = p.oversample === 1 ? "2×" : p.oversample === 2 ? "4×" : "";
    const clip = p.softClip !== false ? "Sf" : "Hd";
    const tone = p.tone > 0 ? `T${p.tone}` : "";
    badge.textContent = [clipDistortionDriveLabel(p.drive), os, clip, tone].filter(Boolean).join(" ");
    badge.title = `Distortion drive ${p.drive}/8 · ${os || "no OS"} · ${p.softClip ? "soft" : "hard"} clip · tone ${p.tone}/4`;
  }
}

function applyG4DistortionDriveStep(step) {
  const s = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  store.g4DistortionDriveStepSelection = s;
  if (store.g4SelectedClipLoopIds.size > 0) {
    for (const id of store.g4SelectedClipLoopIds) {
      setClipDistortionParams(id, { drive: s });
      updateG4VoiceDistortionForLoop(id);
    }
    if (store.g4SelectedClipLoopIds.size === 1) store.g4DistortionDriveStepSelection = null;
  }
  applyG4DistortionMenuWebClasses();
  refreshClipDistortionLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG4DistortionStripHardware();
    });
  }
}

function applyG4DistortionOversampleIndex(idx) {
  const os = Math.max(0, Math.min(2, Math.floor(Number(idx)) || 0));
  if (store.g4SelectedClipLoopIds.size > 0) {
    for (const id of store.g4SelectedClipLoopIds) {
      setClipDistortionParams(id, { oversample: os });
      updateG4VoiceDistortionForLoop(id);
    }
  }
  applyG4DistortionMenuWebClasses();
  refreshClipDistortionLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG4DistortionStripHardware();
    });
  }
}

function toggleG4DistortionSoftClipOnSelection() {
  if (store.g4SelectedClipLoopIds.size === 0) {
    store.g4DistortionSoftClipPending = !store.g4DistortionSoftClipPending;
    applyG4DistortionMenuWebClasses();
    if (store.midiAccess) queueMicrotask(() => refreshLaunchpadG4DistortionStripHardware());
    return;
  }
  const first = getClipDistortionParams([...store.g4SelectedClipLoopIds][0]);
  const next = !first.softClip;
  for (const id of store.g4SelectedClipLoopIds) {
    setClipDistortionParams(id, { softClip: next });
    updateG4VoiceDistortionForLoop(id);
  }
  store.g4DistortionSoftClipPending = next;
  applyG4DistortionMenuWebClasses();
  refreshClipDistortionLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG4DistortionStripHardware();
    });
  }
}

function applyG4DistortionToneLevel(level) {
  const t = Math.max(0, Math.min(4, Math.floor(Number(level)) || 0));
  if (store.g4SelectedClipLoopIds.size > 0) {
    for (const id of store.g4SelectedClipLoopIds) {
      setClipDistortionParams(id, { tone: t });
      updateG4VoiceDistortionForLoop(id);
    }
  }
  applyG4DistortionMenuWebClasses();
  refreshClipDistortionLevelBadges();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG4DistortionStripHardware();
    });
  }
}

function toggleG4ClipLoopSelection(loopId) {
  const sid = String(loopId);
  if (store.g4SelectedClipLoopIds.has(sid)) store.g4SelectedClipLoopIds.delete(sid);
  else {
    if (store.g4SelectedClipLoopIds.size === 0 && store.g4DistortionDriveStepSelection != null) {
      store.g4DistortionDriveStepSelection = null;
    }
    store.g4SelectedClipLoopIds.add(sid);
    if (!store.g4ClipDistortionByLoopId.has(sid)) {
      setClipDistortionParams(sid, { softClip: store.g4DistortionSoftClipPending });
    }
  }
  if (store.g4SelectedClipLoopIds.size === 1) store.g4DistortionDriveStepSelection = null;
  applyG4DistortionMenuWebClasses();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG4DistortionStripHardware();
    });
  }
}

function applyG4DistortionMenuWebClasses() {
  if (!dom.grid) return;
  syncSidePanelLegendsWeb();
  const soleId = soleG4SelectedClipLoopId();
  const soleDrive = soleId != null ? getClipDistortionParams(soleId).drive : null;
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]')) {
    if (pad.dataset.g8VolumeHoldStrip === "true") continue;
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (nm && Number.isFinite(dc)) {
      if (store.g4DistortionMenuHeld) nm.textContent = `${dc + 1}/8`;
      else if (pad.dataset.stripGNmDefault != null) nm.textContent = pad.dataset.stripGNmDefault;
    }
    pad.classList.toggle("g4-g-drive-strip", store.g4DistortionMenuHeld);
    pad.classList.remove("g4-g-strip-step-apply", "g4-g-strip-step-query", "g4-g-strip-step-current");
    if (!store.g4DistortionMenuHeld || !Number.isFinite(dc)) continue;
    const step = dc + 1;
    const stepOnPad =
      store.g4DistortionDriveStepSelection != null && store.g4DistortionDriveStepSelection === step;
    const isCurrent = !stepOnPad && allG4SelectedClipsHaveDrive(step);
    pad.classList.toggle("g4-g-strip-step-apply", stepOnPad && store.g4SelectedClipLoopIds.size > 0);
    pad.classList.toggle("g4-g-strip-step-query", stepOnPad && store.g4SelectedClipLoopIds.size === 0);
    pad.classList.toggle("g4-g-strip-step-current", isCurrent);
    if (nm && isCurrent) nm.textContent = `${step}/8 ·`;
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    const isH8 = pad.dataset.h8ClockMenuStrip === "true";
    if (!store.g4DistortionMenuHeld || !Number.isFinite(dc)) {
      pad.classList.remove(
        "g4-h-os-strip",
        "g4-h-clip-strip",
        "g4-h-tone-strip",
        "g4-h-strip-lit",
      );
      continue;
    }
    pad.classList.add("g4-h-os-strip", "g4-h-clip-strip", "g4-h-tone-strip");
    pad.classList.remove("g4-h-strip-lit", "g4-h-clip-soft-lit", "g4-h-clip-hard-lit");
    const sole = soleId != null ? getClipDistortionParams(soleId) : null;
    let lit = false;
    if (dc <= 2) {
      if (nm) nm.textContent = dc === 0 ? "OS·" : dc === 1 ? "2×" : "4×";
      lit = sole != null && sole.oversample === dc;
    } else if (dc === 3) {
      const { soft, mixed } = getG4SoftClipUiState();
      if (nm) nm.textContent = mixed ? "mix" : soft ? "soft" : "hard";
      pad.classList.toggle("g4-h-clip-soft-lit", !mixed && soft);
      pad.classList.toggle("g4-h-clip-hard-lit", !mixed && !soft);
      continue;
    } else if (dc >= 4 && dc <= 7) {
      const tone = dc - 3;
      if (nm) nm.textContent = `T${tone}`;
      lit = sole != null && sole.tone === tone;
    } else if (isH8 && nm) {
      nm.textContent = "T4";
      lit = sole != null && sole.tone === 4;
    }
    pad.classList.toggle("g4-h-strip-lit", lit);
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    el.classList.toggle("g4-clip-selected", store.g4DistortionMenuHeld && store.g4SelectedClipLoopIds.has(lid));
    const d = getClipDistortionParams(lid).drive;
    el.classList.toggle(
      "g4-clip-drive-match",
      store.g4DistortionMenuHeld &&
        store.g4DistortionDriveStepSelection != null &&
        store.g4SelectedClipLoopIds.size === 0 &&
        d === store.g4DistortionDriveStepSelection,
    );
  }
}

function clearG4DistortionMenuWebClasses() {
  if (!dom.grid) return;
  dom.grid.classList.remove("g4-distortion-menu-active");
  for (const pad of dom.grid.querySelectorAll("button.pad.utility")) {
    pad.classList.remove(
      "g4-g-drive-strip",
      "g4-g-strip-step-apply",
      "g4-g-strip-step-query",
      "g4-g-strip-step-current",
      "g4-h-os-strip",
      "g4-h-clip-strip",
      "g4-h-tone-strip",
      "g4-h-strip-lit",
      "g4-h-clip-soft-lit",
      "g4-h-clip-hard-lit",
    );
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    el.classList.remove("g4-clip-selected", "g4-clip-drive-match");
  }
}

function refreshLaunchpadG4DistortionStripHardware() {
  if (!store.midiAccess || !store.pack || !store.g4DistortionMenuHeld) return;
  const soleDrive =
    store.g4SelectedClipLoopIds.size === 1
      ? getClipDistortionParams(soleG4SelectedClipLoopId()).drive
      : null;
  const sole = soleG4SelectedClipLoopId() != null ? getClipDistortionParams(soleG4SelectedClipLoopId()) : null;
  for (let dc = 0; dc < 8; dc += 1) {
    const pkG = padKeyFromPhysicalCell(dc, 6);
    let vG = LP_SESSION_G4_DISTORTION_MENU.stripRowG;
    const stepG = dc + 1;
    if (store.g4DistortionDriveStepSelection != null && store.g4DistortionDriveStepSelection === stepG) {
      vG =
        store.g4SelectedClipLoopIds.size > 0
          ? LP_SESSION_G4_DISTORTION_MENU.stripStepApplyYellow
          : LP_SESSION_G4_DISTORTION_MENU.stripStepQueryPurple;
    } else if (soleDrive != null && soleDrive === stepG) {
      vG = LP_SESSION_G4_DISTORTION_MENU.stripStepCurrentG;
    }
    sendSessionPadLightingRowG(pkG, vG);
    const pkH = padKeyFromPhysicalCell(dc, 7);
    let vH = LP_SESSION_G4_DISTORTION_MENU.stripRowH;
    if (dc <= 2 && sole != null && sole.oversample === dc) {
      vH = [LP_SESSION_G4_DISTORTION_MENU.stripH1, LP_SESSION_G4_DISTORTION_MENU.stripH2, LP_SESSION_G4_DISTORTION_MENU.stripH3][dc];
    } else if (dc === 3) {
      const { soft } = getG4SoftClipUiState();
      vH = soft
        ? LP_SESSION_G4_DISTORTION_MENU.stripH4Soft
        : LP_SESSION_G4_DISTORTION_MENU.stripH4Hard;
    } else if (dc >= 4 && dc <= 7 && sole != null && sole.tone === dc - 3) {
      vH = LP_SESSION_G4_DISTORTION_MENU.stripTone[dc - 4];
    } else if (dc === 7 && sole != null && sole.tone === 4) {
      vH = LP_SESSION_G4_DISTORTION_MENU.stripTone[3];
    }
    sendSessionPadLightingRowH(pkH, vH);
  }
}

function toggleG4DistortionMenuLatch() {
  const next = !store.g4DistortionMenuLatched;
  store.g4DistortionMenuLatched = next;
  setG4DistortionMenuHeld(next);
}

function releaseG4DistortionMenuPointer() {
  if (!store.g4DistortionMenuLatched) setG4DistortionMenuHeld(false);
}

function refreshLaunchpadSceneSideCcLeds() {
  if (!store.midiAccess) return;
  const packNavV = Math.min(127, Math.max(0, MINI_MK3_PACK_NAV_LED_PALETTE));
  const maxScroll = store.pack?.sessionChannelsFull
    ? getSessionScrollMaxOffsetFromFull(store.pack.sessionChannelsFull)
    : 0;
  const off = store.pack?.sessionRowScrollOffset ?? 0;
  const upV = maxScroll > 0 && off > 0 ? packNavV : 0;
  const downV = maxScroll > 0 && off < maxScroll ? packNavV : 0;
  eachLaunchpadSessionLightOutput((output, name) => {
    if (!portLooksLikeNovationLaunchpad(name)) return;
    try {
      output.send(new Uint8Array([0xb0, MINI_MK3_ARROW_LEFT_CC & 0x7f, packNavV]));
      output.send(new Uint8Array([0xb0, MINI_MK3_ARROW_RIGHT_CC & 0x7f, packNavV]));
      output.send(new Uint8Array([0xb0, MINI_MK3_ARROW_UP_CC & 0x7f, upV]));
      output.send(new Uint8Array([0xb0, MINI_MK3_ARROW_DOWN_CC & 0x7f, downV]));
      const kindTopLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.clipKindLegendHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_CLIP_LEGEND_KIND_SCENE_IDLE_LED;
      const typeSceneLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.clipTypeLegendHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_CLIP_LEGEND_TYPE_SCENE_IDLE_LED;
      const stereoPanLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.g6StereoPanMenuHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_STEREO_PAN_IDLE_LED;
      const scene4EqLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.scene4EqMenuHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_SCENE4_EQ_SCENE_IDLE_LED;
      const scene5CompLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.scene5CompressorMenuHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_SCENE5_COMP_SCENE_IDLE_LED;
      const scene7DelayLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.scene7DelayMenuHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_SCENE7_DELAY_SCENE_IDLE_LED;
      const scene8ReverbLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.scene8ReverbMenuHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_SCENE8_REVERB_SCENE_IDLE_LED;
      const distortionLed =
        !store.pack || store.pack.nCols <= 0
          ? 0
          : store.g4DistortionMenuHeld
            ? LP_SESSION_PALETTE.armed
            : MINI_MK3_DISTORTION_SCENE_IDLE_LED;
      output.send(new Uint8Array([0xb0, MINI_MK3_CLIP_KIND_LEGEND_CC & 0x7f, kindTopLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_CLIP_TYPE_LEGEND_CC & 0x7f, typeSceneLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_STEREO_PAN_CC & 0x7f, stereoPanLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_SCENE4_EQ_CC & 0x7f, scene4EqLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_SCENE5_COMP_CC & 0x7f, scene5CompLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_SCENE7_DELAY_CC & 0x7f, scene7DelayLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_SCENE8_REVERB_CC & 0x7f, scene8ReverbLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_DISTORTION_CC & 0x7f, distortionLed]));
    } catch (err) {
      console.warn("Launchpad scene side CC LED failed:", name, err);
    }
  });
}

function setG4DistortionMenuHeld(on) {
  if (!on) store.g4DistortionMenuLatched = false;
  const wasHeld = store.g4DistortionMenuHeld;
  if (on) {
    if (store.g7VolumeMenuHeld) setG7VolumeMenuHeld(false);
    if (store.g6StereoPanMenuHeld) setG6StereoPanMenuHeld(false);
    if (store.scene4EqMenuHeld) setScene4EqMenuHeld(false);
    if (store.scene5CompressorMenuHeld) setScene5CompressorMenuHeld(false);
    if (store.scene7DelayMenuHeld) setScene7DelayMenuHeld(false);
    if (store.scene8ReverbMenuHeld) setScene8ReverbMenuHeld(false);
    if (store.h8ClockStripMenuHeld) setH8ClockStripMenuHeld(false);
    clearHStopModifierPhysicalCols();
    if (store.clipKindLegendHeld) endClipKindLegendHold();
    if (store.clipTypeLegendHeld) endClipTypeLegendHold();
  }
  store.g4DistortionMenuHeld = on;
  if (dom.grid) dom.grid.classList.toggle("g4-distortion-menu-active", on);
  syncSidePanelLegendsWeb();
  if (on) {
    applyG4DistortionMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshLaunchpadSessionClipPadsHardwareOnly();
        refreshLaunchpadG4DistortionStripHardware();
      });
    }
  } else if (wasHeld) {
    store.g4DistortionDriveStepSelection = null;
    store.g4SelectedClipLoopIds.clear();
    store.g4DistortionSoftClipPending = true;
    clearG4DistortionMenuWebClasses();
    if (store.midiAccess) {
      refreshLaunchpadSceneSideCcLeds();
      queueMicrotask(() => {
        refreshAllLaunchpadClipLeds();
        refreshLaunchpadSyncClockRowG(syncClockTickDisplayColumn8());
        refreshLaunchpadStripRowHIdleHardware();
      });
    }
  } else if (store.midiAccess) {
    refreshLaunchpadSceneSideCcLeds();
  }
}

/** Restore row **H** strip pad LEDs (`1H`…`8H`) after **8G** volume menu — clock refresh only updated **8H** before. */
function refreshLaunchpadStripRowHIdleHardware() {
  if (
    !store.midiAccess ||
    !store.pack ||
    store.g7VolumeMenuHeld ||
    store.g6StereoPanMenuHeld ||
    store.g4DistortionMenuHeld ||
    store.scene4EqMenuHeld ||
    store.scene5CompressorMenuHeld ||
    store.scene7DelayMenuHeld
  ) {
    return;
  }
  for (let dc = 0; dc < 8; dc += 1) {
    const pk = padKeyFromPhysicalCell(dc, 7);
    let v = isStripMuteStopInertAtPhysicalCol(dc) ? LP_SESSION_G_SYNC.col8Inert : LP_SESSION_STRIP_H_IDLE;
    if (!isStripMuteStopInertAtPhysicalCol(dc) && store.hStopModifierPhysicalCols.has(dc)) {
      v = LP_SESSION_H_STOP_MODIFIER;
    }
    sendSessionPadLightingRowH(pk, v);
  }
}

function soleG6SelectedClipLoopId() {
  if (store.g6SelectedClipLoopIds.size !== 1) return null;
  const id = [...store.g6SelectedClipLoopIds][0];
  return id == null ? null : String(id);
}

/** True when every selected clip shares this left strip step (L1…L8) — drives white strip LED on web + Launchpad. */
function allG6SelectedClipsHaveLeftStrip(step) {
  if (store.g6SelectedClipLoopIds.size === 0) return false;
  for (const id of store.g6SelectedClipLoopIds) {
    if (getClipLeftPanStripStep(id) !== step) return false;
  }
  return true;
}

/** True when every selected clip shares this right pan step (R0…R8). */
function allG6SelectedClipsHaveRightPan(step) {
  if (store.g6SelectedClipLoopIds.size === 0) return false;
  for (const id of store.g6SelectedClipLoopIds) {
    if (getClipRightPanStep(id) !== step) return false;
  }
  return true;
}

/** True when every selected clip shares this left strip step (L1…L8) — drives white strip LED on web + Launchpad. */

/** True when every selected clip shares this right pan step (R0…R8). */

function updateG6VoiceStereoPanForLoop(loopId) {
  updateG7VoiceGainForLoop(loopId);
}

function applyG6RightPanStep(step) {
  const r = clampPanStep(step);
  store.g6StereoPanStepSelection = "right";
  store.g6StereoPanStepValue = r;
  if (store.g6SelectedClipLoopIds.size > 0) {
    for (const id of store.g6SelectedClipLoopIds) {
      setClipRightPanStep(id, r);
      updateG6VoiceStereoPanForLoop(id);
    }
    clearG6StereoPanStepHighlight();
  }
  applyG6StereoPanMenuWebClasses();
  refreshClipPanBars();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG6StereoStripHardware();
    });
  }
}

function applyG6LeftPanStep(step) {
  const l = clampPanStep(step);
  store.g6StereoPanStepSelection = "left";
  store.g6StereoPanStepValue = l;
  if (store.g6SelectedClipLoopIds.size > 0) {
    for (const id of store.g6SelectedClipLoopIds) {
      setClipLeftPanStep(id, l);
      updateG6VoiceStereoPanForLoop(id);
    }
    clearG6StereoPanStepHighlight();
  }
  applyG6StereoPanMenuWebClasses();
  refreshClipPanBars();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG6StereoStripHardware();
    });
  }
}

function clearG6StereoPanStepHighlight() {
  store.g6StereoPanStepSelection = null;
  store.g6StereoPanStepValue = null;
}

function toggleG6ClipLoopSelection(loopId) {
  const sid = String(loopId);
  if (store.g6SelectedClipLoopIds.has(sid) && store.g6SelectedClipLoopIds.size === 1) {
    clearG6StereoPanStepHighlight();
    applyG6StereoPanMenuWebClasses();
    if (store.midiAccess) {
      queueMicrotask(() => {
        refreshLaunchpadSessionClipPadsHardwareOnly();
        refreshLaunchpadG6StereoStripHardware();
      });
    }
    return;
  }
  if (store.g6SelectedClipLoopIds.has(sid)) store.g6SelectedClipLoopIds.delete(sid);
  else {
    if (store.g6SelectedClipLoopIds.size === 0) clearG6StereoPanStepHighlight();
    store.g6SelectedClipLoopIds.add(sid);
  }
  if (store.g6SelectedClipLoopIds.size === 1) clearG6StereoPanStepHighlight();
  applyG6StereoPanMenuWebClasses();
  if (store.midiAccess) {
    queueMicrotask(() => {
      refreshLaunchpadSessionClipPadsHardwareOnly();
      refreshLaunchpadG6StereoStripHardware();
    });
  }
}

function syncSidePanelLegendsWeb() {
  if (!dom.grid) return;
  const kindBtn = dom.grid.querySelector('button.pad.side-panel[data-side-panel-kind="true"]');
  if (kindBtn) {
    const nm = kindBtn.querySelector(".nm");
    const label = kindBtn.dataset.sidePanelNmDefault ?? "kind";
    if (nm) nm.textContent = store.clipKindLegendHeld ? `${label} ·` : label;
    kindBtn.classList.toggle("clip-kind-legend-held", store.clipKindLegendHeld);
    kindBtn.classList.toggle("side-panel-kind-idle", !store.clipKindLegendHeld && !!store.pack);
    kindBtn.setAttribute("aria-pressed", store.clipKindLegendHeld ? "true" : "false");
  }
  const typeBtn = dom.grid.querySelector('button.pad.side-panel[data-side-panel-type="true"]');
  if (typeBtn) {
    const nm = typeBtn.querySelector(".nm");
    const label = typeBtn.dataset.sidePanelNmDefault ?? "type";
    if (nm) nm.textContent = store.clipTypeLegendHeld ? `${label} ·` : label;
    typeBtn.classList.toggle("clip-type-legend-held", store.clipTypeLegendHeld);
    typeBtn.classList.toggle("side-panel-type-idle", !store.clipTypeLegendHeld && !!store.pack);
    typeBtn.setAttribute("aria-pressed", store.clipTypeLegendHeld ? "true" : "false");
  }
  const panBtn = dom.grid.querySelector('button.pad.side-panel[data-side-panel-stereo="true"]');
  if (panBtn) {
    const nm = panBtn.querySelector(".nm");
    const label = panBtn.dataset.sidePanelNmDefault ?? "pan";
    if (nm) nm.textContent = store.g6StereoPanMenuHeld ? `${label} ·` : label;
    panBtn.classList.toggle("g6-stereo-menu-held", store.g6StereoPanMenuHeld);
    panBtn.classList.toggle("side-panel-stereo-idle", !store.g6StereoPanMenuHeld && !!store.pack);
    panBtn.setAttribute("aria-pressed", store.g6StereoPanMenuHeld ? "true" : "false");
  }
  const delayBtn = dom.grid.querySelector('button.pad.side-panel[data-side-panel-scene7-delay="true"]');
  if (delayBtn) {
    const nm = delayBtn.querySelector(".nm");
    const label = delayBtn.dataset.sidePanelNmDefault ?? "dly";
    if (nm) nm.textContent = store.scene7DelayMenuHeld ? `${label} ·` : label;
    delayBtn.classList.toggle("scene7-delay-menu-held", store.scene7DelayMenuHeld);
    delayBtn.classList.toggle("side-panel-scene7-delay-idle", !store.scene7DelayMenuHeld && !!store.pack);
    delayBtn.setAttribute("aria-pressed", store.scene7DelayMenuHeld ? "true" : "false");
  }
  const reverbBtn = dom.grid.querySelector('button.pad.side-panel[data-side-panel-scene8-reverb="true"]');
  if (reverbBtn) {
    const nm = reverbBtn.querySelector(".nm");
    const label = reverbBtn.dataset.sidePanelNmDefault ?? "rev";
    if (nm) nm.textContent = store.scene8ReverbMenuHeld ? `${label} ·` : label;
    reverbBtn.classList.toggle("scene8-reverb-menu-held", store.scene8ReverbMenuHeld);
    reverbBtn.classList.toggle("side-panel-scene8-reverb-idle", !store.scene8ReverbMenuHeld && !!store.pack);
    reverbBtn.setAttribute("aria-pressed", store.scene8ReverbMenuHeld ? "true" : "false");
  }
  const compBtn = dom.grid.querySelector('button.pad.side-panel[data-side-panel-scene5-comp="true"]');
  if (compBtn) {
    const nm = compBtn.querySelector(".nm");
    const label = compBtn.dataset.sidePanelNmDefault ?? "comp";
    if (nm) nm.textContent = store.scene5CompressorMenuHeld ? `${label} ·` : label;
    compBtn.classList.toggle("scene5-comp-menu-held", store.scene5CompressorMenuHeld);
    compBtn.classList.toggle("side-panel-scene5-comp-idle", !store.scene5CompressorMenuHeld && !!store.pack);
    compBtn.setAttribute("aria-pressed", store.scene5CompressorMenuHeld ? "true" : "false");
  }
  const eqBtn = dom.grid.querySelector('button.pad.side-panel[data-side-panel-scene4-eq="true"]');
  if (eqBtn) {
    const nm = eqBtn.querySelector(".nm");
    const label = eqBtn.dataset.sidePanelNmDefault ?? "eq";
    if (nm) nm.textContent = store.scene4EqMenuHeld ? `${label} ·` : label;
    eqBtn.classList.toggle("scene4-eq-menu-held", store.scene4EqMenuHeld);
    eqBtn.classList.toggle("side-panel-scene4-eq-idle", !store.scene4EqMenuHeld && !!store.pack);
    eqBtn.setAttribute("aria-pressed", store.scene4EqMenuHeld ? "true" : "false");
  }
  const distBtn = dom.grid.querySelector('button.pad.side-panel[data-side-panel-distortion="true"]');
  if (distBtn) {
    const nm = distBtn.querySelector(".nm");
    const label = distBtn.dataset.sidePanelNmDefault ?? "dist";
    if (nm) nm.textContent = store.g4DistortionMenuHeld ? `${label} ·` : label;
    distBtn.classList.toggle("g4-distortion-menu-held", store.g4DistortionMenuHeld);
    distBtn.classList.toggle("side-panel-distortion-idle", !store.g4DistortionMenuHeld && !!store.pack);
    distBtn.setAttribute("aria-pressed", store.g4DistortionMenuHeld ? "true" : "false");
  }
}

const WEB_MENU_HOLD_MS = 350;
const WEB_MENU_MOVE_PX = 8;

/**
 * Web menu buttons: hold = temporary (Launchpad-style); short click = latch open for multi-select with mouse.
 * @param {HTMLElement} el
 * @param {{ onPress: () => void, onRelease: () => void, onToggleLatch: () => void }} handlers
 */
function wireWebMenuHoldPad(el, { onPress, onRelease, onToggleLatch }) {
  let pointerId = null;
  let pressAt = 0;
  let startX = 0;
  let startY = 0;
  let suppressLatchClick = false;

  const release = (ev) => {
    if (ev?.pointerId != null && pointerId != null && ev.pointerId !== pointerId) return;
    const heldMs = performance.now() - pressAt;
    if (heldMs >= WEB_MENU_HOLD_MS) suppressLatchClick = true;
    pointerId = null;
    onRelease();
    if (ev?.pointerId != null) {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  el.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    pointerId = ev.pointerId;
    pressAt = performance.now();
    startX = ev.clientX;
    startY = ev.clientY;
    suppressLatchClick = false;
    onPress();
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    void (async () => {
      await ensureAudio();
      if (store.audioCtx?.state === "suspended") await store.audioCtx.resume();
    })();
  });
  el.addEventListener("pointermove", (ev) => {
    if (ev.pointerId !== pointerId) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (dx * dx + dy * dy > WEB_MENU_MOVE_PX * WEB_MENU_MOVE_PX) suppressLatchClick = true;
  });
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("lostpointercapture", (ev) => {
    if (pointerId != null) release(ev);
  });
  el.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (suppressLatchClick) {
      suppressLatchClick = false;
      return;
    }
    onToggleLatch();
  });
}

function appendSidePanelPad(rowIdx, rowLetter) {
  if (!dom.grid) return;
  const side = document.createElement("button");
  side.type = "button";
  side.className = "pad utility side-panel";
  side.dataset.sidePanelRow = String(rowIdx);
  side.style.gridColumn = "10";
  const nm = document.createElement("span");
  nm.className = "nm";
  if (rowIdx === SIDE_PANEL_KIND_ROW_IDX) {
    side.dataset.sidePanelKind = "true";
    nm.textContent = "kind";
    side.dataset.sidePanelNmDefault = "kind";
    side.title =
      "Hold or click to lock: kind / category colours on clip pads (Launchpad CC 89). Click again to exit.";
    side.classList.add("side-panel-kind-idle");
    wireWebMenuHoldPad(side, {
      onPress: () => startClipKindLegendHold(),
      onRelease: () => releaseClipKindLegendPointer(),
      onToggleLatch: () => toggleClipKindLegendLatch(),
    });
  } else if (rowIdx === SIDE_PANEL_TYPE_ROW_IDX) {
    side.dataset.sidePanelType = "true";
    nm.textContent = "type";
    side.dataset.sidePanelNmDefault = "type";
    side.title =
      "Hold or click to lock: loop type colours on clip pads (Launchpad CC 79). Click again to exit.";
    side.classList.add("side-panel-type-idle");
    wireWebMenuHoldPad(side, {
      onPress: () => startClipTypeLegendHold(),
      onRelease: () => releaseClipTypeLegendPointer(),
      onToggleLatch: () => toggleClipTypeLegendLatch(),
    });
  } else if (rowIdx === SIDE_PANEL_STEREO_ROW_IDX) {
    side.dataset.sidePanelStereo = "true";
    nm.textContent = "pan";
    side.dataset.sidePanelNmDefault = "pan";
    side.title =
      "Hold or click to lock: stereo pan (Launchpad CC 69). Select clips 1A…8F. Row G = left L1…L8, row H = right R1…R8 (L+R=8). Click pan again to exit.";
    side.classList.add("side-panel-stereo-idle");
    wireWebMenuHoldPad(side, {
      onPress: () => setG6StereoPanMenuHeld(true),
      onRelease: () => releaseG6StereoPanMenuPointer(),
      onToggleLatch: () => toggleG6StereoPanMenuLatch(),
    });
  } else if (rowIdx === SIDE_PANEL_SCENE5_COMP_ROW_IDX) {
    side.dataset.sidePanelScene5Comp = "true";
    nm.textContent = "comp";
    side.dataset.sidePanelNmDefault = "comp";
    side.title =
      "Hold or click to lock: compressor (Launchpad scene row 5 / CC 49). Select clips 1A…8F. Row G = threshold 1…8; H1–H4 = ratio, H5–H8 = makeup (after EQ, before distortion).";
    side.classList.add("side-panel-scene5-comp-idle");
    wireWebMenuHoldPad(side, {
      onPress: () => setScene5CompressorMenuHeld(true),
      onRelease: () => releaseScene5CompressorMenuPointer(),
      onToggleLatch: () => toggleScene5CompressorMenuLatch(),
    });
  } else if (rowIdx === SIDE_PANEL_SCENE4_EQ_ROW_IDX) {
    side.dataset.sidePanelScene4Eq = "true";
    nm.textContent = "eq";
    side.dataset.sidePanelNmDefault = "eq";
    side.title =
      "Hold or click to lock: spectrum EQ (Launchpad scene row 4 / CC 59). Select clips 1A…8F. Row G = high-pass 1/8…8/8, row H = low-pass 1/8…8/8 (before distortion).";
    side.classList.add("side-panel-scene4-eq-idle");
    wireWebMenuHoldPad(side, {
      onPress: () => setScene4EqMenuHeld(true),
      onRelease: () => releaseScene4EqMenuPointer(),
      onToggleLatch: () => toggleScene4EqMenuLatch(),
    });
  } else if (rowIdx === SIDE_PANEL_SCENE7_DELAY_ROW_IDX) {
    side.dataset.sidePanelScene7Delay = "true";
    nm.textContent = "dly";
    side.dataset.sidePanelNmDefault = "dly";
    side.title =
      "Hold or click to lock: delay (Launchpad scene row 7 / CC 29). Select clips 1A…8F. G1–G4 = time (blue), G5–G8 = feedback (red), H1–H4 = mix (purple), H5–H8 = tone (green). After distortion.";
    side.classList.add("side-panel-scene7-delay-idle");
    wireWebMenuHoldPad(side, {
      onPress: () => setScene7DelayMenuHeld(true),
      onRelease: () => releaseScene7DelayMenuPointer(),
      onToggleLatch: () => toggleScene7DelayMenuLatch(),
    });
  } else if (rowIdx === SIDE_PANEL_SCENE8_REVERB_ROW_IDX) {
    side.dataset.sidePanelScene8Reverb = "true";
    nm.textContent = "rev";
    side.dataset.sidePanelNmDefault = "rev";
    side.title =
      "Hold or click to lock: reverb (Launchpad scene row 8 / CC 19). Select clips 1A…8F. G1–G4 = decay (blue), G5–G8 = room (green), H1–H4 = pre-delay (yellow), H5–H8 = wet (purple). After delay.";
    side.classList.add("side-panel-scene8-reverb-idle");
    wireWebMenuHoldPad(side, {
      onPress: () => setScene8ReverbMenuHeld(true),
      onRelease: () => releaseScene8ReverbMenuPointer(),
      onToggleLatch: () => toggleScene8ReverbMenuLatch(),
    });
  } else if (rowIdx === SIDE_PANEL_DISTORTION_ROW_IDX) {
    side.dataset.sidePanelDistortion = "true";
    nm.textContent = "dist";
    side.dataset.sidePanelNmDefault = "dist";
    side.title =
      "Hold or click to lock: distortion (Launchpad scene row 6 / CC 39). Select clips 1A…8F. Row G = drive 1…8; row H: H1–H3 oversample, H4 soft/hard clip, H5–H8 tone filter.";
    side.classList.add("side-panel-distortion-idle");
    wireWebMenuHoldPad(side, {
      onPress: () => setG4DistortionMenuHeld(true),
      onRelease: () => releaseG4DistortionMenuPointer(),
      onToggleLatch: () => toggleG4DistortionMenuLatch(),
    });
  } else {
    side.disabled = true;
    side.classList.add("side-panel-inert");
    side.tabIndex = -1;
    nm.textContent = "";
    side.title = `${rowLetter} · side panel (not assigned)`;
  }
  side.append(nm);
  dom.grid.appendChild(side);
}

function applyG6StereoPanMenuWebClasses() {
  if (!dom.grid) return;
  syncSidePanelLegendsWeb();
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]')) {
    if (pad.dataset.g6StereoHoldStrip === "true") continue;
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    const isG8Vol = pad.dataset.g8VolumeHoldStrip === "true";
    if (nm && Number.isFinite(dc)) {
      if (store.g6StereoPanMenuHeld) nm.textContent = `L${panStepFromStripCol(dc)}`;
      else if (isG8Vol && pad.dataset.stripG8NmDefault != null) nm.textContent = pad.dataset.stripG8NmDefault;
      else if (pad.dataset.stripGNmDefault != null) nm.textContent = pad.dataset.stripGNmDefault;
    }
    pad.classList.toggle("g8-pan-step-strip", store.g6StereoPanMenuHeld && isG8Vol);
    pad.classList.remove("g6-g-strip-step-apply", "g6-g-strip-step-query", "g6-g-strip-step-current");
    if (!store.g6StereoPanMenuHeld || !Number.isFinite(dc)) continue;
    const step = panStepFromStripCol(dc);
    const stepOnPad =
      store.g6StereoPanStepSelection === "left" && store.g6StereoPanStepValue === step;
    const isCurrent = !stepOnPad && allG6SelectedClipsHaveLeftStrip(step);
    pad.classList.toggle("g6-g-strip-step-apply", stepOnPad && store.g6SelectedClipLoopIds.size > 0);
    pad.classList.toggle("g6-g-strip-step-query", stepOnPad && store.g6SelectedClipLoopIds.size === 0);
    pad.classList.toggle("g6-g-strip-step-current", isCurrent);
    if (nm && isCurrent) nm.textContent = `L${step} ·`;
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    const isH8Clock = pad.dataset.h8ClockMenuStrip === "true";
    const dc = Number(pad.dataset.displayCol);
    const nm = pad.querySelector(".nm");
    if (nm && Number.isFinite(dc)) {
      if (store.g6StereoPanMenuHeld) nm.textContent = `R${panStepFromStripCol(dc)}`;
      else if (pad.dataset.stripHNmDefault != null) nm.textContent = pad.dataset.stripHNmDefault;
    }
    pad.classList.toggle("h8-pan-step-strip", store.g6StereoPanMenuHeld && isH8Clock);
    pad.classList.toggle("h8-volume-step-strip", !store.g6StereoPanMenuHeld && isH8Clock && store.g7VolumeMenuHeld);
    pad.classList.remove("g6-h-strip-step-apply", "g6-h-strip-step-query", "g6-h-strip-step-current");
    if (!store.g6StereoPanMenuHeld || !Number.isFinite(dc)) continue;
    const step = panStepFromStripCol(dc);
    const stepOnPad =
      store.g6StereoPanStepSelection === "right" && store.g6StereoPanStepValue === step;
    const isCurrent = !stepOnPad && allG6SelectedClipsHaveRightPan(step);
    pad.classList.toggle("g6-h-strip-step-apply", stepOnPad && store.g6SelectedClipLoopIds.size > 0);
    pad.classList.toggle("g6-h-strip-step-query", stepOnPad && store.g6SelectedClipLoopIds.size === 0);
    pad.classList.toggle("g6-h-strip-step-current", isCurrent);
    if (nm && isCurrent) nm.textContent = `R${step} ·`;
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    const lid = el.dataset.loopId;
    if (!lid) continue;
    el.classList.toggle(
      "g6-clip-selected",
      store.g6StereoPanMenuHeld && store.g6SelectedClipLoopIds.has(String(lid))
    );
    const r = getClipRightPanStep(lid);
    const panMatch =
      store.g6StereoPanMenuHeld &&
      store.g6SelectedClipLoopIds.size === 0 &&
      store.g6StereoPanStepSelection != null &&
      store.g6StereoPanStepValue != null &&
      !store.g6SelectedClipLoopIds.has(lid) &&
      ((store.g6StereoPanStepSelection === "right" && r === store.g6StereoPanStepValue) ||
        (store.g6StereoPanStepSelection === "left" &&
          getClipLeftPanStripStep(lid) === store.g6StereoPanStepValue));
    el.classList.toggle("g6-clip-pan-match", panMatch);
  }
}

function clearG6StereoPanMenuWebClasses() {
  if (!dom.grid) return;
  syncSidePanelLegendsWeb();
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]')) {
    const nm = pad.querySelector(".nm");
    if (nm) {
      if (pad.dataset.g8VolumeHoldStrip === "true" && pad.dataset.stripG8NmDefault != null) {
        nm.textContent = pad.dataset.stripG8NmDefault;
      } else if (pad.dataset.stripGNmDefault != null) {
        nm.textContent = pad.dataset.stripGNmDefault;
      }
    }
    pad.classList.remove(
      "g6-g-strip-step-apply",
      "g6-g-strip-step-query",
      "g6-g-strip-step-current",
      "g8-pan-step-strip",
    );
  }
  for (const pad of dom.grid.querySelectorAll('button.pad.utility[data-utility-row="7"]')) {
    const nm = pad.querySelector(".nm");
    if (nm && pad.dataset.stripHNmDefault != null) nm.textContent = pad.dataset.stripHNmDefault;
    pad.classList.remove(
      "g6-h-strip-step-apply",
      "g6-h-strip-step-query",
      "g6-h-strip-step-current",
      "h8-pan-step-strip",
    );
  }
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    el.classList.remove("g6-clip-selected", "g6-clip-pan-match");
  }
}

function refreshLaunchpadG6StereoStripHardware() {
  if (!store.midiAccess || !store.pack || !store.g6StereoPanMenuHeld) return;
  const pal = LP_SESSION_G6_STEREO_MENU;
  for (let dc = 0; dc < 8; dc += 1) {
    const pkG = padKeyFromPhysicalCell(dc, 6);
    const pkH = padKeyFromPhysicalCell(dc, 7);
    let vG = pal.stripRowG;
    const stepL = panStepFromStripCol(dc);
    if (store.g6StereoPanStepSelection === "left" && store.g6StereoPanStepValue === stepL) {
      vG = store.g6SelectedClipLoopIds.size > 0 ? pal.stripStepApplyYellow : pal.stripStepQueryPurple;
    } else if (allG6SelectedClipsHaveLeftStrip(stepL)) {
      vG = pal.stripStepCurrentG;
    }
    sendSessionPadLightingRowG(pkG, vG);
    let vH = pal.stripRowH;
    const stepR = panStepFromStripCol(dc);
    if (store.g6StereoPanStepSelection === "right" && store.g6StereoPanStepValue === stepR) {
      vH = store.g6SelectedClipLoopIds.size > 0 ? pal.stripStepApplyYellow : pal.stripStepQueryPurple;
    } else if (allG6SelectedClipsHaveRightPan(stepR)) {
      vH = pal.stripStepCurrentH;
    }
    sendSessionPadLightingRowH(pkH, vH);
  }
}

function toggleG6StereoPanMenuLatch() {
  const next = !store.g6StereoPanMenuLatched;
  store.g6StereoPanMenuLatched = next;
  setG6StereoPanMenuHeld(next);
}

function releaseG6StereoPanMenuPointer() {
  if (!store.g6StereoPanMenuLatched) setG6StereoPanMenuHeld(false);
}

function toggleG7VolumeMenuLatch() {
  const next = !store.g7VolumeMenuLatched;
  store.g7VolumeMenuLatched = next;
  setG7VolumeMenuHeld(next);
}

function releaseG7VolumeMenuPointer() {
  if (!store.g7VolumeMenuLatched) setG7VolumeMenuHeld(false);
}

function toggleClipKindLegendLatch() {
  if (!store.pack) return;
  if (store.clipKindLegendLatched) {
    endClipKindLegendHold();
    return;
  }
  store.clipKindLegendLatched = true;
  startClipKindLegendHold();
}

function releaseClipKindLegendPointer() {
  if (!store.clipKindLegendLatched) endClipKindLegendHold();
}

function toggleClipTypeLegendLatch() {
  if (!store.pack) return;
  if (store.clipTypeLegendLatched) {
    endClipTypeLegendHold();
    return;
  }
  store.clipTypeLegendLatched = true;
  startClipTypeLegendHold();
}

function releaseClipTypeLegendPointer() {
  if (!store.clipTypeLegendLatched) endClipTypeLegendHold();
}

function setG6StereoPanMenuHeld(on) {
  if (!on) store.g6StereoPanMenuLatched = false;
  if (store.g6StereoPanMenuHeld === on) return;
  if (on) {
    if (store.g7VolumeMenuHeld) setG7VolumeMenuHeld(false);
    if (store.g4DistortionMenuHeld) setG4DistortionMenuHeld(false);
    if (store.scene4EqMenuHeld) setScene4EqMenuHeld(false);
    if (store.scene5CompressorMenuHeld) setScene5CompressorMenuHeld(false);
    if (store.scene7DelayMenuHeld) setScene7DelayMenuHeld(false);
    if (store.scene8ReverbMenuHeld) setScene8ReverbMenuHeld(false);
    if (store.h8ClockStripMenuHeld) setH8ClockStripMenuHeld(false);
    clearHStopModifierPhysicalCols();
  }
  store.g6StereoPanMenuHeld = on;
  if (dom.grid) dom.grid.classList.toggle("g6-stereo-menu-active", on);
  if (on) {
    if (store.clipKindLegendHeld) endClipKindLegendHold();
    if (store.clipTypeLegendHeld) endClipTypeLegendHold();
    applyG6StereoPanMenuWebClasses();
    if (store.midiAccess) {
      queueMicrotask(() => {
        refreshLaunchpadMiniMk3PackNavLeds();
        refreshLaunchpadSessionClipPadsHardwareOnly();
        refreshLaunchpadG6StereoStripHardware();
      });
    }
  } else {
    store.g6StereoPanStepSelection = null;
    store.g6StereoPanStepValue = null;
    store.g6SelectedClipLoopIds.clear();
    clearG6StereoPanMenuWebClasses();
    if (store.midiAccess) {
      queueMicrotask(() => {
        refreshLaunchpadMiniMk3PackNavLeds();
        refreshAllLaunchpadClipLeds();
        refreshLaunchpadSyncClockRowG(syncClockTickDisplayColumn8());
        refreshLaunchpadStripRowHIdleHardware();
      });
    }
  }
}

function setG7VolumeMenuHeld(on) {
  if (!on) store.g7VolumeMenuLatched = false;
  if (store.g7VolumeMenuHeld === on) return;
  if (on) {
    if (store.g6StereoPanMenuHeld) setG6StereoPanMenuHeld(false);
    if (store.g4DistortionMenuHeld) setG4DistortionMenuHeld(false);
    if (store.scene4EqMenuHeld) setScene4EqMenuHeld(false);
    if (store.scene5CompressorMenuHeld) setScene5CompressorMenuHeld(false);
    if (store.scene7DelayMenuHeld) setScene7DelayMenuHeld(false);
    if (store.scene8ReverbMenuHeld) setScene8ReverbMenuHeld(false);
    if (store.h8ClockStripMenuHeld) setH8ClockStripMenuHeld(false);
  }
  if (on) clearHStopModifierPhysicalCols();
  store.g7VolumeMenuHeld = on;
  if (dom.grid) dom.grid.classList.toggle("g7-volume-menu-active", on);
  if (on) {
    applyG7VolumeMenuWebClasses();
    if (store.midiAccess) {
      queueMicrotask(() => {
        refreshLaunchpadSessionClipPadsHardwareOnly();
        refreshLaunchpadG7HStripHardware();
      });
    }
  } else {
    store.g7VolumeStepSelection = null;
    store.g7SelectedClipLoopIds.clear();
    clearG7VolumeMenuWebClasses();
    if (store.midiAccess) {
      queueMicrotask(() => {
        refreshAllLaunchpadClipLeds();
        refreshLaunchpadStripRowHIdleHardware();
      });
    }
  }
}

function refreshLaunchpadCol8ClockTickMenuOverlay() {
  if (!store.midiAccess || !store.pack || !store.h8ClockStripMenuHeld) return;
  const ticks = getSyncLoopTicks();
  const selPk = syncLoopTicksToPadKey(ticks);
  for (const pk of SYNC_LOOP_TICK_PAD_KEYS) {
    const v = pk === selPk ? LP_SESSION_COL8_H8_MENU.rowSelected : LP_SESSION_COL8_H8_MENU.rowDim;
    sendSessionPadLighting(pk, v);
  }
}

function quantIntervalSeconds(syncTo, tempo) {
  const beat = secondsPerBeat(tempo);
  if (syncTo === "beat") return beat;
  return 4 * beat;
}

/** Next strictly future grid time (AudioContext time), aligned to transport origin. */
function nextQuantizedAudioTime(ctxNow, tempo, syncTo) {
  const q = quantIntervalSeconds(syncTo || "bar", tempo);
  if (!(q > 0) || !Number.isFinite(q)) return ctxNow + 0.002;
  ensureTransportOrigin(store.audioCtx);
  const o = store.transportOriginAudioSec;
  if (!Number.isFinite(o)) return ctxNow + q;
  let k = Math.floor((ctxNow - o) / q + 1e-9);
  let t = o + (k + 1) * q;
  while (t <= ctxNow + 0.002) {
    k += 1;
    t = o + (k + 1) * q;
  }
  return Number.isFinite(t) ? t : ctxNow + q;
}

/** Next audio time on `patternLength` loop: step **loopDur × (purple ticks ÷ 8)** (`getSyncLoopTicks()` = 1, 2, 4, 8, or 16). */
function nextPatternQuantizedAudioTime(ctxNow) {
  if (!store.pack || !store.audioCtx) return ctxNow;
  const tickN = Number(getSyncLoopTicks());
  if (!(tickN > 0)) return ctxNow;
  const loopDur = patternLoopDurationSeconds(store.pack.tempo, store.pack.patternLength);
  if (!(loopDur > 0) || !Number.isFinite(loopDur)) return ctxNow;
  const q = loopDur * (tickN / 8);
  if (!(q > 0) || !Number.isFinite(q)) return ctxNow;
  ensureTransportOrigin(store.audioCtx);
  const o = syncBarClockOriginSec();
  if (o == null || !Number.isFinite(o)) return ctxNow;
  let k = Math.floor((ctxNow - o) / q + 1e-9);
  let t = o + (k + 1) * q;
  while (t <= ctxNow + 0.002) {
    k += 1;
    t = o + (k + 1) * q;
  }
  return Number.isFinite(t) ? t : ctxNow;
}

function syncBarClockOriginSec() {
  if (Number.isFinite(store.transportOriginAudioSec)) return store.transportOriginAudioSec;
  if (Number.isFinite(store.audioBarClockOriginSec)) return store.audioBarClockOriginSec;
  return null;
}

/**
 * Pattern-loop phase → physical column 0…7 for `1G`…`8G` purple tick (visual reference).
 * Eight steps per loop. Bar-sync clip snap uses `nextPatternQuantizedAudioTime` (**1** / **2** / **4** / **8** / **16** purple ticks per snap + **0** immediate).
 */
function syncClockTickDisplayColumn8() {
  if (!store.pack || !store.audioCtx) return -1;
  const origin = syncBarClockOriginSec();
  if (origin == null) return -1;
  const loopDur = patternLoopDurationSeconds(store.pack.tempo, store.pack.patternLength);
  if (loopDur <= 0) return -1;
  const tickCount = getVisualClockStripTicks();
  if (tickCount <= 0) return -1;
  const now = store.audioCtx.currentTime;
  const t = ((now - origin) % loopDur + loopDur) % loopDur;
  const substep = Math.min(tickCount - 1, Math.floor((t / loopDur) * tickCount + 1e-9));
  return Math.min(7, Math.floor((substep * 8) / tickCount));
}

function refreshLaunchpadSyncClockRowG(tickDisplayCol) {
  if (!store.midiAccess) return;
  if (store.scene8ReverbMenuHeld) {
    refreshLaunchpadScene8ReverbStripHardware();
    refreshLaunchpadSessionClipPadsHardwareOnly();
    return;
  }
  if (store.scene7DelayMenuHeld) {
    refreshLaunchpadScene7DelayStripHardware();
    refreshLaunchpadSessionClipPadsHardwareOnly();
    return;
  }
  if (store.scene5CompressorMenuHeld) {
    refreshLaunchpadScene5CompStripHardware();
    refreshLaunchpadSessionClipPadsHardwareOnly();
    return;
  }
  if (store.scene4EqMenuHeld) {
    refreshLaunchpadScene4EqStripHardware();
    refreshLaunchpadSessionClipPadsHardwareOnly();
    return;
  }
  if (store.g4DistortionMenuHeld) {
    refreshLaunchpadG4DistortionStripHardware();
    refreshLaunchpadSessionClipPadsHardwareOnly();
    return;
  }
  if (store.g6StereoPanMenuHeld) {
    refreshLaunchpadG6StereoStripHardware();
    refreshLaunchpadSessionClipPadsHardwareOnly();
    return;
  }
  for (let dc = 0; dc < 8; dc += 1) {
    const padKey = padKeyFromPhysicalCell(dc, 6);
    const v =
      tickDisplayCol >= 0 && dc === tickDisplayCol
        ? LP_SESSION_G_SYNC.tick
        : isStripMuteStopInertAtPhysicalCol(dc)
          ? LP_SESSION_G_SYNC.col8Inert
          : LP_SESSION_G_SYNC.lit;
    sendSessionPadLightingRowG(padKey, v);
  }
  refreshLaunchpadSessionClipPadsHardwareOnly();
  if (store.h8ClockStripMenuHeld) refreshLaunchpadCol8ClockTickMenuOverlay();
  if (store.g7VolumeMenuHeld) refreshLaunchpadG7HStripHardware();
  else if (store.g4DistortionMenuHeld) refreshLaunchpadG4DistortionStripHardware();
  else refreshLaunchpadStripRowHIdleHardware();
}

function updateWebSyncClockRowG(tickCol) {
  if (
    !dom.grid ||
    store.g6StereoPanMenuHeld ||
    store.g4DistortionMenuHeld ||
    store.scene4EqMenuHeld ||
    store.scene5CompressorMenuHeld ||
    store.scene7DelayMenuHeld ||
    store.scene8ReverbMenuHeld
  ) {
    return;
  }
  const pads = dom.grid.querySelectorAll('button.pad.utility[data-utility-row="6"]');
  for (const pad of pads) {
    const dc = Number(pad.dataset.displayCol);
    pad.classList.toggle("sync-clock-tick", Number.isFinite(dc) && tickCol >= 0 && dc === tickCol);
  }
}

function syncClockAnimatorFrame() {
  if (!store.pack || !store.audioCtx) {
    store.syncClockLoopActive = false;
    return;
  }
  const col = syncClockTickDisplayColumn8();
  if (col !== store.lastSyncClockGColumn) {
    store.lastSyncClockGColumn = col;
    updateWebSyncClockRowG(col);
    if (store.midiAccess) refreshLaunchpadSyncClockRowG(col);
  }
  requestAnimationFrame(syncClockAnimatorFrame);
}

function ensureSyncClockAnimator() {
  if (!store.pack || !store.audioCtx) return;
  if (store.syncClockLoopActive) return;
  store.syncClockLoopActive = true;
  requestAnimationFrame(syncClockAnimatorFrame);
}

function clearRemotePackSource() {
  store.remotePackJsonUrl = null;
  store.remotePackBaseUrl = null;
  store.remoteCatalogUrl = null;
  store.remoteCatalogEntries = null;
}

function clearRemoteCatalog() {
  store.remoteCatalogUrl = null;
  store.remoteCatalogEntries = null;
  syncAssetSourceRemotePanel();
}

/** @param {{ slug: string, title: string, packJsonUrl?: string|null }[]} options */
function rebuildPackSelect(options) {
  if (!dom.pack) return;
  dom.pack.replaceChildren();
  for (const p of options) {
    const o = document.createElement("option");
    o.value = p.slug;
    o.textContent = p.title;
    dom.pack.appendChild(o);
  }
}

function persistSamplePackSlug(slug) {
  if (!slug) return;
  try {
    localStorage.setItem(SAMPLE_PACK_SLUG_STORAGE_KEY, slug);
  } catch {
    /* ignore */
  }
}

function savedSamplePackSlug() {
  try {
    const s = localStorage.getItem(SAMPLE_PACK_SLUG_STORAGE_KEY);
    return s && typeof s === "string" ? s.trim() : null;
  } catch {
    return null;
  }
}

function fillPackSelectLocal() {
  rebuildPackSelect(SAMPLE_PACKS);
  const saved = savedSamplePackSlug();
  const slug =
    SAMPLE_PACKS.some((p) => p.slug === saved) ? saved
    : SAMPLE_PACKS.some((p) => p.slug === store.currentPackSlug) ? store.currentPackSlug
    : SAMPLE_PACKS[0].slug;
  dom.pack.value = slug;
  store.currentPackSlug = slug;
}

function fillPackSelectNovationProxy() {
  rebuildPackSelect(NOVATION_SAMPLE_PACKS);
  const slug =
    NOVATION_SAMPLE_PACKS.some((p) => p.slug === store.currentPackSlug) ?
      store.currentPackSlug
    : NOVATION_SAMPLE_PACKS[0].slug;
  dom.pack.value = slug;
  store.currentPackSlug = slug;
}

function fillPackSelectForAssetSource() {
  if (getAssetSource() === "proxy") fillPackSelectNovationProxy();
  else fillPackSelectLocal();
}

/** @param {import('./pack-catalog.js').PackCatalogEntry[]} entries */
function applyRemoteCatalogToPackSelect(entries, preferredSlug) {
  rebuildPackSelect(entries);
  const slug =
    preferredSlug && entries.some((e) => e.slug === preferredSlug) ?
      preferredSlug
    : entries[0]?.slug;
  if (slug && dom.pack) dom.pack.value = slug;
  syncAssetSourceRemotePanel();
}

/**
 * Novation Arcade packs use loop.url like packs/<slug>/file.wav relative to the CDN (or /novation/) root,
 * not relative to pack.json’s directory.
 * @param {string|null|undefined} packJsonUrl
 * @returns {string|null} trailing slash
 */
function arcadeAudioBaseSlash(packJsonUrl) {
  if (!packJsonUrl) return null;
  try {
    const pageHref = typeof location !== "undefined" ? location.href : undefined;
    const u = new URL(packJsonUrl, pageHref);
    if (!/\/packs\/[^/]+\/pack\.json$/i.test(u.pathname)) return null;
    if (u.hostname === "intro.novationmusic.com") {
      return `${u.origin}/`;
    }
    const idx = u.pathname.indexOf("/novation/packs/");
    if (idx >= 0) {
      return `${u.origin}${u.pathname.slice(0, idx + "/novation/".length)}`;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function packAssetBaseSlash() {
  if (getAssetSource() === "local") {
    const base = assetBase();
    return base.endsWith("/") ? base : `${base}/`;
  }
  const arcade = arcadeAudioBaseSlash(store.remotePackJsonUrl);
  if (arcade) return arcade.endsWith("/") ? arcade : `${arcade}/`;
  if (store.remotePackBaseUrl) {
    const b = store.remotePackBaseUrl;
    return b.endsWith("/") ? b : `${b}/`;
  }
  const base = assetBase();
  return base.endsWith("/") ? base : `${base}/`;
}

function packUrl(slug) {
  const enc = encodeURIComponent(slug);
  const baseSlash = packAssetBaseSlash();
  if (getAssetSource() === "proxy") {
    return `${baseSlash}packs/${enc}/pack.json`;
  }
  return `${baseSlash}${enc}/pack.json`;
}

function absoluteUrl(relativeFromPack) {
  const raw = String(relativeFromPack || "").trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^ftp:\/\//i.test(raw)) {
    throw new Error(
      "loop.url uses ftp:// — browsers cannot fetch FTP. Use http(s) URLs in pack.json or host files on the web.",
    );
  }
  let rel = raw.replace(/^\//, "");
  const baseSlash = packAssetBaseSlash();
  // Custom URL / catalog: base is the pack folder (…/freesound-loops/), but loop.url still
  // includes the slug (freesound-loops/Drums/…). Strip duplicate slug — not a CORS issue.
  if (
    getAssetSource() === "remote" &&
    store.remotePackBaseUrl &&
    store.currentPackSlug
  ) {
    const slugPrefix = `${store.currentPackSlug}/`;
    if (rel.startsWith(slugPrefix)) rel = rel.slice(slugPrefix.length);
  }
  if (!rel) return baseSlash;
  return baseSlash + rel.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

function dbToLinear(dbStr) {
  const n = Number(dbStr);
  if (Number.isFinite(n)) return Math.pow(10, n / 20);
  return 1;
}

function buildPackState(slug, json) {
  const byId = new Map(json.loops.map((l) => [String(l.loopId), l]));
  const rawChannels = json.session.channels || [];
  const nCols = rawChannels.length;
  const sessionChannelsFull = rawChannels.map((col) => (Array.isArray(col) ? [...col] : []));
  let nSessionRowsFull = 0;
  for (const col of sessionChannelsFull) {
    nSessionRowsFull = Math.max(nSessionRowsFull, col.length);
  }
  const sessionRowScrollOffset = 0;
  const channels =
    nCols > 0
      ? buildVisibleSessionSlice(sessionChannelsFull, sessionRowScrollOffset, nCols)
      : [];
  const nRows = nCols > 0 ? LAUNCHPAD_CLIP_SESSION_ROW_COUNT : 0;
  return {
    slug,
    title: json.session.title ?? slug,
    tempo: json.session.tempo ?? 120,
    patternLength: json.session.patternLength ?? 16,
    channels,
    nCols,
    nRows,
    sessionChannelsFull,
    nSessionRowsFull,
    sessionRowScrollOffset,
    byId,
    raw: json,
  };
}

async function loadPack(slug) {
  const url = packUrl(slug);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`pack ${res.status}: ${url}`);
  const json = await res.json();
  return buildPackState(slug, json);
}

async function loadPackFromUrl(packJsonUrl) {
  const url = resolvePackJsonUrl(packJsonUrl, typeof location !== "undefined" ? location.href : "");
  const res = await fetch(url, { cache: "no-store", mode: "cors" });
  if (!res.ok) {
    throw new Error(`pack ${res.status}: ${url}${packLoadStatusHint(res.status, url)}`);
  }
  const json = await res.json();
  const slug = slugHintFromPackJsonUrl(url);
  return { state: buildPackState(slug, json), packJsonUrl: url };
}

/**
 * After `store.pack.channels` changes (session row scroll), move each playing voice’s `anchorPadKey` to the
 * pad that now shows that `loopId`. Clears anchor when the loop is off the visible A–F window so
 * stale pads are not lit as “playing”.
 */
function refreshPlaybackAnchorPadKeysAfterSessionScroll() {
  if (!store.pack) return;
  for (const [id, pl] of store.activeLoops.entries()) {
    if (!pl) continue;
    const pk = padKeyForLoopId(id) ?? anchorClipPadKeyFromChannels(id);
    pl.anchorPadKey = pk ?? null;
  }
  for (const [id, os] of store.activeOneShots.entries()) {
    if (!os) continue;
    const pk = padKeyForLoopId(id) ?? anchorClipPadKeyFromChannels(id);
    os.anchorPadKey = pk ?? null;
  }
}

/** Align web clip window with hardware after connect (hardware row offset may be non-zero). */
function resetSessionRowScrollToZero() {
  if (!store.pack?.sessionChannelsFull || store.pack.nCols <= 0) return;
  if ((store.pack.sessionRowScrollOffset ?? 0) === 0) return;
  store.pack.sessionRowScrollOffset = 0;
  store.pack.channels = buildVisibleSessionSlice(store.pack.sessionChannelsFull, 0, store.pack.nCols);
  refreshPlaybackAnchorPadKeysAfterSessionScroll();
  renderGrid(store.pack);
  maybeRefreshClipLegendAfterChannelsChange();
}

/** Avoid stale row/col flip or scroll on phone after desktop use. */
function prepareMobileMidiSession() {
  if (!isMobileSessionHost()) return;
  resetSessionRowScrollToZero();
  if (dom.gridFlip && dom.gridFlip.value !== "none") {
    dom.gridFlip.value = "none";
    try {
      localStorage.setItem(GRID_FLIP_STORAGE_KEY, "none");
    } catch {
      /* ignore */
    }
    if (store.pack) renderGrid(store.pack);
  }
}

/** Avoid stale row/col flip or scroll on phone after desktop use. */

/** Align web clip window with hardware after connect (hardware row offset may be non-zero). */

/** Vertical scroll through `session.channels` when taller than six clip rows (A–F). */
function applySessionRowScroll(delta) {
  if (!store.pack?.sessionChannelsFull || store.pack.nCols <= 0) return;
  const now = Date.now();
  if (now - lastSessionRowScrollAt < 80) return;
  const maxOff = getSessionScrollMaxOffsetFromFull(store.pack.sessionChannelsFull);
  const cur = store.pack.sessionRowScrollOffset ?? 0;
  const next = Math.max(0, Math.min(maxOff, cur + delta));
  if (next === cur) return;
  lastSessionRowScrollAt = now;
  store.pack.sessionRowScrollOffset = next;
  store.pack.channels = buildVisibleSessionSlice(store.pack.sessionChannelsFull, next, store.pack.nCols);
  refreshPlaybackAnchorPadKeysAfterSessionScroll();
  renderGrid(store.pack);
  maybeRefreshClipLegendAfterChannelsChange();
  preloadPackLoops(store.pack).catch(() => {});
}

function padKeyFromNote(note, midiInputPortName = "") {
  const noteStr = String(note);
  const classicPad = resolveClassicSessionPadKey(note);
  const modernPad = noteToPadModern[noteStr] ?? null;
  if (dom.midiSysex?.checked && isMobileSessionHost()) {
    return resolveMobileSessionPadKey(Number(note), classicPad, modernPad);
  }
  if (usesClassicSessionNoteMap(midiInputPortName)) {
    return classicPad ?? modernPad;
  }
  if (classicPad && modernPad && classicPad !== modernPad) {
    if (store.pack) {
      const cLoop = getLoopIdForSessionClipPadOrScan(classicPad);
      const mLoop = getLoopIdForSessionClipPadOrScan(modernPad);
      if (mLoop != null && cLoop == null) return modernPad;
      if (cLoop != null && mLoop == null) return classicPad;
    }
    if (dom.midiSysex?.checked) return classicPad;
  }
  return modernPad ?? classicPad;
}

function sessionNoteMapDebugExtra(note, padKey) {
  const direct = noteToPadClassic[String(note)] ?? null;
  if (!isMobileSessionHost() || !dom.midiSysex?.checked || !direct || direct === padKey) {
    return null;
  }
  const parts = [`raw classic ${direct} → ${padKey}`];
  const bumped = note + 16 <= 127 ? noteToPadClassic[String(note + 16)] ?? null : null;
  if (bumped && bumped === padKey && bumped !== direct) {
    parts.push(` (mobile +16 fix from note ${note + 16})`);
  }
  const modernRaw = noteToPadModern[String(note)] ?? null;
  if (modernRaw && modernRaw !== direct && modernRaw === padKey) {
    parts.push(` (mobile modern note ${note})`);
  }
  return parts.length > 1 ? parts.join("") : null;
}

function padDecodeNoteMapHint(note, midiInputPortName = "") {
  if (usesClassicSessionNoteMap(midiInputPortName)) {
    return /\bdaw\b/i.test(midiInputPortName || "")
      ? "Classic Session notes (DAW port)"
      : "Classic layout map";
  }
  if (dom.midiSysex?.checked && isMobileSessionHost()) {
    return "Classic Session notes (mobile DAW SysEx)";
  }
  return "Modern (Arcade) notes";
}

function parsePadKey(padKey) {
  if (!padKey || padKey.length < 2) return null;
  const colDigit = Number(padKey[0]);
  const rowLetter = padKey[1];
  if (!Number.isFinite(colDigit) || colDigit < 1 || colDigit > 8) return null;
  const col = colDigit - 1;
  const rowIdx = rowLetter.charCodeAt(0) - 65;
  if (rowIdx < 0 || rowIdx > 7) return null;
  return { col, rowIdx };
}

/** Physical column index 0–7 + row letter index 0–7 → `1A`…`8H` (same as MIDI padKey). */
function padKeyFromPhysicalCell(col, rowIdx) {
  return `${col + 1}${String.fromCharCode(65 + rowIdx)}`;
}

/**
 * Map Arcade pad position → pack.session.channels[col][sessionRow].
 * Matches Novation `cr` / `sr`: digit = column 1–8, letter = row index (A=0 … H=7).
 * **Only rows A–F** map to clips; **G/H** are the mute/stop strip on hardware and are never read from `channels` here.
 */
function padKeyToSessionCell(padKey, nRows) {
  const p = parsePadKey(padKey);
  if (!p || p.rowIdx > LAUNCHPAD_CLIP_SESSION_MAX_ROW) return null;
  if (p.rowIdx >= nRows) return null;
  return { col: p.col, sessionRow: p.rowIdx };
}

function getLoopIdForPad(padKey) {
  if (!store.pack) return null;
  const cell = padKeyToSessionCell(padKey, store.pack.nRows);
  if (!cell) return null;
  const { col, sessionRow } = applySessionGridFlip(
    cell.col,
    cell.sessionRow,
    store.pack.nCols,
    store.pack.nRows,
  );
  if (col >= store.pack.nCols || sessionRow >= store.pack.nRows) return null;
  const slot = store.pack.channels[col][sessionRow];
  return slot?.loopId ?? null;
}

/**
 * Resolve `loopId` for a Session clip pad (`1A`…`8F`): `getLoopIdForPad`, then scan pack slots whose
 * displayed pad key matches (covers grid-flip cases where the primary path returns null).
 */
function getLoopIdForSessionClipPadOrScan(padKey) {
  const direct = getLoopIdForPad(padKey);
  if (direct != null) return direct;
  if (!store.pack || !padKey) return null;
  for (let pc = 0; pc < store.pack.nCols; pc += 1) {
    const row = store.pack.channels[pc];
    if (!row) continue;
    for (let r = 0; r < store.pack.nRows; r += 1) {
      const pk = padKeyForPackCell(pc, r);
      if (pk !== padKey) continue;
      return row[r]?.loopId ?? null;
    }
  }
  return null;
}

/** Stop clip playback for this Session pad: pack `loopId` plus any active voice with `anchorPadKey === padKey`. */
function stopClipPlaybackForSessionPadKey(padKey) {
  if (!store.pack || !padKey) return;
  const lid = getLoopIdForSessionClipPadOrScan(padKey);
  if (lid != null) stopLoop(lid);
  for (const id of [...store.activeOneShots.keys()]) {
    if (store.activeOneShots.get(id)?.anchorPadKey === padKey) stopLoop(id);
  }
  for (const id of [...store.activeLoops.keys()]) {
    if (store.activeLoops.get(id)?.anchorPadKey === padKey) stopLoop(id);
  }
}

/** Every clip row on this physical Session column (`1`…`8` → `physicalCol` 0…7): stops pack id + anchored voices. */
function stopClipPlaybackForPhysicalSessionColumn(physicalCol) {
  if (physicalCol == null || physicalCol < 0 || !store.pack) return;
  const maxR = Math.min(store.pack.nRows - 1, LAUNCHPAD_CLIP_SESSION_MAX_ROW);
  for (let r = 0; r <= maxR; r += 1) {
    stopClipPlaybackForSessionPadKey(padKeyFromPhysicalCell(physicalCol, r));
  }
}

async function ensureAudio() {
  const ctx = await ensureMasterBus();
  if (store.audioBarClockOriginSec == null) store.audioBarClockOriginSec = ctx.currentTime;
  ensureSyncClockAnimator();
  return ctx;
}

async function getBuffer(loop) {
  const key = loopAudioCacheKey(loop);
  if (store.bufferCache.has(key)) return store.bufferCache.get(key);
  const ctx = await ensureAudio();
  const wavUrl = absoluteUrl(loop.url);
  const res = await fetch(wavUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`wav ${res.status}: ${wavUrl}`);
  const arr = await res.arrayBuffer();
  const buf = await ctx.decodeAudioData(arr.slice(0));
  store.bufferCache.set(key, buf);
  rememberLoopChannelCount(loop, buf.numberOfChannels);
  return buf;
}

async function preloadPackLoops(packState, loadToken = store.packLoadToken) {
  store.bufferCache.clear();
  store.loopChannelCountByUrl.clear();
  const top = packState.raw.loops.slice(0, 12);
  await Promise.all(
    top.map(async (l) => {
      if (loadToken !== store.packLoadToken) return null;
      return getBuffer(l).catch(() => null);
    }),
  );
}

/** Fire-and-forget sample with playing LED until `onended` (not in `store.activeLoops`). */
async function playOneShotSample(loopId, velocity = 1, anchorPadKeyOpt = null) {
  if (!store.pack || !store.audioCtx || !store.masterGain) return;
  const loop = store.pack.byId.get(String(loopId));
  if (!loop) return;
  stopLoop(loopId);
  const sid = String(loopId);
  const myGen = (store.oneShotPlayGenerationByLoopId.get(sid) ?? 0) + 1;
  store.oneShotPlayGenerationByLoopId.set(sid, myGen);
  const anchorPadKey =
    anchorPadKeyOpt ?? padKeyForLoopId(loopId) ?? anchorClipPadKeyFromChannels(loopId);
  const ap = anchorPadKey ? parsePadKey(anchorPadKey) : null;
  const buf = await getBuffer(loop);
  if (store.oneShotPlayGenerationByLoopId.get(sid) !== myGen) return;
  const velN = Math.max(0.05, Math.min(1, velocity / 127));
  const src = store.audioCtx.createBufferSource();
  src.buffer = buf;
  const playing = wireStereoVoice(src, loopId, velN, loop);
  playing.anchorPadKey = anchorPadKey;
  setActiveOneShot(loopId, playing);
  setPadDomActive(loopId, true);
  src.onended = () => {
    disconnectVoiceNodes(playing);
    const cur = getActiveOneShot(loopId);
    if (cur !== playing) {
      return;
    }
    deleteActiveOneShot(loopId);
    setPadDomActive(loopId, false);
  };
  src.start(0);
}

function getActiveLoopPlaying(loopId) {
  let playing = store.activeLoops.get(loopId);
  if (!playing) playing = store.activeLoops.get(String(loopId));
  if (!playing && Number.isFinite(Number(loopId))) playing = store.activeLoops.get(Number(loopId));
  return playing;
}

function clearPendingQuantizedStopTimer(playing) {
  if (playing?.pendingStopTimer != null) {
    clearTimeout(playing.pendingStopTimer);
    playing.pendingStopTimer = null;
  }
}

function cancelQuantizedStop(loopId) {
  if (!store.pendingQuantizedStopLoopIds.has(String(loopId))) return false;
  clearPendingQuantizedStopTimer(getActiveLoopPlaying(loopId));
  setPadPendingOff(loopId, false);
  return true;
}

function finalizeQuantizedLoopStop(loopId, playing) {
  clearPendingQuantizedStopTimer(playing);
  disconnectVoiceNodes(playing);
  const pl = getActiveLoopPlaying(loopId);
  if (pl !== playing) return;
  for (const k of [...store.activeLoops.keys()]) {
    if (String(k) === String(loopId)) store.activeLoops.delete(k);
  }
  setPadDomActive(loopId, false);
  setPadPendingOff(loopId, false);
}

function stopLoop(loopId) {
  if (mapHasLoopId(store.pendingLoopStartTimers, loopId)) {
    clearPendingLoopStartTimerIds(loopId);
    setPadArmed(loopId, false);
  }
  let cleared = false;
  const os = getActiveOneShot(loopId);
  if (os) {
    disconnectVoiceNodes(os);
    deleteActiveOneShot(loopId);
    bumpOneShotPlayGeneration(loopId);
    cleared = true;
  }
  const playing = getActiveLoopPlaying(loopId);
  if (playing) {
    clearPendingQuantizedStopTimer(playing);
    disconnectVoiceNodes(playing);
    for (const k of [...store.activeLoops.keys()]) {
      if (String(k) === String(loopId)) store.activeLoops.delete(k);
    }
    cleared = true;
  }
  if (cleared) {
    setPadDomActive(loopId, false);
    setPadPendingOff(loopId, false);
  }
}

function scheduleQuantizedStop(loopId, syncTo) {
  const playing = getActiveLoopPlaying(loopId);
  if (!playing || !store.audioCtx || !store.pack) return;
  const st = syncTo || "bar";
  const tickGrid = getSyncLoopTicks();
  if (st === "bar" && tickGrid === 0) {
    stopLoop(loopId);
    return;
  }
  const t =
    st === "bar" && tickGrid > 0
      ? nextPatternQuantizedAudioTime(store.audioCtx.currentTime)
      : nextQuantizedAudioTime(store.audioCtx.currentTime, store.pack.tempo, st);
  setPadPendingOff(loopId, true);
  clearPendingQuantizedStopTimer(playing);
  const delayMs = Math.max(0, (t - store.audioCtx.currentTime) * 1000);
  playing.pendingStopTimer = window.setTimeout(() => {
    playing.pendingStopTimer = null;
    if (!mapHasLoopId(store.activeLoops, loopId)) return;
    const pl = getActiveLoopPlaying(loopId);
    if (pl !== playing) return;
    try {
      playing.source.stop();
    } catch {
      finalizeQuantizedLoopStop(loopId, playing);
      return;
    }
    playing.source.onended = () => finalizeQuantizedLoopStop(loopId, playing);
  }, delayMs);
}

async function startLoopAtTime(loopId, velocity, startWhen, anchorPadKeyOpt = null) {
  if (!store.pack || !store.audioCtx || !store.masterGain) return;
  const loop = store.pack.byId.get(String(loopId));
  if (!loop) return;
  stopLoop(loopId);
  const anchorPadKey =
    anchorPadKeyOpt ?? padKeyForLoopId(loopId) ?? anchorClipPadKeyFromChannels(loopId);
  const ap = anchorPadKey ? parsePadKey(anchorPadKey) : null;
  const buf = await getBuffer(loop);
  const velN = Math.max(0.05, Math.min(1, velocity / 127));
  const src = store.audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = buf.duration;
  const playing = wireStereoVoice(src, loopId, velN, loop);
  playing.anchorPadKey = anchorPadKey;
  const startT = Number.isFinite(startWhen) ? startWhen : store.audioCtx.currentTime;
  src.start(startT);
  store.activeLoops.set(loopId, playing);
  setPadDomActive(loopId, true);
  src.onended = () => {
    disconnectVoiceNodes(playing);
    let pl = store.activeLoops.get(loopId);
    if (!pl) pl = store.activeLoops.get(String(loopId));
    if (!pl && Number.isFinite(Number(loopId))) pl = store.activeLoops.get(Number(loopId));
    if (pl !== playing) return;
    for (const k of [...store.activeLoops.keys()]) {
      if (String(k) === String(loopId)) store.activeLoops.delete(k);
    }
    setPadDomActive(loopId, false);
    setPadPendingOff(loopId, false);
  };
}

async function startMomentaryColumn8Playback(loopId, velocity = 1, originPk = null) {
  if (!store.pack || !store.audioCtx || !store.masterGain) return;
  const loop = store.pack.byId.get(String(loopId));
  if (!loop) return;
  const pk = originPk ?? padKeyForLoopId(loopId);
  if (!pk || !isMomentaryColumn8ClipPadKey(pk)) return;
  stopLoop(loopId);
  const isLoop = loop.type === "loop" || loop.padData?.pad?.trigger?.type === "loop";
  if (isLoop) {
    await startLoopAtTime(loopId, velocity, store.audioCtx.currentTime, pk);
  } else {
    await playOneShotSample(loopId, velocity, pk);
  }
}

async function triggerLoop(loopId, velocity = 1, originPadKey = null) {
  if (!store.pack || !store.audioCtx || !store.masterGain) return;
  const loop = store.pack.byId.get(String(loopId));
  if (!loop) return;

  const pk = originPadKey ?? padKeyForLoopId(loopId);
  if (pk && isOneShotColumn7ClipPadKey(pk)) {
    await playOneShotSample(loopId, velocity, pk);
    return;
  }
  if (pk && isMomentaryColumn8ClipPadKey(pk)) {
    await startMomentaryColumn8Playback(loopId, velocity, pk);
    return;
  }

  const isLoop = loop.type === "loop" || loop.padData?.pad?.trigger?.type === "loop";
  const syncTo = isLoop ? effectiveLoopTriggerSync(loop, pk, loopId) : null;
  const hadPendingArm = isLoop && mapHasLoopId(store.pendingLoopStartTimers, loopId);
  const hadActiveLoop = isLoop && mapHasLoopId(store.activeLoops, loopId);
  if (
    !hadPendingArm &&
    !hadActiveLoop &&
    shouldDebounceClipTrigger(loopId, pk)
  ) {
    return;
  }

  if (isLoop && hadActiveLoop) {
    if (store.pendingQuantizedStopLoopIds.has(String(loopId))) {
      cancelQuantizedStop(loopId);
      return;
    }
    if (syncTo === "bar" || syncTo === "beat") {
      scheduleQuantizedStop(loopId, syncTo);
    } else {
      stopLoop(loopId);
      setPadDomActive(loopId, false);
    }
    return;
  }

  if (hadPendingArm) {
    clearPendingLoopStartTimerIds(loopId);
    setPadArmed(loopId, false);
    return;
  }

  if (!isLoop) {
    await playOneShotSample(loopId, velocity, pk);
    return;
  }

  if (syncTo === "bar" || syncTo === "beat") {
    ensureTransportOrigin(store.audioCtx);
    let t;
    if (syncTo === "bar") {
      const tickGrid = getSyncLoopTicks();
      if (tickGrid === 0) {
        t = store.audioCtx.currentTime;
      } else {
        t = nextPatternQuantizedAudioTime(store.audioCtx.currentTime);
      }
    } else {
      t = nextQuantizedAudioTime(store.audioCtx.currentTime, store.pack.tempo, syncTo);
    }
    const delayMs = Math.max(0, (t - store.audioCtx.currentTime) * 1000);
    clearPendingLoopStartTimerIds(loopId);
    const tid = window.setTimeout(() => {
      clearPendingLoopStartTimerIds(loopId);
      setPadArmed(loopId, false);
      const startAt = Math.max(store.audioCtx.currentTime, t);
      startLoopAtTime(loopId, velocity, startAt, pk).catch((e) => console.warn(e));
    }, delayMs);
    store.pendingLoopStartTimers.set(loopId, tid);
    store.pendingLoopStartTimers.set(String(loopId), tid);
    if (Number.isFinite(Number(loopId))) store.pendingLoopStartTimers.set(Number(loopId), tid);
    setPadArmed(loopId, true);
    return;
  }

  await startLoopAtTime(loopId, velocity, store.audioCtx.currentTime, pk);
}

function stopAllLoops() {
  setH8ClockStripMenuHeld(false);
  setG7VolumeMenuHeld(false);
  setG6StereoPanMenuHeld(false);
  setG4DistortionMenuHeld(false);
  setG6StereoPanMenuHeld(false);
  for (const [id, tid] of [...store.pendingLoopStartTimers.entries()]) {
    clearTimeout(tid);
    setPadArmed(id, false);
  }
  store.pendingLoopStartTimers.clear();
  store.pendingQuantizedStopLoopIds.clear();
  store.mutedColumns.clear();
  store.mutedPhysicalSessionCols.clear();
  clearOneShotPlayGenerations();
  for (const id of [...store.activeLoops.keys()]) {
    const playing = store.activeLoops.get(id);
    if (!playing) continue;
    clearPendingQuantizedStopTimer(playing);
    disconnectVoiceNodes(playing);
    store.activeLoops.delete(id);
    setPadDomActive(id, false);
    setPadPendingOff(id, false);
  }
  for (const id of [...store.activeOneShots.keys()]) {
    const os = store.activeOneShots.get(id);
    if (!os) continue;
    disconnectVoiceNodes(os);
    store.activeOneShots.delete(id);
    setPadDomActive(id, false);
  }
}

function clearPendingArmsInColumn(logicalCol) {
  if (!store.pack) return;
  const colSlots = store.pack.channels[logicalCol];
  if (!colSlots) return;
  for (let r = 0; r < store.pack.nRows; r += 1) {
    const loopId = colSlots[r]?.loopId;
    if (loopId == null) continue;
    const tid =
      store.pendingLoopStartTimers.get(loopId) ??
      store.pendingLoopStartTimers.get(String(loopId)) ??
      (Number.isFinite(Number(loopId)) ? store.pendingLoopStartTimers.get(Number(loopId)) : undefined);
    if (tid == null) continue;
    clearTimeout(tid);
    store.pendingLoopStartTimers.delete(loopId);
    store.pendingLoopStartTimers.delete(String(loopId));
    if (Number.isFinite(Number(loopId))) store.pendingLoopStartTimers.delete(Number(loopId));
    setPadArmed(loopId, false);
  }
}

/** Re-apply clip pad classes after `renderGrid` rebuilds the DOM (flip / row order). */
function syncPlaybackPadClasses() {
  for (const el of dom.grid.querySelectorAll("button.pad[data-loop-id]")) {
    el.classList.remove("active", "armed", "pending-off");
  }
  for (const loopId of store.activeLoops.keys()) {
    const cell = padEl(loopId);
    if (cell) cell.classList.add("active");
  }
  for (const loopId of store.activeOneShots.keys()) {
    const cell = padEl(loopId);
    if (cell) cell.classList.add("active");
  }
  for (const loopId of store.pendingLoopStartTimers.keys()) {
    const cell = padEl(loopId);
    if (cell) cell.classList.add("armed");
  }
  for (const id of store.pendingQuantizedStopLoopIds) {
    const el = padEl(id);
    if (el) el.classList.add("pending-off");
  }
  applyColumnMuteWebPadClasses();
  refreshAllLaunchpadClipLeds();
  if (store.h8ClockStripMenuHeld) applyH8ClockStripMenuWebClasses();
  if (store.g7VolumeMenuHeld) applyG7VolumeMenuWebClasses();
  if (store.g6StereoPanMenuHeld) applyG6StereoPanMenuWebClasses();
  if (store.scene4EqMenuHeld) applyScene4EqMenuWebClasses();
  if (store.scene5CompressorMenuHeld) applyScene5CompressorMenuWebClasses();
  if (store.scene7DelayMenuHeld) applyScene7DelayMenuWebClasses();
  if (store.scene8ReverbMenuHeld) applyScene8ReverbMenuWebClasses();
  if (store.g4DistortionMenuHeld) applyG4DistortionMenuWebClasses();
  if (store.clipKindLegendHeld || store.clipTypeLegendHeld) syncClipLegendWebStyling();
  refreshClipVolumeLevelBadges();
  refreshClipPanBars();
  refreshClipSpectrumEqLevelBadges();
  refreshClipCompressorLevelBadges();
  refreshClipDelayLevelBadges();
  refreshClipReverbLevelBadges();
  refreshClipDistortionLevelBadges();
  refreshClipChannelBadges();
}

function renderGrid(packState) {
  clearHStopModifierPhysicalCols();
  if (!dom.grid || !dom.cols || !packState) return;
  setG7VolumeMenuHeld(false);
  setG6StereoPanMenuHeld(false);
  setG4DistortionMenuHeld(false);
  setScene7DelayMenuHeld(false);
  setScene8ReverbMenuHeld(false);
  setH8ClockStripMenuHeld(false);
  dom.grid.innerHTML = "";
  dom.cols.innerHTML = buildColLabelsHtml(packState);
  wireColLabelScrollButtons();

  const { nCols, nRows } = packState;
  /** Launchpad Session clip area is 8 columns; keep DOM columns aligned with header 1…8. */
  const CLIP_GRID_COLS = 8;
  const rowOrder = CLIP_GRID_ROW_ORDER_PACK;

  const placePadColumn = (el, dc) => {
    el.style.gridColumn = String(dc + 2);
  };

  for (const rowIdx of rowOrder) {
    const rowLetter = String.fromCharCode(65 + rowIdx);
    const rl = document.createElement("div");
    rl.className = "grid-row-label";
    rl.textContent = rowLetter;
    rl.style.gridColumn = "1";
    dom.grid.appendChild(rl);

    const isArcadeStrip = rowIdx === 6 || rowIdx === 7;

    if (isArcadeStrip) {
      for (let dc = 0; dc < CLIP_GRID_COLS; dc += 1) {
        /* Row G/H spans the full 8 Session columns on hardware. Narrow packs (nCols under 8) must still render 8G and 8H (dc 7), not empty holes. */
        if (dc >= nCols && !isStripMuteStopInertAtPhysicalCol(dc)) {
          const hole = document.createElement("div");
          hole.className = "pad slot-empty";
          placePadColumn(hole, dc);
          dom.grid.appendChild(hole);
          continue;
        }
        const logicalCol =
          dc < nCols ? logicalColForPadCol(dc, nCols) : Math.max(0, nCols - 1);
        const pad = document.createElement("button");
        pad.type = "button";
        pad.className = "pad utility";
        pad.dataset.utilityRow = String(rowIdx);
        pad.dataset.displayCol = String(dc);
        pad.dataset.logicalCol = String(logicalCol);
        pad.dataset.padKey = padKeyFromPhysicalCell(dc, rowIdx);
        placePadColumn(pad, dc);
        const nm = document.createElement("span");
        nm.className = "nm";
        const isG8VolumeHoldStripPad = rowIdx === 6 && isStripMuteStopInertAtPhysicalCol(dc);
        const isH8ClockStripPad = isStripMuteStopInertAtPhysicalCol(dc) && rowIdx === 7;
        if (isG8VolumeHoldStripPad) {
          pad.dataset.g8VolumeHoldStrip = "true";
          nm.textContent = "volume";
          pad.dataset.stripG8NmDefault = "volume";
          pad.title =
            "Hold or click to lock volume — row H shows 1/8…8/8 (8H = max). Tap clips 1A…8F to select. Click volume again to exit. One clip: H shows its level (blue). Several: tap H (yellow) to set.";
          wireWebMenuHoldPad(pad, {
            onPress: () => {
              if (store.scene8ReverbMenuHeld) {
                applyScene8DecayStep(4);
                applyScene8RoomStep(4);
                return;
              }
              if (store.scene7DelayMenuHeld) {
                applyScene7TimeStep(4);
                applyScene7FeedbackStep(4);
                return;
              }
              if (store.scene5CompressorMenuHeld) {
                applyScene5ThresholdStep(8);
                return;
              }
              if (store.scene4EqMenuHeld) {
                applyScene4HighPassStep(8);
                return;
              }
              if (store.g4DistortionMenuHeld) {
                applyG4DistortionDriveStep(8);
                return;
              }
              if (store.g6StereoPanMenuHeld) {
                applyG6LeftPanStep(8);
                return;
              }
              setG7VolumeMenuHeld(true);
            },
            onRelease: () => {
              if (
                store.g6StereoPanMenuHeld ||
                store.g4DistortionMenuHeld ||
                store.scene4EqMenuHeld ||
                store.scene5CompressorMenuHeld ||
                store.scene7DelayMenuHeld ||
                store.scene8ReverbMenuHeld
              ) {
                return;
              }
              releaseG7VolumeMenuPointer();
            },
            onToggleLatch: () => {
              if (store.scene8ReverbMenuHeld) {
                applyScene8DecayStep(4);
                applyScene8RoomStep(4);
                return;
              }
              if (store.scene7DelayMenuHeld) {
                applyScene7TimeStep(4);
                applyScene7FeedbackStep(4);
                return;
              }
              if (store.scene5CompressorMenuHeld) {
                applyScene5ThresholdStep(8);
                return;
              }
              if (store.scene4EqMenuHeld) {
                applyScene4HighPassStep(8);
                return;
              }
              if (store.g4DistortionMenuHeld) {
                applyG4DistortionDriveStep(8);
                return;
              }
              if (store.g6StereoPanMenuHeld) {
                applyG6LeftPanStep(8);
                return;
              }
              toggleG7VolumeMenuLatch();
            },
          });
        } else if (isH8ClockStripPad) {
          pad.dataset.h8ClockMenuStrip = "true";
          nm.textContent = "clock tick sync";
          pad.dataset.stripHNmDefault = "clock tick sync";
          pad.title =
            "While volume menu is active (hold/lock volume on 8G): 8/8 max level. While pan menu is active: R8. Otherwise hold or click to lock clock tick sync — pick ticks with 8A…8F (same as Clock sync above). Click again to exit.";
          wireWebMenuHoldPad(pad, {
            onPress: () => {
              if (store.scene8ReverbMenuHeld) {
                applyScene8PreDelayStep(4);
                applyScene8MixStep(4);
                return;
              }
              if (store.scene7DelayMenuHeld) {
                applyScene7MixStep(4);
                applyScene7ToneStep(4);
                return;
              }
              if (store.scene5CompressorMenuHeld) {
                applyScene5MakeupStep(8);
                return;
              }
              if (store.scene4EqMenuHeld) {
                applyScene4LowPassStep(8);
                return;
              }
              if (store.g4DistortionMenuHeld) {
                applyG4DistortionToneLevel(4);
                return;
              }
              if (store.g6StereoPanMenuHeld) {
                applyG6RightPanStep(8);
                return;
              }
              if (store.g7VolumeMenuHeld) {
                applyG7VolumeStep(8);
                return;
              }
              setH8ClockStripMenuHeld(true);
            },
            onRelease: () => {
              if (
                store.g6StereoPanMenuHeld ||
                store.g7VolumeMenuHeld ||
                store.g4DistortionMenuHeld ||
                store.scene4EqMenuHeld ||
                store.scene5CompressorMenuHeld ||
                store.scene7DelayMenuHeld ||
                store.scene8ReverbMenuHeld
              ) {
                return;
              }
              releaseH8ClockStripMenuPointer();
            },
            onToggleLatch: () => {
              if (store.scene8ReverbMenuHeld) {
                applyScene8PreDelayStep(4);
                applyScene8MixStep(4);
                return;
              }
              if (store.scene7DelayMenuHeld) {
                applyScene7MixStep(4);
                applyScene7ToneStep(4);
                return;
              }
              if (store.scene5CompressorMenuHeld) {
                applyScene5MakeupStep(8);
                return;
              }
              if (store.scene4EqMenuHeld) {
                applyScene4LowPassStep(8);
                return;
              }
              if (store.g4DistortionMenuHeld) {
                applyG4DistortionToneLevel(4);
                return;
              }
              if (store.g6StereoPanMenuHeld) {
                applyG6RightPanStep(8);
                return;
              }
              if (store.g7VolumeMenuHeld) {
                applyG7VolumeStep(8);
                return;
              }
              toggleH8ClockStripMenuLatch();
            },
          });
        } else {
          const strip =
            rowIdx === 6
              ? "mute col"
              : "stop col";
          const stripTitle =
            rowIdx === 6
              ? `${rowLetter}${dc + 1} · mute column (hold). While stop col (H) is held in this column: press here to stop all clips in the column.`
              : `${rowLetter}${dc + 1} · hold stop col — then tap a clip in this column to stop it, or press mute (G) to stop the whole column`;
          pad.title = stripTitle;
          nm.textContent = strip;
          if (rowIdx === 6) pad.dataset.stripGNmDefault = strip;
          if (rowIdx === 7) pad.dataset.stripHNmDefault = strip;
        }
        pad.append(nm);
        if (isG8VolumeHoldStripPad) {
          /* 8G hold — volume menu (handlers above) */
        } else if (isH8ClockStripPad) {
          /* H8 hold opens clock-tick picker on 8A…8F */
        } else if (rowIdx === 6) {
          const unmuteStrip = () => {
            muteColumnOff(logicalCol, dc);
          };
          pad.addEventListener("pointerdown", async (ev) => {
            ev.preventDefault();
            if (store.scene8ReverbMenuHeld) {
              ev.stopPropagation();
              applyScene8StripG(dc);
              return;
            }
            if (store.scene7DelayMenuHeld) {
              ev.stopPropagation();
              applyScene7StripG(dc);
              return;
            }
            if (store.scene5CompressorMenuHeld) {
              ev.stopPropagation();
              applyScene5ThresholdStep(dc + 1);
              return;
            }
            if (store.scene4EqMenuHeld) {
              ev.stopPropagation();
              applyScene4HighPassStep(dc + 1);
              return;
            }
            if (store.g4DistortionMenuHeld) {
              ev.stopPropagation();
              applyG4DistortionDriveStep(dc + 1);
              return;
            }
            if (store.g6StereoPanMenuHeld) {
              ev.stopPropagation();
              applyG6LeftPanStep(panStepFromStripCol(dc));
              return;
            }
            try {
              pad.setPointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
            await ensureAudio();
            if (store.audioCtx.state === "suspended") await store.audioCtx.resume();
            if (isHStopModifierHeldForPhysicalCol(dc)) {
              stopColumnLoops(logicalCol, dc);
              return;
            }
            muteColumnOn(logicalCol, dc);
          });
          pad.addEventListener("pointerup", (ev) => {
            if (
              store.g6StereoPanMenuHeld ||
              store.g4DistortionMenuHeld ||
              store.scene4EqMenuHeld ||
              store.scene5CompressorMenuHeld ||
              store.scene7DelayMenuHeld ||
              store.scene8ReverbMenuHeld
            ) {
              return;
            }
            unmuteStrip();
            try {
              pad.releasePointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
          });
          pad.addEventListener("pointercancel", (ev) => {
            if (
              store.g6StereoPanMenuHeld ||
              store.g4DistortionMenuHeld ||
              store.scene4EqMenuHeld ||
              store.scene5CompressorMenuHeld ||
              store.scene7DelayMenuHeld ||
              store.scene8ReverbMenuHeld
            ) {
              return;
            }
            unmuteStrip();
          });
          pad.addEventListener("lostpointercapture", (ev) => {
            if (
              store.g6StereoPanMenuHeld ||
              store.g4DistortionMenuHeld ||
              store.scene4EqMenuHeld ||
              store.scene5CompressorMenuHeld ||
              store.scene7DelayMenuHeld ||
              store.scene8ReverbMenuHeld
            ) {
              return;
            }
            unmuteStrip();
          });
          pad.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          });
        } else {
          const releaseHStopModifier = () => setHStopModifierHeld(dc, false);
          pad.addEventListener("pointerdown", async (ev) => {
            if (store.scene8ReverbMenuHeld) {
              ev.preventDefault();
              ev.stopPropagation();
              applyScene8StripH(dc);
              return;
            }
            if (store.scene7DelayMenuHeld) {
              ev.preventDefault();
              ev.stopPropagation();
              applyScene7StripH(dc);
              return;
            }
            if (store.scene5CompressorMenuHeld) {
              ev.preventDefault();
              ev.stopPropagation();
              if (dc <= 3) applyScene5RatioStep(dc + 1);
              else applyScene5MakeupStep(dc + 1);
              return;
            }
            if (store.scene4EqMenuHeld) {
              ev.preventDefault();
              ev.stopPropagation();
              applyScene4LowPassStep(dc + 1);
              return;
            }
            if (store.g4DistortionMenuHeld) {
              ev.preventDefault();
              ev.stopPropagation();
              if (dc <= 2) applyG4DistortionOversampleIndex(dc);
              else if (dc === 3) toggleG4DistortionSoftClipOnSelection();
              else if (dc >= 4 && dc <= 7) applyG4DistortionToneLevel(dc - 3);
              return;
            }
            if (store.g6StereoPanMenuHeld) {
              ev.preventDefault();
              ev.stopPropagation();
              applyG6RightPanStep(panStepFromStripCol(dc));
              return;
            }
            if (store.g7VolumeMenuHeld) {
              ev.preventDefault();
              ev.stopPropagation();
              applyG7VolumeStep(dc + 1);
              return;
            }
            ev.preventDefault();
            setHStopModifierHeld(dc, true);
            try {
              pad.setPointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
            await ensureAudio();
            if (store.audioCtx.state === "suspended") await store.audioCtx.resume();
          });
          pad.addEventListener("pointerup", (ev) => {
            if (
              !store.g6StereoPanMenuHeld &&
              !store.g7VolumeMenuHeld &&
              !store.g4DistortionMenuHeld &&
              !store.scene4EqMenuHeld &&
              !store.scene5CompressorMenuHeld &&
              !store.scene7DelayMenuHeld &&
              !store.scene8ReverbMenuHeld
            ) {
              releaseHStopModifier();
            }
            try {
              pad.releasePointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
          });
          pad.addEventListener("pointercancel", (ev) => {
            if (
              !store.g6StereoPanMenuHeld &&
              !store.g7VolumeMenuHeld &&
              !store.g4DistortionMenuHeld &&
              !store.scene4EqMenuHeld &&
              !store.scene5CompressorMenuHeld &&
              !store.scene7DelayMenuHeld &&
              !store.scene8ReverbMenuHeld
            ) {
              releaseHStopModifier();
            }
          });
          pad.addEventListener("lostpointercapture", (ev) => {
            if (
              !store.g6StereoPanMenuHeld &&
              !store.g7VolumeMenuHeld &&
              !store.g4DistortionMenuHeld &&
              !store.scene4EqMenuHeld &&
              !store.scene5CompressorMenuHeld &&
              !store.scene7DelayMenuHeld &&
              !store.scene8ReverbMenuHeld
            ) {
              releaseHStopModifier();
            }
          });
          pad.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          });
        }
        dom.grid.appendChild(pad);
      }
    } else if (rowIdx < nRows) {
      for (let dc = 0; dc < CLIP_GRID_COLS; dc += 1) {
        if (dc >= nCols) {
          const hole = document.createElement("div");
          hole.className = "pad slot-empty";
          placePadColumn(hole, dc);
          dom.grid.appendChild(hole);
          continue;
        }
        const pk = padKeyFromPhysicalCell(dc, rowIdx);
        const loopId = getLoopIdForSessionClipPadOrScan(pk);
        if (loopId == null) {
          const hole = document.createElement("div");
          hole.className = "pad slot-empty";
          hole.dataset.padKey = pk;
          hole.dataset.sessionColParity = sessionColParityFromPadKey(pk);
          hole.title = `${pk} · no loop in pack`;
          placePadColumn(hole, dc);
          dom.grid.appendChild(hole);
          continue;
        }
        const loop = packState.byId.get(String(loopId));
        const pad = document.createElement("button");
        pad.type = "button";
        pad.className = "pad";
        pad.dataset.padKey = pk;
        pad.dataset.loopId = String(loopId);
        pad.dataset.sessionColParity = sessionColParityFromPadKey(pk);
        placePadColumn(pad, dc);
        const pos = `${dc + 1}${rowLetter}`;
        const kindLabel = normalizeLoopKindKey(loop);
        const titleBase = isMomentaryColumn8ClipPadKey(pk)
          ? `${pk} · column 8 — hold to play, release to stop · kind: ${kindLabel}`
          : `Pad ${pos} · loop ${loopId} · kind/category: ${kindLabel} · type: ${normalizeLoopTypeLegendKey(loop)} · bar-sync when pack says syncTo bar`;
        pad.dataset.padTitleBase = titleBase;
        pad.title = titleBase;
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = loop?.name ?? `#${loopId}`;
        const kd = document.createElement("span");
        kd.className = "kd";
        kd.textContent = kindLabel === "Unknown" ? "" : kindLabel;
        const tpRow = document.createElement("div");
        tpRow.className = "tp-row";
        const tp = document.createElement("span");
        tp.className = "tp";
        tp.textContent = loop?.type ?? "";
        const chLvl = document.createElement("span");
        chLvl.className = "ch-lvl";
        chLvl.setAttribute("aria-hidden", "true");
        chLvl.hidden = true;
        tpRow.append(tp, chLvl);
        const volLvl = document.createElement("span");
        volLvl.className = "vol-lvl";
        volLvl.setAttribute("aria-hidden", "true");
        volLvl.textContent = clipVolumeStarsForStep(getClipG7VolumeStep(loopId));
        const panBar = document.createElement("div");
        panBar.className = "pan-bar";
        panBar.setAttribute("aria-hidden", "true");
        const panSegL = document.createElement("span");
        panSegL.className = "pan-bar-l";
        const panSegR = document.createElement("span");
        panSegR.className = "pan-bar-r";
        panBar.append(panSegL, panSegR);
        pad.append(panBar);
        pad.append(nm);
        if (kindLabel !== "Unknown") pad.append(kd);
        pad.append(tpRow);
        pad.append(volLvl);
        if (isMomentaryColumn8ClipPadKey(pk)) {
          const pp = parsePadKey(pk);
          if (pp && pp.rowIdx >= 0 && pp.rowIdx <= 5) {
            pad.dataset.h8ClockTickRow = "true";
            const menuNm = H8_CLOCK_MENU_WEB_LABEL_BY_PAD[pk];
            if (menuNm) pad.dataset.clockMenuNm = menuNm;
            pad.dataset.nmDefault = nm.textContent;
          }
          const stopCol8 = () => {
            stopClipPlaybackForSessionPadKey(pk);
          };
          pad.addEventListener("pointerdown", async (ev) => {
            ev.preventDefault();
            const tickPick = store.h8ClockStripMenuHeld ? padKeyToSyncLoopTicksChoice(pk) : null;
            if (tickPick != null) {
              applySyncLoopTicksUserValue(tickPick);
              try {
                pad.setPointerCapture(ev.pointerId);
              } catch {
                /* ignore */
              }
              return;
            }
            if (store.g6StereoPanMenuHeld) {
              if (isG7ClipMultiSelectSessionPadKey(pk)) {
                const lid = getLoopIdForSessionClipPadOrScan(pk);
                if (lid != null) toggleG6ClipLoopSelection(lid);
              }
              return;
            }
            if (store.scene8ReverbMenuHeld) {
              if (isG7ClipMultiSelectSessionPadKey(pk)) {
                const lid = getLoopIdForSessionClipPadOrScan(pk);
                if (lid != null) toggleScene8ClipLoopSelection(lid);
              }
              return;
            }
            if (store.scene7DelayMenuHeld) {
              if (isG7ClipMultiSelectSessionPadKey(pk)) {
                const lid = getLoopIdForSessionClipPadOrScan(pk);
                if (lid != null) toggleScene7ClipLoopSelection(lid);
              }
              return;
            }
            if (store.scene5CompressorMenuHeld) {
              if (isG7ClipMultiSelectSessionPadKey(pk)) {
                const lid = getLoopIdForSessionClipPadOrScan(pk);
                if (lid != null) toggleScene5ClipLoopSelection(lid);
              }
              return;
            }
            if (store.scene4EqMenuHeld) {
              if (isG7ClipMultiSelectSessionPadKey(pk)) {
                const lid = getLoopIdForSessionClipPadOrScan(pk);
                if (lid != null) toggleScene4ClipLoopSelection(lid);
              }
              return;
            }
            if (store.g4DistortionMenuHeld) {
              if (isG7ClipMultiSelectSessionPadKey(pk)) {
                const lid = getLoopIdForSessionClipPadOrScan(pk);
                if (lid != null) toggleG4ClipLoopSelection(lid);
              }
              return;
            }
            if (store.g6StereoPanMenuHeld) {
              if (isG7ClipMultiSelectSessionPadKey(pk)) {
                const lid = getLoopIdForSessionClipPadOrScan(pk);
                if (lid != null) toggleG6ClipLoopSelection(lid);
              }
              return;
            }
            if (store.g7VolumeMenuHeld) {
              if (isG7ClipMultiSelectSessionPadKey(pk)) {
                const lid = getLoopIdForSessionClipPadOrScan(pk);
                if (lid != null) toggleG7ClipLoopSelection(lid);
              }
              return;
            }
            try {
              pad.setPointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
            await ensureAudio();
            if (store.audioCtx.state === "suspended") await store.audioCtx.resume();
            await startMomentaryColumn8Playback(loopId, 100);
          });
          pad.addEventListener("pointerup", (ev) => {
            stopCol8();
            try {
              pad.releasePointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
          });
          pad.addEventListener("pointercancel", stopCol8);
          pad.addEventListener("lostpointercapture", stopCol8);
          pad.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          });
        } else {
          pad.addEventListener("pointerdown", (ev) => {
            if (store.scene8ReverbMenuHeld && isG7ClipMultiSelectSessionPadKey(pk)) {
              const lid = getLoopIdForSessionClipPadOrScan(pk);
              if (lid == null) return;
              ev.preventDefault();
              ev.stopPropagation();
              toggleScene8ClipLoopSelection(lid);
              return;
            }
            if (store.scene7DelayMenuHeld && isG7ClipMultiSelectSessionPadKey(pk)) {
              const lid = getLoopIdForSessionClipPadOrScan(pk);
              if (lid == null) return;
              ev.preventDefault();
              ev.stopPropagation();
              toggleScene7ClipLoopSelection(lid);
              return;
            }
            if (store.scene5CompressorMenuHeld && isG7ClipMultiSelectSessionPadKey(pk)) {
              const lid = getLoopIdForSessionClipPadOrScan(pk);
              if (lid == null) return;
              ev.preventDefault();
              ev.stopPropagation();
              toggleScene5ClipLoopSelection(lid);
              return;
            }
            if (store.scene4EqMenuHeld && isG7ClipMultiSelectSessionPadKey(pk)) {
              const lid = getLoopIdForSessionClipPadOrScan(pk);
              if (lid == null) return;
              ev.preventDefault();
              ev.stopPropagation();
              toggleScene4ClipLoopSelection(lid);
              return;
            }
            if (store.g4DistortionMenuHeld && isG7ClipMultiSelectSessionPadKey(pk)) {
              const lid = getLoopIdForSessionClipPadOrScan(pk);
              if (lid == null) return;
              ev.preventDefault();
              ev.stopPropagation();
              toggleG4ClipLoopSelection(lid);
              return;
            }
            if (store.g6StereoPanMenuHeld && isG7ClipMultiSelectSessionPadKey(pk)) {
              const lid = getLoopIdForSessionClipPadOrScan(pk);
              if (lid == null) return;
              ev.preventDefault();
              ev.stopPropagation();
              toggleG6ClipLoopSelection(lid);
              return;
            }
            if (!store.g7VolumeMenuHeld || !isG7ClipMultiSelectSessionPadKey(pk)) return;
            const lid = getLoopIdForSessionClipPadOrScan(pk);
            if (lid == null) return;
            ev.preventDefault();
            ev.stopPropagation();
            toggleG7ClipLoopSelection(lid);
          });
          pad.addEventListener("click", async (ev) => {
            if (
              store.g6StereoPanMenuHeld ||
              store.g7VolumeMenuHeld ||
              store.g4DistortionMenuHeld ||
              store.scene4EqMenuHeld ||
              store.scene5CompressorMenuHeld ||
              store.scene7DelayMenuHeld ||
              store.scene8ReverbMenuHeld
            ) {
              ev.preventDefault();
              ev.stopPropagation();
              return;
            }
            const clipCol = parsePadKey(pk)?.col;
            if (clipCol != null && isHStopModifierHeldForPhysicalCol(clipCol)) {
              ev.preventDefault();
              ev.stopPropagation();
              stopClipPlaybackForSessionPadKey(pk);
              return;
            }
            await ensureAudio();
            if (store.audioCtx.state === "suspended") await store.audioCtx.resume();
            await triggerLoop(loopId, 100, pk);
          });
        }
        dom.grid.appendChild(pad);
      }
    } else {
      for (let dc = 0; dc < CLIP_GRID_COLS; dc += 1) {
        if (dc >= nCols) {
          const hole = document.createElement("div");
          hole.className = "pad slot-empty";
          placePadColumn(hole, dc);
          dom.grid.appendChild(hole);
          continue;
        }
        const pad = document.createElement("div");
        pad.className = "pad utility";
        pad.style.opacity = "0.35";
        placePadColumn(pad, dc);
        pad.append(document.createTextNode("—"));
        dom.grid.appendChild(pad);
      }
    }
    appendSidePanelPad(rowIdx, rowLetter);
  }
  syncPlaybackPadClasses();
  syncSidePanelLegendsWeb();
  queueMicrotask(() => {
    if (!store.pack) return;
    store.lastSyncClockGColumn = -1;
    syncClipLegendWebStyling();
    refreshAllLaunchpadClipLeds();
    refreshLaunchpadMiniMk3PackNavLeds();
    ensureSyncClockAnimator();
  });
}

function persistRemotePackUrlInput(url) {
  try {
    if (url) localStorage.setItem(CUSTOM_PACK_URL_STORAGE_KEY, url);
    else localStorage.removeItem(CUSTOM_PACK_URL_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Remember URL while typing (before a successful load). */
function persistRemotePackUrlDraft(url) {
  try {
    const s = String(url || "").trim();
    if (s) localStorage.setItem(CUSTOM_PACK_URL_STORAGE_KEY, s);
    else localStorage.removeItem(CUSTOM_PACK_URL_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

const PACK_REMOTE_LOAD_BTN_LABEL = "Load";

/** @param {"idle"|"loading"|"ok"|"error"} state */
function setRemotePackUiStatus(state, message = "") {
  const el = dom.packRemoteStatus;
  const btn = dom.btnLoadRemotePack;
  const input = dom.packRemoteUrl;
  if (btn) {
    btn.disabled = state === "loading";
    btn.textContent = state === "loading" ? "Loading…" : PACK_REMOTE_LOAD_BTN_LABEL;
  }
  input?.classList.remove("pack-remote-url--ok", "pack-remote-url--error");
  if (!el) return;
  el.classList.remove(
    "pack-remote-status--loading",
    "pack-remote-status--ok",
    "pack-remote-status--error",
  );
  if (state === "idle") {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.add(`pack-remote-status--${state}`);
  if (state === "ok") input?.classList.add("pack-remote-url--ok");
  else if (state === "error") input?.classList.add("pack-remote-url--error");
}

function showRemotePackLoadSuccess(packJsonUrl, title, nCols, nSessionRowsFull) {
  const host = (() => {
    try {
      return new URL(packJsonUrl).host;
    } catch {
      return packJsonUrl;
    }
  })();
  const grid = `${nCols}×${nSessionRowsFull}`;
  setRemotePackUiStatus("ok", `✓ Loaded “${title}” (${grid}) from ${host}`);
  dom.midi?.classList.add("ok");
  if (dom.midi && !store.midiAccess) {
    dom.midi.textContent = `Loaded remote pack “${title}” (${grid}). Connect MIDI when ready.`;
  }
}

function remotePackFetchErrorHint(err) {
  const msg = String(err?.message ?? err ?? "");
  if (typeof crossOriginIsolated !== "undefined" && crossOriginIsolated) {
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
      return (
        " This page uses Cross-Origin-Embedder-Policy; remote pack.json and WAV files must be same-origin " +
        "or send Cross-Origin-Resource-Policy: cross-origin (and Access-Control-Allow-Origin for cross-origin hosts)."
      );
    }
  }
  if (msg.includes("CORS") || msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
    return " The server must allow cross-origin GET (CORS) for pack.json and all WAV files.";
  }
  return "";
}

/** Remember URL while typing (before a successful load). */


/** @param {"idle"|"loading"|"ok"|"error"} state */



async function applyPackFromUrl(packJsonUrl) {
  const token = ++store.packLoadToken;
  stopAllLoops();
  store.bufferCache.clear();
  store.loopChannelCountByUrl.clear();
  store.clipKindLegendHeld = false;
  store.clipTypeLegendHeld = false;
  store.clipKindLegendLatched = false;
  store.clipTypeLegendLatched = false;
  store.clipKindLegendVelocityByKey.clear();
  store.clipTypeLegendVelocityByKey.clear();
  store.transportOriginAudioSec = null;
  if (store.audioCtx) store.audioBarClockOriginSec = store.audioCtx.currentTime;
  store.lastSyncClockGColumn = -1;
  let loaded;
  try {
    loaded = await loadPackFromUrl(packJsonUrl);
  } catch (e) {
    if (token === store.packLoadToken) throw e;
    return;
  }
  if (token !== store.packLoadToken) return;
  store.remotePackJsonUrl = loaded.packJsonUrl;
  store.remotePackBaseUrl = directoryBaseFromPackJsonUrl(loaded.packJsonUrl);
  persistRemotePackUrlInput(loaded.packJsonUrl);
  store.currentPackSlug = loaded.state.slug;
  store.pack = loaded.state;
  store.loopChannelCountByUrl.clear();
  renderGrid(store.pack);
  probeAllPackChannelCounts(store.pack).catch(() => {});
  showRemotePackLoadSuccess(
    loaded.packJsonUrl,
    store.pack.title,
    store.pack.nCols,
    store.pack.nSessionRowsFull,
  );
  if (store.midiAccess) {
    const n = sendLaunchpadSessionSysex();
    refreshMidiStatus(n);
  }
  preloadPackLoops(store.pack, token).catch(() => {});
}

async function applyPack(slug) {
  const token = ++store.packLoadToken;
  stopAllLoops();
  store.bufferCache.clear();
  store.loopChannelCountByUrl.clear();
  clearRemotePackSource();
  store.clipKindLegendHeld = false;
  store.clipTypeLegendHeld = false;
  store.clipKindLegendLatched = false;
  store.clipTypeLegendLatched = false;
  store.clipKindLegendVelocityByKey.clear();
  store.clipTypeLegendVelocityByKey.clear();
  store.transportOriginAudioSec = null;
  if (store.audioCtx) store.audioBarClockOriginSec = store.audioCtx.currentTime;
  store.lastSyncClockGColumn = -1;
  let nextState;
  try {
    nextState = await loadPack(slug);
  } catch (e) {
    if (token === store.packLoadToken) {
      if (dom.pack) dom.pack.value = store.currentPackSlug;
      throw e;
    }
    return;
  }
  if (token !== store.packLoadToken) return;
  setRemotePackUiStatus("idle");
  store.currentPackSlug = slug;
  store.pack = nextState;
  persistSamplePackSlug(slug);
  renderGrid(store.pack);
  probeAllPackChannelCounts(store.pack).catch(() => {});
  const sample0 = store.pack.raw?.loops?.[0];
  const audioHint = sample0?.url ? ` · audio: ${sample0.url}` : "";
  if (store.midiAccess) {
    const n = sendLaunchpadSessionSysex();
    refreshMidiStatus(n);
    if (dom.midi) {
      dom.midi.textContent += ` · Loaded “${store.pack.title}” [${slug}]${audioHint}`;
    }
  } else {
    let msg = `Loaded “${store.pack.title}” [${slug}] (${store.pack.nCols}×${store.pack.nRows})${audioHint}. Connect MIDI when ready.`;
    if ((store.pack.nSessionRowsFull ?? 0) > LAUNCHPAD_CLIP_SESSION_ROW_COUNT) {
      msg += ` · Pack has ${store.pack.nSessionRowsFull} session rows per column; only six clip rows (A–F) fit the grid — on **Launchpad Mini MK3** use the **DAW** input **▲/▼** above the matrix to scroll rows (G/H stay mute/stop).`;
    }
    dom.midi.textContent = msg;
  }
  preloadPackLoops(store.pack, token).catch(() => {});
}

function handleMidiMessage(ev) {
  const data = ev.data;
  if (!data || data.length < 3) return;
  const st = data[0];
  const d1 = data[1];
  const d2 = data[2];
  const hi = st & 0xf0;

  const port = (ev.target && ev.target.name) || "?";
  const bhex = (n) => ((n >>> 0) & 0xff).toString(16).padStart(2, "0");
  const raw = data.length >= 3 ? `raw ${bhex(st)} ${bhex(d1)} ${bhex(d2)}` : "";

  if (hi === 0xb0 && d2 === 0) {
    if (handleLaunchpadSceneSideCcRelease(port, d1, raw)) return;
    return;
  }
  if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
    if (store.pack) {
      const rPad = padKeyFromNote(d1, port);
      const rp = rPad ? parsePadKey(rPad) : null;
      if (rp && rp.rowIdx === 6) {
        if (rPad === "8G") {
          if (
            !store.g6StereoPanMenuHeld &&
            !store.g4DistortionMenuHeld &&
            !store.scene4EqMenuHeld &&
            !store.scene5CompressorMenuHeld &&
            !store.scene7DelayMenuHeld &&
            !store.scene8ReverbMenuHeld
          ) {
            setG7VolumeMenuHeld(false);
          }
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            store.scene8ReverbMenuHeld
              ? "strip G8 · note off ignored during reverb menu"
              : store.scene7DelayMenuHeld
              ? "strip G8 · note off ignored during delay menu"
              : store.scene5CompressorMenuHeld
                ? "strip G8 · note off ignored during compressor menu"
                : store.scene4EqMenuHeld
                ? "strip G8 · note off ignored during spectrum EQ menu"
                : store.g4DistortionMenuHeld
                ? "strip G8 · note off ignored during distortion menu"
                : store.g6StereoPanMenuHeld
                  ? "strip G8 · note off ignored during stereo pan menu"
                  : "strip 8G · volume menu released (column 8 strip is volume UI, not mute)",
          ]);
          return;
        }
        if (store.scene8ReverbMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip G · note off ignored during reverb menu",
          ]);
          return;
        }
        if (store.scene7DelayMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip G · note off ignored during delay menu",
          ]);
          return;
        }
        if (store.scene5CompressorMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip G · note off ignored during compressor menu",
          ]);
          return;
        }
        if (store.scene4EqMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip G · note off ignored during spectrum EQ menu",
          ]);
          return;
        }
        if (store.g4DistortionMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip G · note off ignored during distortion menu",
          ]);
          return;
        }
        if (store.g6StereoPanMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip G · note off ignored during 6G stereo pan menu",
          ]);
          return;
        }
        if (isStripMuteStopInertAtPhysicalCol(rp.col)) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip G8 · mute N/A (column 8 momentary)",
          ]);
          return;
        }
        const logicalCol = logicalColForPadCol(rp.col, store.pack.nCols);
        muteColumnOff(logicalCol, rp.col);
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          rPad,
          "strip G · column unmuted (note off)",
          `col ${logicalCol + 1}`,
        ]);
        return;
      }
      if (rp && rp.rowIdx === 7) {
        if (store.scene8ReverbMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip H · note off ignored during reverb menu",
          ]);
          return;
        }
        if (store.scene7DelayMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip H · note off ignored during delay menu",
          ]);
          return;
        }
        if (store.scene5CompressorMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip H · note off ignored during compressor menu",
          ]);
          return;
        }
        if (store.scene4EqMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip H · note off ignored during spectrum EQ menu",
          ]);
          return;
        }
        if (store.g4DistortionMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip H · note off ignored during distortion menu",
          ]);
          return;
        }
        if (store.g6StereoPanMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip H · note off ignored during 6G stereo pan menu",
          ]);
          return;
        }
        if (store.g7VolumeMenuHeld) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip H · note off ignored during 8G volume menu",
          ]);
          return;
        }
        if (isStripMuteStopInertAtPhysicalCol(rp.col) && rPad === "8H") {
          setH8ClockStripMenuHeld(false);
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip H8 · Clock sync menu released",
          ]);
          return;
        }
        if (isStripMuteStopInertAtPhysicalCol(rp.col)) {
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            "strip H8 · stop N/A (column 8 momentary)",
          ]);
          return;
        }
        const logicalCol = logicalColForPadCol(rp.col, store.pack.nCols);
        setHStopModifierHeld(rp.col, false);
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          rPad,
          "strip H · stop modifier released",
          `col ${logicalCol + 1}`,
        ]);
        return;
      }
      if (rPad && isMomentaryColumn8ClipPadKey(rPad)) {
        stopClipPlaybackForSessionPadKey(rPad);
        setMidiDebugLine([port.slice(0, 56), raw, rPad, "column 8 · released (sound off)"]);
        return;
      }
    }
    return;
  }

  let noteNum = null;
  let vel = 0;

  /** Clip grid from hardware uses Note On (0x90). CC (0xB0) is side / mode / mixer — controller # can equal a pad “note” id (false 8C, etc.). */
  if (hi === 0xb0) {
    if (d2 > 0) {
      if (handleLaunchpadMiniMk3PackNavCcPress(port, d1, d2, raw)) return;
      if (handleLaunchpadSceneSideCcPress(port, d1, d2, raw)) return;
      const ghostPad = padKeyFromNote(d1, port);
      const mk3Side = portLooksLikeNovationLaunchpad(port) ? miniMk3PanelRightCcLabel(d1) : null;
      if (ghostPad || mk3Side) {
        const parts = [
          port.slice(0, 56),
          raw,
          `CC ${d1} (0x${bhex(d1)}) val ${d2}`,
        ];
        if (mk3Side) {
          parts.push(`${mk3Side} — ignored for clips (not Note On).`);
        } else if (ghostPad) {
          parts.push(
            `ignored for clips — not a pad Note On; CC# would match Session ${ghostPad} if misread. Clip pads use raw 90 …`,
          );
        }
        setMidiDebugLine(parts);
      }
    }
    return;
  }
  if (hi !== 0x90) {
    return;
  }
  noteNum = d1;
  vel = d2;

  let padKey = padKeyFromNote(noteNum, port);
  const padKeyBeforeStripFix = padKey;
  if (dom.midiSysex?.checked && isMobileSessionHost()) {
    const stripPk = stripPadKeyFromMobileFxMenuMisread(padKey);
    if (stripPk) padKey = stripPk;
  }

  if (!padKey) {
    const parts = [
      port.slice(0, 72),
      raw,
      `note ${noteNum} vel ${vel}`,
    ];
    if (/\bdaw\b/i.test(port)) {
      parts.push(
        "No pad on Classic (DAW) or Modern map — likely non-grid MIDI. Custom pad traffic is on the **MIDI** port.",
      );
    } else if (getPadLayout() === "modern") {
      const classicPad = noteToPadClassic[String(noteNum)];
      if (classicPad) {
        parts.push(
          `Modern map has no note ${noteNum}; Classic Session would be pad ${classicPad}. Try “Classic” map + hardware Session, or fix MIDI port.`,
        );
      } else {
        parts.push("no pad in map for Modern — check hardware Session mode or Pad / MIDI map.");
      }
    } else {
      parts.push("no pad in map — try “Pad / MIDI map” or another MIDI input.");
    }
    setMidiDebugLine(parts);
    return;
  }
  if (!store.pack) {
    setMidiDebugLine([port.slice(0, 56), raw, padKey, "pack not loaded"]);
    return;
  }

  const parsed = parsePadKey(padKey);
  if (!parsed) return;

  if (store.h8ClockStripMenuHeld && vel > 0) {
    const pick = padKeyToSyncLoopTicksChoice(padKey);
    if (pick != null) {
      applySyncLoopTicksUserValue(pick);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        `clock sync → ${clockSyncHumanLabel(pick)}`,
      ]);
      return;
    }
  }

  /** Column 8 row G or H only (`8G` / `8H`): handle before `padKeyToSessionCell` so wide session packs do not treat them as clips. */
  if (
    vel > 0 &&
    isStripMuteStopInertAtPhysicalCol(parsed.col) &&
    (parsed.rowIdx === 6 || parsed.rowIdx === 7)
  ) {
    if (store.scene8ReverbMenuHeld) {
      if (parsed.rowIdx === 6) {
        applyScene8DecayStep(4);
        applyScene8RoomStep(4);
      } else {
        applyScene8PreDelayStep(4);
        applyScene8MixStep(4);
      }
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.rowIdx === 6
          ? "strip G8 · reverb decay/room max (D4 R4)"
          : "strip H8 · reverb pre-delay/wet max (P4 W4)",
      ]);
      return;
    }
    if (store.scene7DelayMenuHeld) {
      if (parsed.rowIdx === 6) {
        applyScene7TimeStep(4);
        applyScene7FeedbackStep(4);
      } else {
        applyScene7MixStep(4);
        applyScene7ToneStep(4);
      }
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.rowIdx === 6
          ? "strip G8 · delay time/feedback max (T4 F4)"
          : "strip H8 · delay mix/tone max (M4 N4)",
      ]);
      return;
    }
    if (store.scene5CompressorMenuHeld) {
      if (parsed.rowIdx === 6) applyScene5ThresholdStep(8);
      else applyScene5MakeupStep(8);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.rowIdx === 6 ? "strip G8 · compressor threshold 8/8" : "strip H8 · compressor makeup 8/8",
      ]);
      return;
    }
    if (store.scene4EqMenuHeld) {
      if (parsed.rowIdx === 6) applyScene4HighPassStep(8);
      else applyScene4LowPassStep(8);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.rowIdx === 6 ? "strip G8 · high-pass 8/8" : "strip H8 · low-pass 8/8",
      ]);
      return;
    }
    if (store.g4DistortionMenuHeld) {
      if (parsed.rowIdx === 6) applyG4DistortionDriveStep(8);
      else applyG4DistortionToneLevel(4);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.rowIdx === 6 ? "strip G8 · distortion drive 8/8" : "strip H8 · distortion tone T4",
      ]);
      return;
    }
    if (store.g6StereoPanMenuHeld) {
      if (parsed.rowIdx === 6) applyG6LeftPanStep(8);
      else applyG6RightPanStep(8);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.rowIdx === 6
          ? "strip G8 · stereo pan left L8 (L+R=8)"
          : "strip H8 · stereo pan right R8 (L+R=8)",
      ]);
      return;
    }
    if (parsed.rowIdx === 6) {
      if (!store.g7VolumeMenuHeld) setG7VolumeMenuHeld(true);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        "strip 8G · volume menu (hold) — row H 1/8…8/8, select clips 1A…8F",
      ]);
      return;
    }
    if (store.g7VolumeMenuHeld) {
      applyG7VolumeStep(8);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        "strip H · 8G volume step 8/8",
      ]);
      return;
    }
    setH8ClockStripMenuHeld(true);
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      padKey,
      "strip H8 · Clock sync (hold) — tap 8A…8F",
    ]);
    return;
  }

  const clipCell = padKeyToSessionCell(padKey, store.pack.nRows);
  if (clipCell && store.scene8ReverbMenuHeld && vel > 0) {
    if (isG7ClipMultiSelectSessionPadKey(padKey)) {
      const selLoopId = getLoopIdForSessionClipPadOrScan(padKey);
      if (selLoopId != null) toggleScene8ClipLoopSelection(selLoopId);
    }
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      padKey,
      "reverb menu · clip pad (toggle selection 1A…8F)",
    ]);
    return;
  }
  if (clipCell && store.scene7DelayMenuHeld && vel > 0) {
    if (isG7ClipMultiSelectSessionPadKey(padKey)) {
      const selLoopId = getLoopIdForSessionClipPadOrScan(padKey);
      if (selLoopId != null) toggleScene7ClipLoopSelection(selLoopId);
    }
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      padKey,
      "delay menu · clip pad (toggle selection 1A…8F)",
    ]);
    return;
  }
  if (clipCell && store.scene5CompressorMenuHeld && vel > 0) {
    if (isG7ClipMultiSelectSessionPadKey(padKey)) {
      const selLoopId = getLoopIdForSessionClipPadOrScan(padKey);
      if (selLoopId != null) toggleScene5ClipLoopSelection(selLoopId);
    }
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      padKey,
      "compressor menu · clip pad (toggle selection 1A…8F)",
    ]);
    return;
  }
  if (clipCell && store.scene4EqMenuHeld && vel > 0) {
    if (isG7ClipMultiSelectSessionPadKey(padKey)) {
      const selLoopId = getLoopIdForSessionClipPadOrScan(padKey);
      if (selLoopId != null) toggleScene4ClipLoopSelection(selLoopId);
    }
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      padKey,
      "spectrum EQ menu · clip pad (toggle selection 1A…8F)",
    ]);
    return;
  }
  if (clipCell && store.g4DistortionMenuHeld && vel > 0) {
    if (isG7ClipMultiSelectSessionPadKey(padKey)) {
      const selLoopId = getLoopIdForSessionClipPadOrScan(padKey);
      if (selLoopId != null) toggleG4ClipLoopSelection(selLoopId);
    }
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      padKey,
      "distortion menu · clip pad (toggle selection 1A…8F)",
    ]);
    return;
  }
  if (clipCell && store.g6StereoPanMenuHeld && vel > 0) {
    if (isG7ClipMultiSelectSessionPadKey(padKey)) {
      const selLoopId = getLoopIdForSessionClipPadOrScan(padKey);
      if (selLoopId != null) toggleG6ClipLoopSelection(selLoopId);
    }
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      padKey,
      "6G stereo pan · clip pad (toggle selection 1A…8F)",
    ]);
    return;
  }
  if (clipCell && store.g7VolumeMenuHeld && vel > 0) {
    if (isG7ClipMultiSelectSessionPadKey(padKey)) {
      const selLoopId = getLoopIdForSessionClipPadOrScan(padKey);
      if (selLoopId != null) toggleG7ClipLoopSelection(selLoopId);
    }
    setMidiDebugLine([
      port.slice(0, 56),
      raw,
      padKey,
      store.g7VolumeMenuHeld && isG7ClipMultiSelectSessionPadKey(padKey)
        ? "8G volume menu · clip pad (toggle selection 1A…8F)"
        : "8G volume menu · clip pad (selection only on 1A…8F)",
    ]);
    return;
  }

  if (!clipCell && (parsed.rowIdx === 6 || parsed.rowIdx === 7)) {
    if (parsed.rowIdx === 6 && store.scene8ReverbMenuHeld && vel > 0) {
      applyScene8StripG(parsed.col);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.col <= 3
          ? `strip G · reverb decay D${parsed.col + 1}`
          : `strip G · reverb room R${parsed.col - 3}`,
      ]);
      return;
    }
    if (parsed.rowIdx === 7 && store.scene8ReverbMenuHeld && vel > 0) {
      applyScene8StripH(parsed.col);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.col <= 3
          ? `strip H · reverb pre-delay P${parsed.col + 1}`
          : `strip H · reverb wet W${parsed.col - 3}`,
      ]);
      return;
    }
    if (parsed.rowIdx === 6 && store.scene7DelayMenuHeld && vel > 0) {
      applyScene7StripG(parsed.col);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.col <= 3
          ? `strip G · delay time T${parsed.col + 1}`
          : `strip G · delay feedback F${parsed.col - 3}`,
      ]);
      return;
    }
    if (parsed.rowIdx === 7 && store.scene7DelayMenuHeld && vel > 0) {
      applyScene7StripH(parsed.col);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.col <= 3
          ? `strip H · delay mix M${parsed.col + 1}`
          : `strip H · delay tone N${parsed.col - 3}`,
      ]);
      return;
    }
    if (parsed.rowIdx === 6 && store.scene5CompressorMenuHeld && vel > 0) {
      applyScene5ThresholdStep(parsed.col + 1);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        `strip G · compressor threshold ${parsed.col + 1}/8`,
      ]);
      return;
    }
    if (parsed.rowIdx === 7 && store.scene5CompressorMenuHeld && vel > 0) {
      if (parsed.col <= 3) {
        applyScene5RatioStep(parsed.col + 1);
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          padKey,
          `strip H · compressor ratio R${parsed.col + 1}`,
        ]);
      } else {
        applyScene5MakeupStep(parsed.col + 1);
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          padKey,
          `strip H · compressor makeup M${parsed.col + 1}`,
        ]);
      }
      return;
    }
    if (parsed.rowIdx === 6 && store.scene4EqMenuHeld && vel > 0) {
      applyScene4HighPassStep(parsed.col + 1);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        `strip G · high-pass ${parsed.col + 1}/8`,
      ]);
      return;
    }
    if (parsed.rowIdx === 7 && store.scene4EqMenuHeld && vel > 0) {
      applyScene4LowPassStep(parsed.col + 1);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        `strip H · low-pass ${parsed.col + 1}/8`,
      ]);
      return;
    }
    if (parsed.rowIdx === 6 && store.g4DistortionMenuHeld && vel > 0) {
      applyG4DistortionDriveStep(parsed.col + 1);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        `strip G · distortion drive ${parsed.col + 1}/8`,
      ]);
      return;
    }
    if (parsed.rowIdx === 7 && store.g4DistortionMenuHeld && vel > 0) {
      if (parsed.col <= 2) {
        applyG4DistortionOversampleIndex(parsed.col);
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          padKey,
          `strip H · oversample ${parsed.col === 0 ? "none" : parsed.col === 1 ? "2×" : "4×"}`,
        ]);
      } else if (parsed.col === 3) {
        toggleG4DistortionSoftClipOnSelection();
        setMidiDebugLine([port.slice(0, 56), raw, padKey, "strip H4 · soft/hard clip toggle"]);
      } else if (parsed.col >= 4 && parsed.col <= 7) {
        applyG4DistortionToneLevel(parsed.col - 3);
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          padKey,
          `strip H · tone filter T${parsed.col - 3}`,
        ]);
      }
      return;
    }
    if (parsed.rowIdx === 6 && store.g6StereoPanMenuHeld && vel > 0) {
      applyG6LeftPanStep(panStepFromStripCol(parsed.col));
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        `strip G · stereo pan left L${panStepFromStripCol(parsed.col)} (L+R=8)`,
      ]);
      return;
    }
    if (parsed.rowIdx === 7 && store.g6StereoPanMenuHeld && vel > 0) {
      applyG6RightPanStep(panStepFromStripCol(parsed.col));
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        `strip H · stereo pan right R${panStepFromStripCol(parsed.col)} (L+R=8)`,
      ]);
      return;
    }
    if (parsed.rowIdx === 7 && store.g7VolumeMenuHeld && vel > 0) {
      applyG7VolumeStep(parsed.col + 1);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        `strip H · 8G volume step ${parsed.col + 1}/8`,
      ]);
      return;
    }
    if (isStripMuteStopInertAtPhysicalCol(parsed.col)) {
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        parsed.rowIdx === 6 ? "strip G8 · mute N/A" : "strip H8 · stop N/A",
        "column 8 momentary — use clip pads 8A–8F",
      ]);
      return;
    }
    const logicalCol = logicalColForPadCol(parsed.col, store.pack.nCols);
    const physicalCol = parsed.col;
    if (parsed.rowIdx === 6) {
      if (isHStopModifierHeldForPhysicalCol(physicalCol)) {
        stopColumnLoops(logicalCol, physicalCol);
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          padKey,
          "strip G · stop whole column (H stop modifier held)",
          `col ${logicalCol + 1}`,
        ]);
      } else {
        muteColumnOn(logicalCol, physicalCol);
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          padKey,
          "strip G · mute column (silence until note off)",
          `col ${logicalCol + 1}`,
        ]);
      }
    } else {
      setHStopModifierHeld(physicalCol, true);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        "strip H · stop modifier (hold) — tap clip or mute (G) in column to stop",
        `col ${logicalCol + 1}`,
      ]);
    }
    return;
  }

  const loopId = getLoopIdForSessionClipPadOrScan(padKey);
  let flipPackHint = "";
  if (clipCell && getGridFlip() !== "none") {
    const { col: lc, sessionRow: lr } = applySessionGridFlip(
      clipCell.col,
      clipCell.sessionRow,
      store.pack.nCols,
      store.pack.nRows,
    );
    flipPackHint = `pack slot ${lc + 1}${String.fromCharCode(65 + lr)} after flip (pack.json row/col) — highlighted pad is Session ${padKey}`;
  }
  const elLoop = loopId != null ? padEl(loopId) : null;
  const elPad = padElByPadKey(padKey);
  let uiCellHint = "no loop (row/col out of pack?)";
  if (loopId != null) {
    if (!elLoop) uiCellHint = "UI cell: NO button for loop (screenshot)";
    else if (elPad && elLoop !== elPad) uiCellHint = "UI cell: MISMATCH pad vs loop (screenshot)";
    else uiCellHint = "UI cell: yes";
  }
  let syncHint = null;
  if (loopId != null) {
    const lp = store.pack.byId.get(String(loopId));
    const syncTo = lp?.padData?.pad?.trigger?.syncTo;
    if (syncTo === "bar" || syncTo === "beat") {
      syncHint = `clip uses ${syncTo} sync — sound starts on the next ${syncTo} after **Enable audio** (pad turns **orange** while armed, **yellow** when playing)`;
    }
  }
  const mapHint = padDecodeNoteMapHint(noteNum, port);
  const mobileFix = sessionNoteMapDebugExtra(noteNum, padKey);
  const stripFixHint =
    padKeyBeforeStripFix && padKey !== padKeyBeforeStripFix
      ? `mobile strip fix ${padKeyBeforeStripFix} → ${padKey}`
      : null;
  setMidiDebugLine([
    port.slice(0, 56),
    raw,
    `note ${noteNum}`,
    padKey,
    mapHint,
    mobileFix,
    stripFixHint,
    flipPackHint || null,
    loopId != null ? `loop ${loopId}` : clipCell ? "no loop in pack for this pad" : null,
    uiCellHint,
    syncHint,
  ]);

  if (loopId == null) return;

  if (vel > 0 && clipCell) {
    const clipCol = parsePadKey(padKey)?.col;
    if (clipCol != null && isHStopModifierHeldForPhysicalCol(clipCol)) {
      stopClipPlaybackForSessionPadKey(padKey);
      setMidiDebugLine([
        port.slice(0, 56),
        raw,
        padKey,
        "clip · stopped (H stop modifier held in column)",
        `loop ${loopId}`,
      ]);
      return;
    }
  }

  void (async () => {
    try {
      await ensureAudio();
      if (store.audioCtx?.state === "suspended") await store.audioCtx.resume();
      await triggerLoop(loopId, vel, padKey);
    } catch (e) {
      console.warn(e);
    }
  })();
}

/** True if any port looks like Launchpad X / Mini MK3 / Pro MK3 (Arcade “modern” hardware). */
function portsSuggestModernLaunchpad() {
  if (!store.midiAccess) return false;
  const ports = [...store.midiAccess.inputs.values(), ...store.midiAccess.outputs.values()];
  for (const p of ports) {
    const name = p.name || "";
    if (/mini\s*mk\s*3|lpminimk3|launchpad\s*mini\s*mk\s*3/i.test(name)) return true;
    if (/\blppromk3\b|launchpad\s*pro\s*mk\s*3/i.test(name)) return true;
    if ((/\blpx\b|launchpad\s*x\b/i.test(name)) && !/mini/i.test(name)) return true;
  }
  return false;
}

/** Classic map is only for pre-MK3 Mini/MK2; switch back if modern hardware is present. */
function ensureModernLayoutForHardware() {
  if (!portsSuggestModernLaunchpad() || getPadLayout() !== "classic") return false;
  dom.midiLayout.value = "modern";
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, "modern");
  } catch {
    /* ignore */
  }
  return true;
}

/** Exit DAW mode so the unit returns to Standalone (hardware Session / Custom work normally again). */
function sendLaunchpadStandaloneSysex() {
  if (!store.midiAccess) return 0;
  let sent = 0;
  for (const output of store.midiAccess.outputs.values()) {
    const name = (output.name || "").trim();
    const frames = standaloneFramesForLaunchpadOutput(name);
    if (!frames) continue;
    for (const bytes of frames) {
      try {
        output.send(new Uint8Array(bytes));
      } catch (e) {
        console.warn("MIDI SysEx standalone failed:", name, e);
      }
    }
    sent += 1;
  }
  return sent;
}

/** Send Novation “DAW Session layout” SysEx (Arcade). Optional — can confuse the hardware Session key until USB replug. */
function sendLaunchpadSessionSysex() {
  if (!store.midiAccess || getPadLayout() !== "modern") return 0;
  if (!dom.midiSysex?.checked) return -1;
  let sent = 0;
  for (const output of store.midiAccess.outputs.values()) {
    const name = (output.name || "").trim();
    const frames = framesForLaunchpadOutput(name);
    if (!frames) continue;
    for (const bytes of frames) {
      try {
        output.send(new Uint8Array(bytes));
      } catch (e) {
        console.warn("MIDI SysEx send failed:", name, e);
      }
    }
    sent += 1;
  }
  if (sent > 0 && store.pack) {
    queueMicrotask(() => refreshAllLaunchpadClipLeds());
  }
  return sent;
}

function refreshMidiStatus(sessionOutputs = null) {
  if (!store.midiAccess) return;
  const ins = store.midiAccess.inputs.size;
  const outs = store.midiAccess.outputs.size;
  let msg = `MIDI: ${ins} input(s), ${outs} output(s) · “${store.pack?.title ?? store.currentPackSlug}”`;
  if (getPadLayout() === "classic") {
    msg +=
      " · Classic pad map — use hardware Session; Drum/User keys use other MIDI notes (not this grid).";
  } else if (sessionOutputs != null) {
    if (sessionOutputs < 0) {
      msg +=
        isMobileSessionHost() && portsSuggestModernLaunchpad()
          ? " · **Send DAW Session SysEx** is off — on phone/tablet the Session grid will be wrong until you enable it (Advanced options), then Connect MIDI again or toggle the checkbox."
          : " · DAW Session SysEx is off — hardware Session / Custom / Drum / Keys behave normally. Turn on the checkbox below only to match Arcade’s layout on the pads.";
    } else if (sessionOutputs > 0) {
      msg += ` · Session layout SysEx → ${sessionOutputs} Launchpad output(s)`;
    } else {
      msg +=
        " · No matching Launchpad output for SysEx (use a Novation “… MIDI” / “… DAW” output port name from the driver)";
    }
  }
  if (store.boundMidiInputSummary) {
    msg += ` · Listening: ${store.boundMidiInputSummary}`;
  }
  if (getPadLayout() === "modern" && portsSuggestModernLaunchpad()) {
    msg +=
      " · Mini MK3 / LP X / Pro MK3 (Novation): **Session** grid → **DAW** input (Live-style / Classic note bytes); **User / Drums / Keys** → **MIDI** input. **Clip LED colours** (idle / orange armed / yellow playing / red pending stop) are sent on the **DAW** USB output only — that port drives Session pad lights; the MIDI port does not. Raise Session LED brightness in hardware setup (hold Session) if the layout looks dim. Enable **DAW Session** SysEx so the unit stays in DAW Session like Arcade. **Launchpad Mini MK3:** top-row ◀ ▶ (next to Session) cycle **Sample set**; **▲ ▼** scroll extra **A–F** clip rows when the pack has more than six session rows (DAW input). **Right column (DAW):** scene **CC 89** (row 1) and **CC 79** (row 2) show **dim** blue / green when a pack is loaded (hint: legend keys); **hold** for **kind** / category or **`loop.type`** colours on A–F; release (CC value 0) restores the normal grid and dim hint. Logo CC **99** is not used.";
  }
  if ((store.pack?.nSessionRowsFull ?? 0) > LAUNCHPAD_CLIP_SESSION_ROW_COUNT) {
    msg += ` · Current pack: ${store.pack.nSessionRowsFull} session rows — use Mini MK3 **DAW** ▲/▼ to scroll the six visible clip rows.`;
  }
  if (getAssetSource() === "remote" && store.remotePackJsonUrl && store.pack?.title) {
    msg += ` · Remote pack loaded: “${store.pack.title}”.`;
  }
  dom.midi.textContent = msg;
  dom.midi.classList.toggle("ok", ins > 0 || (getAssetSource() === "remote" && !!store.remotePackJsonUrl));
}

async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    dom.midi.textContent = "Web MIDI API not available in this browser.";
    return;
  }
  store.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
  populateMidiInputSelect();
  if (dom.midiInput) dom.midiInput.disabled = false;
  if (dom.btnMidiStandalone) dom.btnMidiStandalone.disabled = false;
  bindMidiInputs();
  const switched = ensureModernLayoutForHardware();
  prepareMobileMidiSession();
  const sessionOuts = sendLaunchpadSessionSysex();
  refreshMidiStatus(sessionOuts);
  if (switched) {
    dom.midi.textContent += " · Pad map set to Modern (Launchpad X / Mini MK3 / Pro MK3).";
  }
  if (store.pack) {
    queueMicrotask(() => refreshAllLaunchpadClipLeds());
  }
  store.midiAccess.onstatechange = () => {
    populateMidiInputSelect();
    bindMidiInputs();
    const sw = ensureModernLayoutForHardware();
    const n = sendLaunchpadSessionSysex();
    refreshMidiStatus(n);
    if (sw) {
      dom.midi.textContent += " · Pad map set to Modern (Launchpad X / Mini MK3 / Pro MK3).";
    }
    if (store.pack) {
      queueMicrotask(() => refreshAllLaunchpadClipLeds());
    }
  };
}

function fillPackSelect() {
  fillPackSelectForAssetSource();
}

dom.btnAudio.addEventListener("click", async () => {
  await ensureAudio();
  await store.audioCtx.resume();
  dom.btnAudio.textContent = "Audio on";
});

dom.btnMidi.addEventListener("click", () => {
  connectMidi().catch((e) => {
    dom.midi.textContent = `MIDI error: ${e.message ?? e}`;
  });
});

dom.btnMidiStandalone?.addEventListener("click", () => {
  if (!store.midiAccess) return;
  const n = sendLaunchpadStandaloneSysex();
  setMidiDebugLine([
    `Standalone SysEx (DAW off) → ${n} Launchpad output(s).`,
    "Hardware Session / Custom should respond again — press Session on the unit.",
  ]);
  const sessionOuts = sendLaunchpadSessionSysex();
  refreshMidiStatus(sessionOuts);
  if (store.pack) {
    queueMicrotask(() => refreshAllLaunchpadClipLeds());
  }
});

async function loadRemotePackFromUi() {
  const raw = dom.packRemoteUrl?.value ?? "";
  const trimmed = raw.trim();
  persistRemotePackUrlDraft(trimmed);
  if (!trimmed) {
    setRemotePackUiStatus("idle");
    if (dom.midi) {
      dom.midi.textContent =
        "Custom URL: pack.json or catalog.json URL, then click Load (or press Enter).";
    }
    return;
  }
  setRemotePackUiStatus("loading", "Loading…");
  try {
    const pageHref = typeof location !== "undefined" ? location.href : "";
    const probeUrl = resolvePackJsonUrl(trimmed, pageHref);
    const res = await fetch(probeUrl, { cache: "no-store", mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${probeUrl}`);
    const json = await res.json();
    if (isPackCatalogDocument(json)) {
      clearRemoteCatalog();
      store.remoteCatalogUrl = probeUrl;
      store.remoteCatalogEntries = parsePackCatalog(json, probeUrl, pageHref);
      persistRemotePackUrlInput(probeUrl);
      applyRemoteCatalogToPackSelect(store.remoteCatalogEntries, dom.pack?.value);
      const entry =
        store.remoteCatalogEntries.find((e) => e.slug === dom.pack?.value) ??
        store.remoteCatalogEntries[0];
      await applyPackFromUrl(entry.packJsonUrl);
      const host = (() => {
        try {
          return new URL(probeUrl).host;
        } catch {
          return probeUrl;
        }
      })();
      setRemotePackUiStatus(
        "ok",
        `✓ Catalog (${store.remoteCatalogEntries.length} packs) from ${host} — loaded “${store.pack?.title ?? entry.title}”`,
      );
      return;
    }
    clearRemoteCatalog();
    syncAssetSourceRemotePanel();
    await applyPackFromUrl(trimmed);
  } catch (e) {
    const hint = remotePackFetchErrorHint(e);
    setRemotePackUiStatus("error", `✗ ${e.message ?? e}${hint}`);
    if (dom.midi) dom.midi.textContent = `Load error: ${e.message ?? e}.${hint}`;
  }
}

function onAssetSourceChange() {
  try {
    localStorage.setItem(ASSET_SOURCE_STORAGE_KEY, getAssetSource());
  } catch {
    /* ignore */
  }
  syncAssetSourceRemotePanel();
  store.bufferCache.clear();
  store.loopChannelCountByUrl.clear();
  if (getAssetSource() === "remote") {
    const url = dom.packRemoteUrl?.value.trim() ?? "";
    if (url) {
      loadRemotePackFromUi();
    } else if (store.remotePackJsonUrl && store.pack?.title) {
      showRemotePackLoadSuccess(
        store.remotePackJsonUrl,
        store.pack.title,
        store.pack.nCols,
        store.pack.nSessionRowsFull,
      );
    } else {
      setRemotePackUiStatus("idle");
      if (dom.midi) {
        dom.midi.textContent =
          "Custom URL: enter pack.json URL and click Load. Showing last local pack until then.";
      }
      if (!store.pack) {
        applyPack(dom.pack?.value || store.currentPackSlug).catch(() => {});
      }
    }
    return;
  }
  setRemotePackUiStatus("idle");
  clearRemotePackSource();
  fillPackSelectForAssetSource();
  applyPack(dom.pack.value || store.currentPackSlug).catch((e) => {
    if (dom.midi) {
      dom.midi.textContent = `Load error: ${e.message ?? e}. ${assetLoadErrorHint()}`;
    }
  });
}

dom.pack?.addEventListener("change", () => {
  const slug = dom.pack?.value;
  if (!slug) return;
  applyPackSelection(slug).catch((e) => {
    const hint = getAssetSource() === "remote" ? remotePackFetchErrorHint(e) : assetLoadErrorHint();
    if (getAssetSource() === "remote") {
      setRemotePackUiStatus("error", `✗ ${e.message ?? e}${hint}`);
    }
    dom.midi.textContent = `Load error: ${e.message ?? e}.${hint}`;
  });
});

dom.btnLoadRemotePack?.addEventListener("click", () => {
  loadRemotePackFromUi();
});

dom.packRemoteUrl?.addEventListener("input", () => {
  persistRemotePackUrlDraft(dom.packRemoteUrl?.value ?? "");
});

dom.packRemoteUrl?.addEventListener("input", () => {
  persistRemotePackUrlDraft(dom.packRemoteUrl?.value ?? "");
});

dom.packRemoteUrl?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    loadRemotePackFromUi();
  }
});

dom.assetSource?.addEventListener("change", onAssetSourceChange);

dom.midiLayout.addEventListener("change", () => {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, dom.midiLayout.value);
  } catch {
    /* ignore */
  }
  if (store.midiAccess) {
    const n = sendLaunchpadSessionSysex();
    refreshMidiStatus(n);
    if (store.pack) {
      queueMicrotask(() => refreshAllLaunchpadClipLeds());
    }
  }
});

dom.midiSysex?.addEventListener("change", () => {
  try {
    localStorage.setItem(MIDI_SYSEX_SESSION_STORAGE_KEY, dom.midiSysex.checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (store.midiAccess) {
    const n = sendLaunchpadSessionSysex();
    refreshMidiStatus(n);
    if (store.pack) {
      queueMicrotask(() => refreshAllLaunchpadClipLeds());
    }
  }
});

dom.gridFlip?.addEventListener("change", () => {
  try {
    localStorage.setItem(GRID_FLIP_STORAGE_KEY, dom.gridFlip.value);
  } catch {
    /* ignore */
  }
  if (store.pack) renderGrid(store.pack);
});

dom.syncLoopTicks?.addEventListener("change", () => {
  const raw = dom.syncLoopTicks?.value;
  if (raw == null || raw === "") return;
  const t = Number(raw);
  if (!SYNC_LOOP_TICK_VALUES.includes(t)) return;
  applySyncLoopTicksUserValue(t);
});

dom.midiInput?.addEventListener("change", () => {
  try {
    localStorage.setItem(MIDI_INPUT_STORAGE_KEY, dom.midiInput.value);
  } catch {
    /* ignore */
  }
  bindMidiInputs();
});



export function boot() {
  registerLedSync(syncLaunchpadLedForLoop);
  registerColumnMutePadClassSync(applyColumnMuteWebPadForLoop);
  fillAssetSourceSelect();
  restoreSettingsFromLocalStorage();
  fillPackSelect();
  syncAssetSourceRemotePanel();
  if (getAssetSource() === "remote") {
    const remoteUrl = dom.packRemoteUrl?.value.trim() ?? "";
    if (remoteUrl) {
      loadRemotePackFromUi().catch(() => {
        applyPack(store.currentPackSlug).catch(() => {});
      });
    } else {
      applyPack(store.currentPackSlug).catch((e) => {
        if (dom.midi) dom.midi.textContent = `Load error: ${e.message ?? e}. ${assetLoadErrorHint()}`;
      });
      queueMicrotask(() => {
        if (getAssetSource() !== "remote" || dom.packRemoteUrl?.value.trim() || !dom.midi) return;
        const title = store.pack?.title ?? "pack";
        dom.midi.textContent = `Showing “${title}”. Custom URL: enter pack.json URL and click Load.`;
      });
    }
  } else {
    applyPack(store.currentPackSlug).catch((e) => {
      const baseHint = assetLoadErrorHint();
      if (dom.midi) dom.midi.textContent = `Load error: ${e.message ?? e}. ${baseHint}`;
    });
  }
}
