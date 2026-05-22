/**
 * @module store
 * Mutable application state. Import this from any module; do not duplicate Maps/Sets.
 * See js/ARCHITECTURE.md for what belongs here vs config (immutable).
 */

/** @typedef {import('./types.js').PackState} PackState */

export const store = {
  /** @type {PackState|null} */
  pack: null,

  audioCtx: /** @type {AudioContext|null} */ (null),
  masterGain: /** @type {GainNode|null} */ (null),
  midiAccess: /** @type {MidiAccess|null} */ (null),

  currentPackSlug: "viral-hiphop",
  packLoadToken: 0,

  bufferCache: /** @type {Map<string, AudioBuffer>} */ (new Map()),
  /** WAV URL → channel count (1 mono, 2+ stereo), from header probe or decode. */
  loopChannelCountByUrl: /** @type {Map<string, number>} */ (new Map()),
  /** When set, `loop.url` resolves against this base (remote pack.json directory). */
  remotePackJsonUrl: /** @type {string|null} */ (null),
  remotePackBaseUrl: /** @type {string|null} */ (null),
  /** Manifest URL when Custom URL loaded a catalog; enables Sample set switching. */
  remoteCatalogUrl: /** @type {string|null} */ (null),
  /** @type {import('./pack-catalog.js').PackCatalogEntry[]|null} */
  remoteCatalogEntries: null,
  /** @type {Map<string, { source: AudioBufferSourceNode, gain: GainNode, premuteGain?: number, anchorPadKey?: string|null, gainVelNorm?: number }>} */
  activeLoops: new Map(),
  activeOneShots: new Map(),
  oneShotPlayGenerationByLoopId: new Map(),
  pendingLoopStartTimers: new Map(),
  pendingQuantizedStopLoopIds: new Set(),
  mutedColumns: new Set(),
  mutedPhysicalSessionCols: new Set(),

  transportOriginAudioSec: /** @type {number|null} */ (null),
  audioBarClockOriginSec: /** @type {number|null} */ (null),
  syncLoopTicksState: 4,
  lastSyncClockGColumn: -1,
  syncClockLoopActive: false,

  h8ClockStripMenuHeld: false,
  /** Web: clock tick sync menu stays open after click (not only while pointer is down). */
  h8ClockStripMenuLatched: false,
  /** Physical Session columns 0–6 (`1H`…`7H` held): clip / mute (G) in that column stops playback. */
  hStopModifierPhysicalCols: new Set(),
  g7VolumeMenuHeld: false,
  /** Web: volume menu stays open after click (not only while pointer is down). */
  g7VolumeMenuLatched: false,
  g7VolumeStepSelection: /** @type {number|null} */ (null),
  g7SelectedClipLoopIds: new Set(),
  g7ClipVolumeStepByLoopId: new Map(),

  /** Hold right column row 3 (web **C** / CC 69): stereo pan — **H** = right 0…8, **G** = left 0…8, L+R=8. */
  g6StereoPanMenuHeld: false,
  /** Web: pan menu latched open after click. */
  g6StereoPanMenuLatched: false,
  g6StereoPanStepSelection: /** @type {'left'|'right'|null} */ (null),
  g6StereoPanStepValue: /** @type {number|null} */ (null),
  g6SelectedClipLoopIds: new Set(),
  /** Right pan step 0…8; left = 8 − right. */
  g6ClipRightPanStepByLoopId: new Map(),

  /** Hold scene row 4 / CC **59** (web side panel **D**): distortion on selected clips **1A…8F**. */
  g4DistortionMenuHeld: false,
  g4DistortionMenuLatched: false,
  /** Drive step 1…8 chosen on row **G** before applying to clips. */
  g4DistortionDriveStepSelection: /** @type {number|null} */ (null),
  g4SelectedClipLoopIds: new Set(),
  /** Default soft clip for next assignments when H4 is toggled with no clips selected. */
  g4DistortionSoftClipPending: true,
  /** @type {Map<string, import('./playback-distortion.js').ClipDistortionParams>} */
  g4ClipDistortionByLoopId: new Map(),

  clipKindLegendHeld: false,
  clipKindLegendLatched: false,
  clipKindLegendVelocityByKey: new Map(),
  clipTypeLegendHeld: false,
  clipTypeLegendLatched: false,
  clipTypeLegendVelocityByKey: new Map(),

  boundMidiInputSummary: "",
};

/** Legacy alias used throughout the codebase during migration. */
export function getPackState() {
  return store.pack;
}

export function setPackState(next) {
  store.pack = next;
}
