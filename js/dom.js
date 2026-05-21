/**
 * @module dom
 * HTML element references. Settings modules read control values from here.
 */

export const dom = {
  pack: /** @type {HTMLSelectElement|null} */ (document.getElementById("pack-select")),
  packRemoteUrl: /** @type {HTMLInputElement|null} */ (document.getElementById("pack-remote-url")),
  btnLoadRemotePack: /** @type {HTMLButtonElement|null} */ (
    document.getElementById("btn-load-remote-pack")
  ),
  packRemoteStatus: /** @type {HTMLElement|null} */ (document.getElementById("pack-remote-status")),
  assetSource: /** @type {HTMLSelectElement|null} */ (document.getElementById("asset-source")),
  assetSourceRemotePanel: /** @type {HTMLElement|null} */ (
    document.getElementById("asset-source-remote-panel")
  ),
  gridToolbarSampleSet: /** @type {HTMLElement|null} */ (
    document.getElementById("grid-toolbar-sample-set")
  ),
  syncLoopTicks: /** @type {HTMLSelectElement|null} */ (document.getElementById("sync-loop-ticks")),
  midiLayout: /** @type {HTMLSelectElement|null} */ (document.getElementById("pad-layout")),
  gridFlip: /** @type {HTMLSelectElement|null} */ (document.getElementById("grid-flip")),
  midiInput: /** @type {HTMLSelectElement|null} */ (document.getElementById("midi-input")),
  midiSysex: /** @type {HTMLInputElement|null} */ (document.getElementById("midi-sysex-daw")),
  midiDebug: /** @type {HTMLElement|null} */ (document.getElementById("midi-debug")),
  midi: /** @type {HTMLElement|null} */ (document.getElementById("midi-status")),
  grid: /** @type {HTMLElement|null} */ (document.getElementById("pad-grid")),
  cols: /** @type {HTMLElement|null} */ (document.getElementById("col-labels")),
  btnAudio: /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-audio")),
  btnMidi: /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-midi")),
  btnMidiStandalone: /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-midi-standalone")),
};
