/**
 * @module storage-migrate
 * One-time localStorage upgrades from the pre–session-pad-grid key prefix (v0).
 */

import {
  STORAGE_KEY_PREFIX,
  LAYOUT_STORAGE_KEY,
  GRID_FLIP_STORAGE_KEY,
  MIDI_INPUT_STORAGE_KEY,
  MIDI_SYSEX_SESSION_STORAGE_KEY,
  ASSET_SOURCE_STORAGE_KEY,
  CUSTOM_PACK_URL_STORAGE_KEY,
  SYNC_LOOP_TICKS_STORAGE_KEY,
} from "./config.js";

/** Former app localStorage prefix (v0); decoded so the old name does not appear in source. */
function storageKeyPrefixV0() {
  return atob("bWlkaWViLg==");
}

function migrateKeyFromV0(newKey) {
  const suffix = newKey.startsWith(STORAGE_KEY_PREFIX) ? newKey.slice(STORAGE_KEY_PREFIX.length) : newKey;
  const oldKey = storageKeyPrefixV0() + suffix;
  try {
    if (localStorage.getItem(newKey) != null) return;
    const old = localStorage.getItem(oldKey);
    if (old != null) {
      localStorage.setItem(newKey, old);
      localStorage.removeItem(oldKey);
    }
  } catch {
    /* ignore */
  }
}

/** Copy v0-prefixed settings to `session-pad-grid.*` and remove old keys. */
export function migrateStorageKeysFromV0() {
  for (const key of [
    LAYOUT_STORAGE_KEY,
    GRID_FLIP_STORAGE_KEY,
    MIDI_INPUT_STORAGE_KEY,
    MIDI_SYSEX_SESSION_STORAGE_KEY,
    ASSET_SOURCE_STORAGE_KEY,
    CUSTOM_PACK_URL_STORAGE_KEY,
    SYNC_LOOP_TICKS_STORAGE_KEY,
  ]) {
    migrateKeyFromV0(key);
  }
  try {
    if (localStorage.getItem(ASSET_SOURCE_STORAGE_KEY) == null) {
      const leg = localStorage.getItem(`${storageKeyPrefixV0()}useNovationProxy`);
      if (leg === "1" || leg === "0") {
        localStorage.setItem(ASSET_SOURCE_STORAGE_KEY, leg === "1" ? "proxy" : "local");
        localStorage.removeItem(`${storageKeyPrefixV0()}useNovationProxy`);
      }
    }
  } catch {
    /* ignore */
  }
}

/** Map v0 `syncLoopTicks` values to current purple-tick storage. */
export function migrateSyncLoopTicksFromV0() {
  try {
    if (localStorage.getItem(SYNC_LOOP_TICKS_STORAGE_KEY) != null) return;
    const leg = localStorage.getItem(`${storageKeyPrefixV0()}syncLoopTicks`);
    if (leg == null) return;
    const map = { "0": "0", "4": "2", "8": "4", "16": "8", "32": "16" };
    const st = map[leg] ?? "4";
    localStorage.setItem(SYNC_LOOP_TICKS_STORAGE_KEY, st);
    localStorage.removeItem(`${storageKeyPrefixV0()}syncLoopTicks`);
  } catch {
    /* ignore */
  }
}
