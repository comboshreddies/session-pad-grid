/**
 * @module playback-stereo
 * Per-voice L/R gain split (stereo buffers) before the shared voice gain.
 */

/**
 * @param {AudioContext} ctx
 * @returns {{ splitter: ChannelSplitterNode, leftGain: GainNode, rightGain: GainNode, merger: ChannelMergerNode }}
 */
export function createStereoVoiceChain(ctx) {
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const leftGain = ctx.createGain();
  const rightGain = ctx.createGain();
  splitter.connect(leftGain, 0);
  splitter.connect(rightGain, 1);
  leftGain.connect(merger, 0, 0);
  rightGain.connect(merger, 0, 1);
  return { splitter, leftGain, rightGain, merger };
}

/**
 * Route buffer to master through per-channel L/R gains (pan steps sum to 8).
 * Stereo: splitter → L/R gains. Mono: same signal to both gains so pan still works.
 * @param {AudioContext} ctx
 * @param {AudioBufferSourceNode} src
 * @param {(voiceGain: GainNode) => void} connectToMaster
 */
export function wireBufferSourceWithStereoPan(ctx, src, connectToMaster) {
  const ch = src.buffer?.numberOfChannels ?? 1;
  const g = ctx.createGain();
  connectToMaster(g);
  const chain = createStereoVoiceChain(ctx);
  if (ch < 2) {
    src.connect(chain.leftGain);
    src.connect(chain.rightGain);
  } else {
    src.connect(chain.splitter);
  }
  chain.merger.connect(g);
  return { source: src, ...chain, gain: g };
}

/**
 * @param {{ source?: AudioBufferSourceNode, splitter?: ChannelSplitterNode, leftGain?: GainNode, rightGain?: GainNode, merger?: ChannelMergerNode, gain?: GainNode }} voice
 */
export function disconnectVoiceNodes(voice) {
  if (!voice) return;
  try {
    voice.source?.stop();
  } catch {
    /* ignore */
  }
  try {
    voice.source?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.splitter?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.leftGain?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.rightGain?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.merger?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.spectrumHighPass?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.spectrumLowPass?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.compressor?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.compressorMakeup?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.delayDry?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.delayNode?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.delayFeedback?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.delayTone?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.delayWet?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.delaySum?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.distortionDrive?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.toneFilter?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    voice.gain?.disconnect();
  } catch {
    /* ignore */
  }
}
