/**
 * @module session-slice
 * Pack `session.channels` scrolling and visible 6-row window (A–F).
 */

import { LAUNCHPAD_CLIP_SESSION_ROW_COUNT } from "./config.js";

export function buildVisibleSessionSlice(fullChannels, scrollOffset, nCols) {
  const out = [];
  const off = Math.max(0, Math.floor(Number(scrollOffset)) || 0);
  for (let c = 0; c < nCols; c += 1) {
    const col = fullChannels[c] || [];
    const vis = [];
    for (let r = 0; r < LAUNCHPAD_CLIP_SESSION_ROW_COUNT; r += 1) {
      const slot = col[off + r];
      vis.push(slot != null && typeof slot === "object" ? slot : {});
    }
    out.push(vis);
  }
  return out;
}

export function getSessionScrollMaxOffsetFromFull(fullChannels) {
  if (!fullChannels || fullChannels.length === 0) return 0;
  let maxH = 0;
  for (const col of fullChannels) {
    maxH = Math.max(maxH, col?.length ?? 0);
  }
  return Math.max(0, maxH - LAUNCHPAD_CLIP_SESSION_ROW_COUNT);
}
