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
  LP_SESSION_STRIP_H_IDLE,
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
 * (e.g. raw 35 → 5F, should be 51 → 1D). Do not apply +16 when the raw decode is already in cols 1–4
 * (that wrongly mapped 1B → 7A and broke clip triggers / volume selection on demo-pulse cols 1–6).
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
    directP.rowIdx <= LAUNCHPAD_CLIP_SESSION_MAX_ROW &&
    bumpedP.rowIdx <= LAUNCHPAD_CLIP_SESSION_MAX_ROW &&
    directP.col >= 4 &&
    bumpedP.col < directP.col &&
    directP.col - bumpedP.col >= 4
  ) {
    return bumped;
  }
  return direct;
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
  /** Many Arcade `pack.json` loops omit `kind`; `category` is the next-best “kind” axis (see `scripts/download_soundlib.py`). */
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
 * `loop.url` after `scripts/download_soundlib.py` is like `slug/cat/type/kind/name/file.wav` (≥4 dirs before file).
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
      output.send(new Uint8Array([0xb0, MINI_MK3_CLIP_KIND_LEGEND_CC & 0x7f, kindTopLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_CLIP_TYPE_LEGEND_CC & 0x7f, typeSceneLed]));
      output.send(new Uint8Array([0xb0, MINI_MK3_STEREO_PAN_CC & 0x7f, stereoPanLed]));
    } catch (err) {
      console.warn("Launchpad Mini MK3 pack-nav LED (CC) failed:", name, err);
    }
  });
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
  applyPack(slug).catch((e) => {
    dom.midi.textContent = `Load error: ${e.message ?? e}. ${assetLoadErrorHint()}`;
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
    if (store.g6StereoPanMenuHeld || store.g7VolumeMenuHeld) continue;
    const defaultNm = pad.dataset.stripGNmDefault ?? "mute col";
    nm.textContent = stopCol ? "stop col" : defaultNm;
  }
}

