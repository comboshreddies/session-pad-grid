/**
 * @module playback-reverb
 * Post-delay algorithmic reverb (convolver IR) with pre-delay and wet/dry mix.
 */

/** @typedef {{ decayStep: number, roomStep: number, preDelayStep: number, mixStep: number }} ClipReverbParams */

const MAX_PRE_DELAY_SEC = 0.12;
const DECAY_SEC = [0.5, 1.2, 2.5, 5];
const PRE_DELAY_SEC = [0, 0.033, 0.066, 0.1];
const MIX_WET = [0.12, 0.32, 0.55, 0.88];

/**
 * @param {AudioContext} ctx
 * @param {number} decaySec
 * @param {number} roomStep 1…4
 */
function buildReverbIR(ctx, decaySec, roomStep) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(decaySec * rate));
  const ch = 2;
  const buf = ctx.createBuffer(ch, len, rate);
  const room = Math.max(1, Math.min(4, Math.floor(roomStep) || 1));
  const density = 0.35 + room * 0.18;
  const earlyMs = [0.012, 0.028, 0.045, 0.07][room - 1] ?? 0.028;
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    let seed = 12345 + room * 97 + c * 31;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 0xffffffff) * 2 - 1;
    };
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const env = Math.exp((-4.2 * t) / decaySec);
      const early =
        t < earlyMs ? rnd() * (0.15 + room * 0.08) * (1 - t / earlyMs) : 0;
      d[i] = (rnd() * env * density + early) * (c === 0 ? 1 : 0.94);
    }
  }
  return buf;
}

/**
 * @param {AudioContext} ctx
 * @param {import('./playback-stereo.js').StereoVoice & {
 *   delayTail?: AudioNode,
 *   delaySum?: GainNode,
 *   reverbDry?: GainNode,
 *   reverbPreDelay?: DelayNode,
 *   reverbConvolver?: ConvolverNode,
 *   reverbWet?: GainNode,
 *   reverbSum?: GainNode,
 *   reverbTail?: AudioNode,
 * }} voice
 */
export function attachReverbToVoice(ctx, voice) {
  const input = voice.delayTail ?? voice.delaySum;
  if (!input || !voice?.gain) return voice;
  const dry = ctx.createGain();
  const preDelay = ctx.createDelay(MAX_PRE_DELAY_SEC);
  const convolver = ctx.createConvolver();
  convolver.normalize = false;
  const wet = ctx.createGain();
  const sum = ctx.createGain();
  try {
    input.disconnect();
  } catch {
    /* ignore */
  }
  input.connect(dry);
  input.connect(preDelay);
  preDelay.connect(convolver);
  convolver.connect(wet);
  dry.connect(sum);
  wet.connect(sum);
  sum.connect(voice.gain);
  voice.reverbDry = dry;
  voice.reverbPreDelay = preDelay;
  voice.reverbConvolver = convolver;
  voice.reverbWet = wet;
  voice.reverbSum = sum;
  voice.reverbTail = sum;
  return voice;
}

/**
 * @param {import('./playback-stereo.js').StereoVoice & {
 *   reverbDry?: GainNode,
 *   reverbPreDelay?: DelayNode,
 *   reverbConvolver?: ConvolverNode,
 *   reverbWet?: GainNode,
 * }} voice
 * @param {ClipReverbParams} params
 */
export function applyClipReverbToVoice(voice, params) {
  if (!voice?.reverbDry || !voice?.reverbWet || !voice?.reverbConvolver || !voice?.reverbPreDelay) {
    return;
  }
  const ctx = voice.reverbConvolver.context;
  const d = Math.max(1, Math.min(4, Math.floor(Number(params?.decayStep)) || 1));
  const r = Math.max(1, Math.min(4, Math.floor(Number(params?.roomStep)) || 1));
  const p = Math.max(1, Math.min(4, Math.floor(Number(params?.preDelayStep)) || 1));
  const m = Math.max(1, Math.min(4, Math.floor(Number(params?.mixStep)) || 1));
  const decaySec = DECAY_SEC[d - 1] ?? DECAY_SEC[0];
  voice.reverbPreDelay.delayTime.value = PRE_DELAY_SEC[p - 1] ?? 0;
  voice.reverbConvolver.buffer = buildReverbIR(ctx, decaySec, r);
  const wet = MIX_WET[m - 1] ?? MIX_WET[0];
  voice.reverbWet.gain.value = wet;
  voice.reverbDry.gain.value = 1 - wet;
}

/** @returns {ClipReverbParams} */
export function defaultClipReverbParams() {
  return { decayStep: 1, roomStep: 1, preDelayStep: 1, mixStep: 1 };
}
