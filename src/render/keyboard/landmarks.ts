import type { NamingSettings } from '../../core/model/settings'
import { labelForMidi } from '../../core/naming'

/**
 * Spec "Keyboard rescue" / help-level table: octave landmarks. The name of a bare piano key
 * with its octave (C4 is middle C; do4 in fixed do), whatever the octave-in-labels preference,
 * because a landmark without an octave cannot tell distant octaves apart. Landmarks are C keys;
 * the accessible summary also uses this for keys without a caller label, spelling black keys
 * with sharps.
 */
export function keyName(midi: number, naming: NamingSettings): string {
  return labelForMidi(midi, { ...naming, showOctave: true }).text
}

export const MIDDLE_C = 60