function clearHStopModifierPhysicalCols() {
  if (store.hStopModifierPhysicalCols.size === 0) return;
  store.hStopModifierPhysicalCols.clear();
  applyHStopModifierWebClasses();
  if (store.midiAccess && !store.g7VolumeMenuHeld && !store.g6StereoPanMenuHeld) {
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

function rememberLoopChannelCount(url, ch) {
  if (!url || ch == null || !Number.isFinite(ch) || ch < 1) return;
  store.loopChannelCountByUrl.set(url, ch);
}

function getLoopChannelCount(loop) {
  if (!loop?.url) return null;
  const cached = store.loopChannelCountByUrl.get(loop.url);
  if (cached != null) return cached;
  const buf = store.bufferCache.get(loop.url);
  if (buf) {
    rememberLoopChannelCount(loop.url, buf.numberOfChannels);
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
  if (ch != null) rememberLoopChannelCount(loop.url, ch);
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
  const voice = wireBufferSourceWithStereoPan(store.audioCtx, src, connectVoiceToMaster);
  voice.gainVelNorm = velN;
  applyVoiceGainLevels(voice, loopId, loop);
  return voice;
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

/** Restore row **H** strip pad LEDs (`1H`…`8H`) after **8G** volume menu — clock refresh only updated **8H** before. */
function refreshLaunchpadStripRowHIdleHardware() {
  if (!store.midiAccess || !store.pack || store.g7VolumeMenuHeld || store.g6StereoPanMenuHeld) return;
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
  else refreshLaunchpadStripRowHIdleHardware();
}

function updateWebSyncClockRowG(tickCol) {
  if (!dom.grid || store.g6StereoPanMenuHeld) return;
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

function fillPackSelectLocal() {
  rebuildPackSelect(SAMPLE_PACKS);
  const slug =
    SAMPLE_PACKS.some((p) => p.slug === store.currentPackSlug) ?
      store.currentPackSlug
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
  if (store.remotePackBaseUrl && store.currentPackSlug) {
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
  if (usesClassicSessionNoteMap(midiInputPortName)) {
    return classicPad ?? modernPad;
  }
  if (dom.midiSysex?.checked && isMobileSessionHost()) {
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
  const bumped = note + 16 <= 127 ? noteToPadClassic[String(note + 16)] ?? null : null;
  return `raw classic ${direct} → ${padKey}${bumped && bumped !== padKey ? ` (mobile +16 fix from note ${note + 16})` : ""}`;
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
  const key = loop.url;
  if (store.bufferCache.has(key)) return store.bufferCache.get(key);
  const ctx = await ensureAudio();
  const res = await fetch(absoluteUrl(loop.url), { cache: "no-store" });
  if (!res.ok) throw new Error(`wav ${res.status}`);
  const arr = await res.arrayBuffer();
  const buf = await ctx.decodeAudioData(arr.slice(0));
  store.bufferCache.set(key, buf);
  rememberLoopChannelCount(key, buf.numberOfChannels);
  return buf;
}

async function preloadPackLoops(packState) {
  store.bufferCache.clear();
  const top = packState.raw.loops.slice(0, 12);
  await Promise.all(top.map((l) => getBuffer(l).catch(() => null)));
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
  if (store.clipKindLegendHeld || store.clipTypeLegendHeld) syncClipLegendWebStyling();
  refreshClipVolumeLevelBadges();
  refreshClipPanBars();
  refreshClipChannelBadges();
}

function renderGrid(packState) {
  clearHStopModifierPhysicalCols();
  if (!dom.grid || !dom.cols || !packState) return;
  setG7VolumeMenuHeld(false);
  setG6StereoPanMenuHeld(false);
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
              if (store.g6StereoPanMenuHeld) {
                applyG6LeftPanStep(8);
                return;
              }
              setG7VolumeMenuHeld(true);
            },
            onRelease: () => {
              if (store.g6StereoPanMenuHeld) return;
              releaseG7VolumeMenuPointer();
            },
            onToggleLatch: () => {
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
              if (store.g6StereoPanMenuHeld || store.g7VolumeMenuHeld) return;
              releaseH8ClockStripMenuPointer();
            },
            onToggleLatch: () => {
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
            if (store.g6StereoPanMenuHeld) return;
            unmuteStrip();
            try {
              pad.releasePointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
          });
          pad.addEventListener("pointercancel", (ev) => {
            if (store.g6StereoPanMenuHeld) return;
            unmuteStrip();
          });
          pad.addEventListener("lostpointercapture", (ev) => {
            if (store.g6StereoPanMenuHeld) return;
            unmuteStrip();
          });
          pad.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          });
        } else {
          const releaseHStopModifier = () => setHStopModifierHeld(dc, false);
          pad.addEventListener("pointerdown", async (ev) => {
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
            if (!store.g6StereoPanMenuHeld && !store.g7VolumeMenuHeld) releaseHStopModifier();
            try {
              pad.releasePointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
          });
          pad.addEventListener("pointercancel", (ev) => {
            if (!store.g6StereoPanMenuHeld && !store.g7VolumeMenuHeld) releaseHStopModifier();
          });
          pad.addEventListener("lostpointercapture", (ev) => {
            if (!store.g6StereoPanMenuHeld && !store.g7VolumeMenuHeld) releaseHStopModifier();
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
            if (store.g6StereoPanMenuHeld || store.g7VolumeMenuHeld) {
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

async function applyPackFromUrl(packJsonUrl) {
  const token = ++store.packLoadToken;
  stopAllLoops();
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
  preloadPackLoops(store.pack).catch(() => {});
}

async function applyPack(slug) {
  const token = ++store.packLoadToken;
  stopAllLoops();
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
    if (token === store.packLoadToken) throw e;
    return;
  }
  if (token !== store.packLoadToken) return;
  setRemotePackUiStatus("idle");
  store.currentPackSlug = slug;
  store.pack = nextState;
  store.loopChannelCountByUrl.clear();
  renderGrid(store.pack);
  probeAllPackChannelCounts(store.pack).catch(() => {});
  if (store.midiAccess) {
    const n = sendLaunchpadSessionSysex();
    refreshMidiStatus(n);
  } else {
    let msg = `Loaded “${store.pack.title}” (${store.pack.nCols}×${store.pack.nRows}). Connect MIDI when ready.`;
    if ((store.pack.nSessionRowsFull ?? 0) > LAUNCHPAD_CLIP_SESSION_ROW_COUNT) {
      msg += ` · Pack has ${store.pack.nSessionRowsFull} session rows per column; only six clip rows (A–F) fit the grid — on **Launchpad Mini MK3** use the **DAW** input **▲/▼** above the matrix to scroll rows (G/H stay mute/stop).`;
    }
    dom.midi.textContent = msg;
  }
  preloadPackLoops(store.pack).catch(() => {});
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
    if (portLooksLikeLaunchpadMiniMk3(port) && /\bdaw\b/i.test(port)) {
      if (d1 === MINI_MK3_CLIP_KIND_LEGEND_CC && store.clipKindLegendHeld) {
        endClipKindLegendHold();
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          `CC ${d1} val 0`,
          "Mini MK3 · kind legend released (grid back to normal)",
        ]);
        return;
      }
      if (d1 === MINI_MK3_CLIP_TYPE_LEGEND_CC && store.clipTypeLegendHeld) {
        endClipTypeLegendHold();
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          `CC ${d1} val 0`,
          "Mini MK3 · type legend released (grid back to normal)",
        ]);
        return;
      }
      if (d1 === MINI_MK3_STEREO_PAN_CC && store.g6StereoPanMenuHeld) {
        setG6StereoPanMenuHeld(false);
        setMidiDebugLine([
          port.slice(0, 56),
          raw,
          `CC ${d1} val 0`,
          "Mini MK3 · stereo pan released (right column row 3)",
        ]);
        return;
      }
    }
    return;
  }
  if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
    if (store.pack) {
      const rPad = padKeyFromNote(d1, port);
      const rp = rPad ? parsePadKey(rPad) : null;
      if (rp && rp.rowIdx === 6) {
        if (rPad === "8G") {
          if (!store.g6StereoPanMenuHeld) setG7VolumeMenuHeld(false);
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            rPad,
            store.g6StereoPanMenuHeld
              ? "strip G8 · note off ignored during stereo pan menu"
              : "strip 8G · volume menu released (column 8 strip is volume UI, not mute)",
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
      if (portLooksLikeLaunchpadMiniMk3(port) && /\bdaw\b/i.test(port)) {
        if (d1 === MINI_MK3_CLIP_KIND_LEGEND_CC) {
          if (store.pack) startClipKindLegendHold();
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            `CC ${d1} val ${d2}`,
            "Mini MK3 · **hold** — kind / category colours on clip pads",
          ]);
          return;
        }
        if (d1 === MINI_MK3_CLIP_TYPE_LEGEND_CC) {
          if (store.pack) startClipTypeLegendHold();
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            `CC ${d1} val ${d2}`,
            "Mini MK3 · **hold** — loop **type** colours on clip pads",
          ]);
          return;
        }
        if (d1 === MINI_MK3_STEREO_PAN_CC) {
          if (store.pack) setG6StereoPanMenuHeld(true);
          setMidiDebugLine([
            port.slice(0, 56),
            raw,
            `CC ${d1} val ${d2}`,
            "Mini MK3 · **hold** — stereo pan (right col row 3); H=right G=left",
          ]);
          return;
        }
      }
      const ghostPad = padKeyFromNote(d1, port);
      const mk3Side = portLooksLikeLaunchpadMiniMk3(port) ? miniMk3PanelRightCcLabel(d1) : null;
      if (ghostPad || mk3Side) {
        const parts = [port.slice(0, 56), raw, `CC ${d1} val ${d2}`];
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

  const padKey = padKeyFromNote(noteNum, port);

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
  setMidiDebugLine([
    port.slice(0, 56),
    raw,
    `note ${noteNum}`,
    padKey,
    mapHint,
    mobileFix,
    flipPackHint || null,
    loopId != null ? `loop ${loopId}` : null,
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

dom.pack.addEventListener("change", () => {
  if (getAssetSource() === "remote") {
    const entry = store.remoteCatalogEntries?.find((e) => e.slug === dom.pack?.value);
    if (!entry) return;
    setRemotePackUiStatus("loading", `Loading “${entry.title}”…`);
    applyPackFromUrl(entry.packJsonUrl).catch((e) => {
      const hint = remotePackFetchErrorHint(e);
      setRemotePackUiStatus("error", `✗ ${e.message ?? e}${hint}`);
      if (dom.midi) dom.midi.textContent = `Load error: ${e.message ?? e}.${hint}`;
    });
    return;
  }
  applyPack(dom.pack.value).catch((e) => {
    dom.midi.textContent = `Load error: ${e.message ?? e}`;
  });
});

dom.btnLoadRemotePack?.addEventListener("click", () => {
  loadRemotePackFromUi();
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
