/**
 * @module playback-distortion
 * Per-voice waveshaper + tone LPF after the stereo-pan merger (before voice gain).
 */

/** @typedef {{ drive: number, oversample: 0|1|2, softClip: boolean, tone: number }} ClipDistortionParams */

const OVERSAMPLE_MODES = ["none", "2x", "4x"];
const TONE_CUTOFF_HZ = [20000, 12000, 6000, 3000, 1500];

/**
 * @param {number} driveStep 1…8
 * @param {boolean} softClip
 * @returns {Float32Array}
 */
export function makeDistortionCurve(driveStep, softClip) {
  const n = 2048;
  const curve = new Float32Array(n);
  const step = Math.max(1, Math.min(8, Math.floor(Number(driveStep)) || 1));
  const amount = 0.35 + (step - 1) * (3.8 / 7);
  const k = amount * 8;
  for (let i = 0; i < n; i += 1) {
    const x = (i * 2) / n - 1;
    if (softClip) {
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    } else {
      const y = k * x;
      curve[i] = Math.max(-1, Math.min(1, y));
    }
  }
  return curve;
}

/** @param {0|1|2} mode */
export function oversampleModeFromIndex(mode) {
  return OVERSAMPLE_MODES[Math.max(0, Math.min(2, mode | 0))] ?? "none";
}

/**
 * @param {AudioContext} ctx
 * @param {import('./playback-stereo.js').StereoVoice & { distortionDrive?: WaveShaperNode, toneFilter?: BiquadFilterNode }} voice
 * @returns {typeof voice}
 */
export function attachDistortionToVoice(ctx, voice) {
  if (!voice?.merger || !voice?.gain) return voice;
  const drive = ctx.createWaveShaper();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  try {
    voice.merger.disconnect(voice.gain);
  } catch {
    /* ignore */
  }
  voice.merger.connect(drive);
  drive.connect(tone);
  tone.connect(voice.gain);
  voice.distortionDrive = drive;
  voice.toneFilter = tone;
  return voice;
}

/**
 * @param {import('./playback-stereo.js').StereoVoice & { distortionDrive?: WaveShaperNode, toneFilter?: BiquadFilterNode }} voice
 * @param {ClipDistortionParams} params
 */
export function applyClipDistortionToVoice(voice, params) {
  if (!voice?.distortionDrive || !voice?.toneFilter) return;
  const drive = Math.max(1, Math.min(8, Math.floor(Number(params?.drive)) || 1));
  const soft = params?.softClip !== false;
  voice.distortionDrive.curve = makeDistortionCurve(drive, soft);
  voice.distortionDrive.oversample = oversampleModeFromIndex(params?.oversample ?? 0);
  const tone = Math.max(0, Math.min(4, Math.floor(Number(params?.tone)) || 0));
  const hz = TONE_CUTOFF_HZ[tone] ?? TONE_CUTOFF_HZ[0];
  voice.toneFilter.frequency.value = hz;
  voice.toneFilter.Q.value = tone > 0 ? 0.707 : 0.0001;
}

/** @returns {ClipDistortionParams} */
export function defaultClipDistortionParams() {
  return { drive: 1, oversample: 0, softClip: true, tone: 0 };
}
