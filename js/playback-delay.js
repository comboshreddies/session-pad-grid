/**
 * @module playback-delay
 * Post-distortion delay (wet/dry) with feedback loop and tone LPF on repeats.
 */

/** @typedef {{ timeStep: number, feedbackStep: number, mixStep: number, toneStep: number }} ClipDelayParams */

const MAX_DELAY_SEC = 1.25;
const TIME_SEC = [0.06, 0.12, 0.25, 0.5];
const FEEDBACK_GAIN = [0.12, 0.28, 0.45, 0.62];
const MIX_WET = [0, 0.22, 0.45, 0.7];
const TONE_HZ = [20000, 8000, 3500, 1200];

/**
 * @param {AudioContext} ctx
 * @param {import('./playback-stereo.js').StereoVoice & {
 *   distortionTail?: AudioNode,
 *   toneFilter?: BiquadFilterNode,
 *   delayDry?: GainNode,
 *   delayNode?: DelayNode,
 *   delayFeedback?: GainNode,
 *   delayTone?: BiquadFilterNode,
 *   delayWet?: GainNode,
 *   delaySum?: GainNode,
 *   delayTail?: AudioNode,
 * }} voice
 */
export function attachDelayToVoice(ctx, voice) {
  const input = voice.distortionTail ?? voice.toneFilter;
  if (!input || !voice?.gain) return voice;
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const delay = ctx.createDelay(MAX_DELAY_SEC);
  const feedback = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  const sum = ctx.createGain();
  try {
    input.disconnect();
  } catch {
    /* ignore */
  }
  input.connect(dry);
  input.connect(delay);
  delay.connect(tone);
  tone.connect(feedback);
  feedback.connect(delay);
  tone.connect(wet);
  dry.connect(sum);
  wet.connect(sum);
  sum.connect(voice.gain);
  voice.delayDry = dry;
  voice.delayNode = delay;
  voice.delayFeedback = feedback;
  voice.delayTone = tone;
  voice.delayWet = wet;
  voice.delaySum = sum;
  voice.delayTail = sum;
  return voice;
}

/**
 * @param {import('./playback-stereo.js').StereoVoice & {
 *   delayDry?: GainNode,
 *   delayNode?: DelayNode,
 *   delayFeedback?: GainNode,
 *   delayTone?: BiquadFilterNode,
 *   delayWet?: GainNode,
 * }} voice
 * @param {ClipDelayParams} params
 */
export function applyClipDelayToVoice(voice, params) {
  if (!voice?.delayNode || !voice?.delayDry || !voice?.delayWet) return;
  const t = Math.max(1, Math.min(4, Math.floor(Number(params?.timeStep)) || 1));
  const f = Math.max(1, Math.min(4, Math.floor(Number(params?.feedbackStep)) || 1));
  const m = Math.max(1, Math.min(4, Math.floor(Number(params?.mixStep)) || 1));
  const n = Math.max(1, Math.min(4, Math.floor(Number(params?.toneStep)) || 4));
  voice.delayNode.delayTime.value = TIME_SEC[t - 1] ?? TIME_SEC[0];
  voice.delayFeedback.gain.value = FEEDBACK_GAIN[f - 1] ?? FEEDBACK_GAIN[0];
  const wet = MIX_WET[m - 1] ?? 0;
  voice.delayWet.gain.value = wet;
  voice.delayDry.gain.value = 1 - wet;
  const hz = TONE_HZ[n - 1] ?? TONE_HZ[3];
  voice.delayTone.frequency.value = hz;
  voice.delayTone.Q.value = n <= 2 ? 0.707 : 0.5;
}

/** @returns {ClipDelayParams} */
export function defaultClipDelayParams() {
  return { timeStep: 1, feedbackStep: 1, mixStep: 1, toneStep: 4 };
}
