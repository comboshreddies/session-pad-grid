/**
 * @module init-settings
 * Restore UI controls from localStorage on startup.
 */

import {
  LAYOUT_STORAGE_KEY,
  GRID_FLIP_STORAGE_KEY,
  MIDI_SYSEX_SESSION_STORAGE_KEY,
  ASSET_SOURCE_STORAGE_KEY,
  SYNC_LOOP_TICKS_STORAGE_KEY,
  CUSTOM_PACK_URL_STORAGE_KEY,
} from "./config.js";
import { dom } from "./dom.js";
import { store } from "./store.js";
import { migrateStorageKeysFromV0, migrateSyncLoopTicksFromV0 } from "./storage-migrate.js";
import { syncAssetSourceRemotePanel } from "./settings.js";

export function restoreSettingsFromLocalStorage() {
  migrateStorageKeysFromV0();
  migrateSyncLoopTicksFromV0();
  try {
    const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (saved === "classic" || saved === "modern") dom.midiLayout.value = saved;
  } catch {
    /* ignore */
  }
  try {
    const gf = localStorage.getItem(GRID_FLIP_STORAGE_KEY);
    if (dom.gridFlip) {
      if (gf === "none" || gf === "row" || gf === "col" || gf === "both") dom.gridFlip.value = gf;
      else dom.gridFlip.value = "none";
    }
  } catch {
    /* ignore */
  }
  try {
    const allowed = new Set(["0", "1", "2", "4", "8", "16"]);
    const st = localStorage.getItem(SYNC_LOOP_TICKS_STORAGE_KEY);
    if (st != null && allowed.has(st)) {
      store.syncLoopTicksState = Number(st);
      if (dom.syncLoopTicks) dom.syncLoopTicks.value = st;
    } else if (dom.syncLoopTicks && allowed.has(dom.syncLoopTicks.value)) {
      store.syncLoopTicksState = Number(dom.syncLoopTicks.value);
    }
  } catch {
    /* ignore */
  }
  try {
    let v = localStorage.getItem(ASSET_SOURCE_STORAGE_KEY);
    if (v === "direct") {
      v = "proxy";
      try {
        localStorage.setItem(ASSET_SOURCE_STORAGE_KEY, v);
      } catch {
        /* ignore */
      }
    }
    if (v !== "local" && v !== "proxy" && v !== "remote") v = "local";
    if (dom.assetSource && (v === "local" || v === "proxy" || v === "remote")) {
      const allowed = [...dom.assetSource.options].map((o) => o.value);
      dom.assetSource.value = allowed.includes(v) ? v : "local";
    }
  } catch {
    /* ignore */
  }
  try {
    const sx = localStorage.getItem(MIDI_SYSEX_SESSION_STORAGE_KEY);
    if (dom.midiSysex && (sx === "1" || sx === "0")) dom.midiSysex.checked = sx === "1";
  } catch {
    /* ignore */
  }
  try {
    const remote = localStorage.getItem(CUSTOM_PACK_URL_STORAGE_KEY);
    if (dom.packRemoteUrl && remote) dom.packRemoteUrl.value = remote;
  } catch {
    /* ignore */
  }
  syncAssetSourceRemotePanel();
}
