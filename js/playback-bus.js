/**
 * @module playback-bus
 * Single audio output hook for all voices. Add master FX between bus and destination here.
 */

import { store } from "./store.js";

/**
 * Connect a per-voice gain node to the master output (dry path).
 * @param {GainNode} voiceGain
 */
export function connectVoiceToMaster(voiceGain) {
  if (!store.masterGain) return;
  voiceGain.connect(store.masterGain);
}

/**
 * Ensure AudioContext + master gain exist.
 * @returns {Promise<AudioContext>}
 */
export async function ensureMasterBus() {
  if (store.audioCtx) return store.audioCtx;
  store.audioCtx = new AudioContext();
  store.masterGain = store.audioCtx.createGain();
  store.masterGain.gain.value = 0.85;
  store.masterGain.connect(store.audioCtx.destination);
  return store.audioCtx;
}
