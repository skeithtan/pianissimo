/**
 * Plain-language status per setup step, derived from the MIDI snapshot and settings. Pure, so
 * every state is testable; the view shows the text with an icon (never color alone).
 */
import { gradedAccompanimentAllowed } from '../../core/midi/route'
import type { AppSettings, MidiRouteSettings } from '../../core/model/settings'
import type { MidiSnapshot } from '../../app/services'
import { controllerName } from '../settings/pedalSummary'

/** done = complete; action = needs the user; todo = not started; optional; blocked = waits on an earlier step. */
export type StepTone = 'done' | 'action' | 'todo' | 'optional' | 'blocked'

export interface StepStatus {
  readonly tone: StepTone
  readonly text: string
}

export type StepId = 'access' | 'input' | 'output' | 'echo' | 'pedal' | 'playback'

export const STEP_TITLES: Readonly<Record<StepId, string>> = {
  access: 'MIDI access',
  input: 'Piano input',
  output: 'Playback to the piano',
  echo: 'Echo test',
  pedal: 'Hint pedal',
  playback: 'Accompaniment',
}

export const STEP_ORDER: readonly StepId[] = ['access', 'input', 'output', 'echo', 'pedal', 'playback']

export function channelLabel(channel: number): string {
  return `channel ${channel + 1}`
}

export function accessStatus(s: MidiSnapshot): StepStatus {
  switch (s.access) {
    case 'unsupported':
      return { tone: 'blocked', text: 'Not available in this browser' }
    case 'denied':
      return { tone: 'action', text: 'Blocked by the browser' }
    case 'error':
      return { tone: 'action', text: 'Could not start' }
    case 'requesting':
      return { tone: 'todo', text: 'Waiting for your answer' }
    case 'granted':
      return { tone: 'done', text: 'Allowed' }
    case 'idle':
      return { tone: 'todo', text: s.permission === 'denied' ? 'Blocked by the browser' : 'Not allowed yet' }
  }
}

export function inputStatus(s: MidiSnapshot): StepStatus {
  if (s.access !== 'granted') return { tone: 'blocked', text: 'Needs MIDI access' }
  if (s.input?.connected) return { tone: 'done', text: s.input.name }
  if (s.input) return { tone: 'action', text: `${s.input.name} is disconnected` }
  return { tone: 'todo', text: s.inputs.length === 0 ? 'No MIDI input found' : 'Choose your piano' }
}

export function outputStatus(s: MidiSnapshot, route: MidiRouteSettings): StepStatus {
  if (s.access !== 'granted') return { tone: 'blocked', text: 'Needs MIDI access' }
  if (!s.output) return { tone: 'todo', text: 'No output chosen' }
  if (!s.output.connected) return { tone: 'action', text: `${s.output.name} is disconnected` }
  if (route.outputVerified) return { tone: 'done', text: `Piano sounds on ${channelLabel(route.outputChannel)}` }
  return { tone: 'action', text: 'Play the test note' }
}

export function echoStatus(s: MidiSnapshot, route: MidiRouteSettings): StepStatus {
  if (!s.input?.connected || !s.output?.connected) return { tone: 'blocked', text: 'Needs an input and an output' }
  switch (route.echo) {
    case 'none':
      return { tone: 'done', text: 'No echo' }
    case 'echo-detected':
      return { tone: 'action', text: 'Echo detected' }
    case 'untested':
      return { tone: 'todo', text: 'Not tested' }
  }
}

export function pedalStatus(settings: AppSettings): StepStatus {
  const mapping = settings.pedal.hintPedal
  if (!mapping) return { tone: 'optional', text: 'Optional' }
  const name = capitalize(controllerName(mapping.controller))
  return mapping.verified ? { tone: 'done', text: name } : { tone: 'action', text: `${name}, not tested` }
}

export interface ReadinessItem {
  readonly id: 'output' | 'verified' | 'echo'
  readonly ok: boolean
  readonly text: string
}

export interface PlaybackReadiness {
  /** One-hand practice can grade the learner while the piano plays the other part. */
  readonly graded: boolean
  /** Preview / accompaniment can sound on the piano (verified, connected output). */
  readonly pianoPlayback: boolean
  readonly items: readonly ReadinessItem[]
}

/**
 * What one-hand practice and Preview can do on this route (spec: physical-piano playback needs
 * a verified output; graded accompaniment also needs an echo-free route).
 */
export function playbackReadiness(s: MidiSnapshot, route: MidiRouteSettings): PlaybackReadiness {
  const connected = s.output?.connected === true
  const items: ReadinessItem[] = [
    {
      id: 'output',
      ok: connected,
      text: connected ? `Output: ${s.output!.name}, ${channelLabel(route.outputChannel)}` : 'Choose a connected output',
    },
    {
      id: 'verified',
      ok: connected && route.outputVerified,
      text: route.outputVerified ? 'Test note heard on the piano' : 'Confirm that the test note sounds on the piano',
    },
    {
      id: 'echo',
      ok: route.echo === 'none',
      text:
        route.echo === 'none'
          ? 'Echo test passed'
          : route.echo === 'echo-detected'
            ? 'Echo detected: fix the route and test again'
            : 'Run the echo test',
    },
  ]
  return {
    graded: connected && gradedAccompanimentAllowed(route),
    pianoPlayback: connected && route.outputVerified,
    items,
  }
}

export function playbackStatus(s: MidiSnapshot, route: MidiRouteSettings): StepStatus {
  const r = playbackReadiness(s, route)
  if (r.graded) return { tone: 'done', text: 'Graded accompaniment ready' }
  if (r.pianoPlayback) return { tone: 'action', text: 'Preview only' }
  return { tone: 'todo', text: 'Piano playback not ready' }
}

export function stepStatuses(s: MidiSnapshot, settings: AppSettings): Readonly<Record<StepId, StepStatus>> {
  return {
    access: accessStatus(s),
    input: inputStatus(s),
    output: outputStatus(s, settings.route),
    echo: echoStatus(s, settings.route),
    pedal: pedalStatus(settings),
    playback: playbackStatus(s, settings.route),
  }
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
