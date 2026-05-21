/**
 * @module presentation
 * One place to update pad playback visuals (web CSS + hardware LEDs).
 * Playback code should call these instead of toggling DOM/LED separately.
 */

import { dom } from "./dom.js";
import { store } from "./store.js";

/** @type {((loopId: string|number) => void)|null} */
let syncHardwareLedForLoop = null;
/** @type {((loopId: string|number) => void)|null} */
let syncColumnMutePadClassForLoop = null;

/**
 * Register MIDI LED sync (avoids circular import with midi module).
 * @param {(loopId: string|number) => void} fn
 */
export function registerLedSync(fn) {
  syncHardwareLedForLoop = fn;
}

/** Register column-mute web pad styling (implemented in runtime). */
export function registerColumnMutePadClassSync(fn) {
  syncColumnMutePadClassForLoop = fn;
}

export function padEl(loopId) {
  if (loopId == null || !dom.grid) return null;
  const s = String(loopId);
  const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s;
  return dom.grid.querySelector(`[data-loop-id="${esc}"]`);
}

export function padElByPadKey(padKey) {
  if (padKey == null || padKey.length < 2 || !dom.grid) return null;
  const esc =
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(padKey) : padKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return dom.grid.querySelector(`button.pad[data-pad-key="${esc}"]`);
}

/**
 * @param {string|number} loopId
 * @param {'idle'|'armed'|'playing'|'pending-off'} visual
 */
function mapHasActiveLoop(loopId) {
  if (loopId == null) return false;
  if (store.activeLoops.has(loopId)) return true;
  if (store.activeLoops.has(String(loopId))) return true;
  const n = Number(loopId);
  return Number.isFinite(n) && store.activeLoops.has(n);
}

export function setPadPlaybackVisual(loopId, visual) {
  const el = padEl(loopId);
  if (!el) {
    if (syncHardwareLedForLoop) syncHardwareLedForLoop(loopId);
    return;
  }
  const stillPlaying = visual === "playing" || visual === "pending-off";
  el.classList.toggle("active", stillPlaying);
  el.classList.toggle("armed", visual === "armed");
  el.classList.toggle("pending-off", visual === "pending-off");
  const id = String(loopId);
  if (visual === "pending-off") store.pendingQuantizedStopLoopIds.add(id);
  else store.pendingQuantizedStopLoopIds.delete(id);
  if (syncColumnMutePadClassForLoop) syncColumnMutePadClassForLoop(loopId);
  if (syncHardwareLedForLoop) syncHardwareLedForLoop(loopId);
}

/** @deprecated Prefer setPadPlaybackVisual; kept for incremental migration inside runtime. */
export function setPadDomActive(loopId, on) {
  setPadPlaybackVisual(loopId, on ? "playing" : "idle");
}

export function setPadArmed(loopId, on) {
  if (on) setPadPlaybackVisual(loopId, "armed");
  else {
    const el = padEl(loopId);
    if (el?.classList.contains("active")) setPadPlaybackVisual(loopId, "playing");
    else setPadPlaybackVisual(loopId, "idle");
  }
}

export function setPadPendingOff(loopId, on) {
  if (on) setPadPlaybackVisual(loopId, "pending-off");
  else if (mapHasActiveLoop(loopId)) setPadPlaybackVisual(loopId, "playing");
  else {
    const el = padEl(loopId);
    if (el?.classList.contains("armed")) setPadPlaybackVisual(loopId, "armed");
    else setPadPlaybackVisual(loopId, "idle");
  }
}
