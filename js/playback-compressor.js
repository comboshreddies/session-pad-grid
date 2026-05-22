/**
 * @module playback-compressor
 * Per-voice dynamics compressor after spectrum EQ, before distortion.
 */

/** @typedef {{ thresholdStep: number, ratioStep: number, makeupStep: number }} ClipCompressorParams */

const THRESHOLD_FLOOR_DB = -54;
const THRESHOLD_CEIL_DB = -8;
const RATIO_VALUES = [1.5, 2, 4, 12];
/** Makeup steps 1…8 → dB (step 1 ≈ 0 dB). */
const MAKEUP_DB = [0, 2, 4, 7, 10, 13, 16, 20];

/**
 * @param {number} step 1…8
 */
export function thresholdDbFromStep(step) {
  const s = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  const t = (s - 1) / 7;
  return THRESHOLD_FLOOR_DB + (THRESHOLD_CEIL_DB - THRESHOLD_FLOOR_DB) * t;
}

/**
 * @param {number} step 1…4 (H1…H4)
 */
export function ratioFromStep(step) {
  const s = Math.max(1, Math.min(4, Math.floor(Number(step)) || 1));
  return RATIO_VALUES[s - 1] ?? 2;
}

/**
 * @param {number} step 1…8 (H5…H8 → steps 5…8)
 */
export function makeupDbFromStep(step) {
  const s = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  return MAKEUP_DB[s - 1] ?? 0;
}

/**
 * @param {AudioContext} ctx
 * @param {import('./playback-stereo.js').StereoVoice & {
 *   compressor?: DynamicsCompressorNode,
 *   compressorMakeup?: GainNode,
 *   compressorTail?: AudioNode,
 *   eqTail?: AudioNode,
 * }} voice
 */
export function attachCompressorToVoice(ctx, voice) {
  if (!voice?.merger || !voice?.gain) return voice;
  const input = voice.eqTail ?? voice.merger;
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 6;
  comp.attack.value = 0.008;
  comp.release.value = 0.12;
  const makeup = ctx.createGain();
  try {
    input.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.merger.disconnect(voice.gain);
  } catch {
    /* ignore */
  }
  input.connect(comp);
  comp.connect(makeup);
  voice.compressor = comp;
  voice.compressorMakeup = makeup;
  voice.compressorTail = makeup;
  return voice;
}

/**
 * @param {import('./playback-stereo.js').StereoVoice & {
 *   compressor?: DynamicsCompressorNode,
 *   compressorMakeup?: GainNode,
 * }} voice
 * @param {ClipCompressorParams} params
 */
export function applyClipCompressorToVoice(voice, params) {
  if (!voice?.compressor || !voice?.compressorMakeup) return;
  const thr = Math.max(1, Math.min(8, Math.floor(Number(params?.thresholdStep)) || 8));
  const ratio = Math.max(1, Math.min(4, Math.floor(Number(params?.ratioStep)) || 1));
  const makeup = Math.max(1, Math.min(8, Math.floor(Number(params?.makeupStep)) || 1));
  voice.compressor.threshold.value = thresholdDbFromStep(thr);
  voice.compressor.ratio.value = ratioFromStep(ratio);
  const db = makeupDbFromStep(makeup);
  voice.compressorMakeup.gain.value = 10 ** (db / 20);
}

/** @returns {ClipCompressorParams} */
export function defaultClipCompressorParams() {
  return { thresholdStep: 8, ratioStep: 1, makeupStep: 1 };
}
