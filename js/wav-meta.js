/**
 * @module wav-meta
 * Lightweight WAV header reads (no full decode).
 */

/**
 * @param {ArrayBuffer} arr
 * @returns {number|null} channel count, or null if not a readable PCM WAV
 */
export function wavChannelCountFromArrayBuffer(arr) {
  const v = new DataView(arr);
  const n = arr.byteLength;
  if (n < 12) return null;
  const four = (o) =>
    String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (four(0) !== "RIFF" || four(8) !== "WAVE") return null;
  let o = 12;
  while (o + 8 <= n) {
    const id = four(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt " && o + 16 <= n) return v.getUint16(o + 10, true);
    o += 8 + size + (size & 1);
  }
  return null;
}

/** @param {number|null|undefined} ch */
export function clipChannelMark(ch) {
  if (ch == null || !Number.isFinite(ch)) return "";
  return ch >= 2 ? "s" : "m";
}

/** @param {number|null|undefined} ch */
export function clipChannelModeLabel(ch) {
  if (ch == null || !Number.isFinite(ch)) return "";
  return ch >= 2 ? "stereo" : "mono";
}
