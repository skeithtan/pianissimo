/**
 * Sound destination for app-generated playback (accompaniment and Listen; spec "MIDI input,
 * output, and pedal controls", "Listening and hand practice", DECISIONS S4):
 *
 * - `auto` (default): the connected piano's MIDI output when there is one, otherwise this
 *   device's browser sound;
 * - `midi`: the piano only (nothing plays without an output);
 * - `browser`: this device only.
 *
 * Browser sound is loaded lazily after a gesture, so use with a connected piano never fetches
 * the sample bank. The metronome is separate (it always clicks through Web Audio).
 */
import { gradedAccompanimentAllowed } from '../../core/midi/route'
import type { MidiOutputLike } from '../../core/midi/webmidi'
import { MidiOutputBackend } from '../../core/playback/midiOutput'
import type { SessionSettings, MidiBackendLike } from './types'

/** What a destination resolves to now: the piano's MIDI output or this device's sound. */
export type PlaybackKind = 'midi' | 'browser'

export function defaultMidiBackend(clock: () => number) {
  return (output: MidiOutputLike, channel: number, humanGuard: boolean): MidiBackendLike =>
    new MidiOutputBackend({ output, channel, clock, humanGuard })
}

/**
 * Where app playback goes now, or null when nothing can play. `browserSound`: this device can
 * play sound (Web Audio and the lazy loader are available).
 */
export function playbackDestination(
  settings: SessionSettings,
  output: MidiOutputLike | null,
  browserSound: boolean,
): PlaybackKind | null {
  switch (settings.sound.destination) {
    case 'browser':
      return browserSound ? 'browser' : null
    case 'midi':
      return output ? 'midi' : null
    default:
      return output ? 'midi' : browserSound ? 'browser' : null
  }
}

/** Is there somewhere to send app playback? */
export function hasSoundOutput(
  settings: SessionSettings,
  output: MidiOutputLike | null,
  browserSound: boolean,
): boolean {
  return playbackDestination(settings, output, browserSound) !== null
}

/** Why nothing can play, in words; null when something can. */
export function noPlaybackReason(
  settings: SessionSettings,
  output: MidiOutputLike | null,
  browserSound: boolean,
): string | null {
  if (hasSoundOutput(settings, output, browserSound)) return null
  switch (settings.sound.destination) {
    case 'midi':
      return 'The piano output is not connected. Connect it in Connection, or choose Auto in Settings → Sound.'
    case 'browser':
      return 'This browser cannot play sound. Choose Auto or the connected piano in Settings → Sound.'
    default:
      return 'No piano is connected and this browser cannot play sound.'
  }
}

/**
 * One-hand grading needs app playback that can never come back as "human" input: browser
 * sound, or a verified, echo-free MIDI output (DECISIONS MI1, P2).
 */
export function accompanimentAllowed(
  settings: SessionSettings,
  output: MidiOutputLike | null,
  browserSound: boolean,
): boolean {
  const kind = playbackDestination(settings, output, browserSound)
  if (kind === 'browser') return true
  return kind === 'midi' && gradedAccompanimentAllowed(settings.route)
}

/**
 * Whether the MIDI backend defers app releases of pitches the learner holds (the human-held
 * guard). Only on a route verified echo-free: on an echoing or untested piano each app note
 * comes back as a "held" key whose release never arrives, so every app note would stick. Without
 * the guard the worst case is releasing a note the learner holds at the same pitch.
 */
export function humanGuardEnabled(settings: SessionSettings): boolean {
  return settings.route.echo === 'none'
}

/** Identity of an output backend: a change requires a new one. */
export function outputKey(settings: SessionSettings, kind: PlaybackKind | null): string {
  if (kind !== 'midi') return kind ?? 'none'
  const r = settings.route
  return ['midi', r.outputId, r.outputChannel, r.echo].join('|')
}

/** Fields whose change requires rebuilding the accompaniment performance. */
export function performanceKey(settings: SessionSettings): string {
  const r = settings.route
  return [r.accompanimentLevel, r.automaticPedalsInHandPractice].join('|')
}
