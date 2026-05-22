/**
 * @module playback-spectrum-eq
 * Per-voice high-pass + low-pass (spectrum steps 1…8) before distortion.
 */

/** @typedef {{ highPassStep: number, lowPassStep: number }} ClipSpectrumEqParams */

const HP_FLOOR_HZ = 35;
const HP_CEIL_HZ = 14000;
const LP_CEIL_HZ = 20000;
const LP_FLOOR_HZ = 120;

/**
 * Map step 1…8 → log-spaced cutoff (1/8 … 8/8 of sweep).
 * @param {number} step
 * @param {number} lo
 * @param {number} hi
 */
function cutoffHzFromStep(step, lo, hi) {
  const s = Math.max(1, Math.min(8, Math.floor(Number(step)) || 1));
  const t = (s - 1) / 7;
  return lo * (hi / lo) ** t;
}

/** @param {number} step 1…8 — higher = more highs kept (higher HPF cutoff). */
export function highPassCutoffHzFromStep(step) {
  return cutoffHzFromStep(step, HP_FLOOR_HZ, HP_CEIL_HZ);
}

/** @param {number} step 1…8 — higher = more highs kept (higher LPF cutoff). */
export function lowPassCutoffHzFromStep(step) {
  return cutoffHzFromStep(step, LP_FLOOR_HZ, LP_CEIL_HZ);
}

/**
 * @param {AudioContext} ctx
 * @param {import('./playback-stereo.js').StereoVoice & { spectrumHighPass?: BiquadFilterNode, spectrumLowPass?: BiquadFilterNode, eqTail?: AudioNode }} voice
 */
export function attachSpectrumEqToVoice(ctx, voice) {
  if (!voice?.merger || !voice?.gain) return voice;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = HP_FLOOR_HZ;
  hp.Q.value = 0.707;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = LP_CEIL_HZ;
  lp.Q.value = 0.707;
  try {
    voice.merger.disconnect(voice.gain);
  } catch {
    /* ignore */
  }
  voice.merger.connect(hp);
  hp.connect(lp);
  voice.spectrumHighPass = hp;
  voice.spectrumLowPass = lp;
  voice.eqTail = lp;
  return voice;
}

/**
 * @param {import('./playback-stereo.js').StereoVoice & { spectrumHighPass?: BiquadFilterNode, spectrumLowPass?: BiquadFilterNode }} voice
 * @param {ClipSpectrumEqParams} params
 */
export function applyClipSpectrumEqToVoice(voice, params) {
  if (!voice?.spectrumHighPass || !voice?.spectrumLowPass) return;
  const hp = Math.max(1, Math.min(8, Math.floor(Number(params?.highPassStep)) || 1));
  const lp = Math.max(1, Math.min(8, Math.floor(Number(params?.lowPassStep)) || 8));
  voice.spectrumHighPass.frequency.value = highPassCutoffHzFromStep(hp);
  voice.spectrumLowPass.frequency.value = lowPassCutoffHzFromStep(lp);
}

/** @returns {ClipSpectrumEqParams} */
export function defaultClipSpectrumEqParams() {
  return { highPassStep: 1, lowPassStep: 8 };
}
