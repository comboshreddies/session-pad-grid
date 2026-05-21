/**
 * @module settings
 * User preferences from DOM + localStorage keys (immutable names in config).
 */

import {
  ASSET_LOCAL,
  ASSET_NOVATION_CDN,
  ASSET_NOVATION_PROXY,
  ASSET_SOURCE_STORAGE_KEY,
  LAYOUT_STORAGE_KEY,
  GRID_FLIP_STORAGE_KEY,
} from "./config.js";
import { dom } from "./dom.js";
import { store } from "./store.js";

export { LAYOUT_STORAGE_KEY, GRID_FLIP_STORAGE_KEY };

export function getPadLayout() {
  return dom.midiLayout?.value === "classic" ? "classic" : "modern";
}

/** @returns {"local"|"proxy"|"remote"} */
export function getAssetSource() {
  const v = dom.assetSource?.value;
  if (v === "proxy") return "proxy";
  if (v === "remote") return "remote";
  return "local";
}

/** True when the app is served from GitHub Pages (no `server.py` /novation/ proxy). */
export function isGitHubPagesHost() {
  if (typeof window === "undefined") return false;
  const host = (window.location.hostname || "").toLowerCase();
  return host === "github.io" || host.endsWith(".github.io");
}

export function assetBase() {
  if (getAssetSource() === "remote") return ASSET_LOCAL;
  if (getAssetSource() !== "proxy") return ASSET_LOCAL;
  if (!isGitHubPagesHost()) return ASSET_NOVATION_PROXY;
  return ASSET_NOVATION_CDN;
}

export function assetLoadErrorHint() {
  if (getAssetSource() === "remote") {
    return "Enter pack.json URL, click Load. Host needs CORS (* or your origin). With COEP on this page, remote assets also need Cross-Origin-Resource-Policy: cross-origin.";
  }
  if (getAssetSource() === "proxy") {
    return isGitHubPagesHost()
      ? "GitHub Pages has no /novation/ proxy — use Local soundlib or Custom URL."
      : "Needs python3 server.py on this host so novation/ is proxied same-origin (not plain http.server).";
  }
  return isGitHubPagesHost()
    ? "Commit packs under soundlib/<slug>/ in the repo (see scripts/download_soundlib.py)."
    : "Run: python3 scripts/download_soundlib.py <slug> then python3 server.py — or python3 -m http.server if soundlib/ is already populated.";
}

/** Build asset source options (Novation proxy omitted on GitHub Pages). */
export function fillAssetSourceSelect() {
  const sel = dom.assetSource;
  if (!sel) return;
  let saved = "local";
  try {
    const v = localStorage.getItem(ASSET_SOURCE_STORAGE_KEY);
    if (v === "local" || v === "proxy" || v === "remote") saved = v;
  } catch {
    /* ignore */
  }
  if (saved === "proxy" && isGitHubPagesHost()) saved = "local";

  sel.replaceChildren();
  const local = document.createElement("option");
  local.value = "local";
  local.textContent = "Local soundlib";
  sel.append(local);
  if (!isGitHubPagesHost()) {
    const proxy = document.createElement("option");
    proxy.value = "proxy";
    proxy.textContent = "Novation (local proxy)";
    sel.append(proxy);
  }
  const remote = document.createElement("option");
  remote.value = "remote";
  remote.textContent = "Custom URL (pack.json)";
  sel.append(remote);

  const allowed = [...sel.options].map((o) => o.value);
  sel.value = allowed.includes(saved) ? saved : "local";
}

/** Show pack.json URL field only for Custom URL; dim sample set unless a remote catalog is loaded. */
export function syncAssetSourceRemotePanel() {
  const isRemote = getAssetSource() === "remote";
  const hasCatalog = isRemote && (store.remoteCatalogEntries?.length ?? 0) > 0;
  if (dom.assetSourceRemotePanel) dom.assetSourceRemotePanel.hidden = !isRemote;
  if (dom.pack) dom.pack.disabled = isRemote && !hasCatalog;
  dom.gridToolbarSampleSet?.classList.toggle("grid-toolbar-dimmed", isRemote && !hasCatalog);
}

export function getGridFlip() {
  const v = dom.gridFlip?.value;
  if (v === "row" || v === "col" || v === "both") return v;
  return "none";
}

/**
 * Novation “display” cell (column index, row A=0… within clip height) → logical session indices.
 * Same transform is used when rendering so the on-screen grid matches hardware after flips.
 */
export function applySessionGridFlip(col, sessionRow, nCols, nRows) {
  let c = col;
  let r = sessionRow;
  const f = getGridFlip();
  if ((f === "row" || f === "both") && sessionRow < nRows) {
    r = nRows - 1 - sessionRow;
  }
  if (f === "col" || f === "both") {
    c = nCols - 1 - col;
  }
  return { col: c, sessionRow: r };
}

/** Column part of Session grid flip only (for G/H rows: row flip does not apply). */
export function logicalColForPadCol(padColIndex, nCols) {
  const f = getGridFlip();
  if (f === "col" || f === "both") return nCols - 1 - padColIndex;
  return padColIndex;
}

/** Clip matrix rows: pack JSON order (A at top, … F, then G/H strips). */
export const CLIP_GRID_ROW_ORDER_PACK = [0, 1, 2, 3, 4, 5, 6, 7];

export function setMidiDebugLine(parts) {
  if (!dom.midiDebug) return;
  dom.midiDebug.hidden = false;
  dom.midiDebug.textContent = Array.isArray(parts) ? parts.filter(Boolean).join(" · ") : String(parts);
}
