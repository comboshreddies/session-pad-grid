/**
 * @module midi-device
 * Launchpad output port selection (DAW vs MIDI) and SysEx frame lookup.
 */

import { SYSEX_FRAMES, LAUNCHPAD_SESSION_SYSEX_STRICT } from "./config.js";
import { store } from "./store.js";

export function framesForLaunchpadOutput(name) {
  const t = (name || "").trim();
  for (const entry of LAUNCHPAD_SESSION_SYSEX_STRICT) {
    if (entry.re.test(t)) return entry.frames;
  }
  const n = t.toLowerCase();
  if (n.includes("mini") && n.includes("mk3")) return SYSEX_FRAMES.miniMk3;
  if (/\blppromk3\b/.test(n) || (n.includes("pro") && n.includes("mk3") && !n.includes("mini"))) {
    return SYSEX_FRAMES.proMk3;
  }
  if ((n.includes("launchpad x") || /\blpx\b/.test(n)) && !n.includes("mini")) return SYSEX_FRAMES.lpX;
  if (/launchpad.*mini.*mk\s*3/i.test(n) || (/mini.*mk\s*3/.test(n) && /launchpad|lpmini/i.test(n))) {
    return SYSEX_FRAMES.miniMk3;
  }
  if (/launchpad.*pro.*mk\s*3/i.test(n) && !/mini/i.test(n)) return SYSEX_FRAMES.proMk3;
  if ((/\blaunchpad\s*x\b/i.test(n) || /\blp\s*x\b/i.test(n)) && !/mini/i.test(n)) return SYSEX_FRAMES.lpX;
  return null;
}

/** Session grid LEDs: prefer **DAW** outputs when present (Novation dual-port drivers). */
export function eachLaunchpadSessionLightOutput(callback) {
  if (!store.midiAccess) return;
  const outs = [...store.midiAccess.outputs.values()];
  const lp = outs.filter((o) => framesForLaunchpadOutput((o.name || "").trim()));
  const daw = lp.filter((o) => /\bdaw\b/i.test((o.name || "").trim()));
  const targets = daw.length > 0 ? daw : lp;
  for (const output of targets) {
    callback(output, (output.name || "").trim());
  }
}
