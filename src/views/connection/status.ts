/**
 * Plain-language status per setup step, derived from the MIDI snapshot and settings. Pure, so
 * every state is testable; the view shows the text with an icon (never color alone).
 */
import type { AppSettings, MidiRouteSettings } from '../../core/model/settings'
import type { MidiSnapshot } from '../../app/services'
import { controllerName } from '../settings/pedalSummary'

/** done = complete; action = needs the user; todo = not started; optional; blocked = waits on an earlier step. */
export type StepTone = 'done' | 'action' | 'todo' | 'optional' | 'blocked'

export interface StepStatus {
  readonly tone: StepTone
  readonly text: string
}

/** Three steps (DECISIONS C11): the piano (access + input), playback (output + test notes + echo + options), hint pedal. */
export type StepId = 'piano' | 'playback' | 'pedal'

export const STEP_ORDER: readonly StepId[] = ['piano', 'playback', 'pedal']

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

/** The piano step is MIDI access until it is granted, then the chosen input. */
export function pianoStatus(s: MidiSnapshot): StepStatus {
  return s.access === 'granted' ? inputStatus(s) : accessStatus(s)
}

/**
 * Playback is done when the test notes were heard on the piano and did not come back on the
 * input (spec: physical-piano playback needs a verified output; graded accompaniment also needs
 * an echo-free route).
 */
export function playbackStatus(s: MidiSnapshot, route: MidiRouteSettings): StepStatus {
  if (s.access !== 'granted') return { tone: 'blocked', text: 'Needs MIDI access' }
  if (!s.output) return { tone: 'todo', text: 'No output chosen' }
  if (!s.output.connected) return { tone: 'action', text: `${s.output.name} is disconnected` }
  if (!route.outputVerified) return { tone: 'action', text: 'Play the test notes' }
  if (route.echo === 'echo-detected') return { tone: 'action', text: 'Echo detected' }
  if (route.echo === 'untested') return { tone: 'action', text: 'Echo not checked' }
  return { tone: 'done', text: `Piano sounds on ${channelLabel(route.outputChannel)}` }
}

export function pedalStatus(settings: AppSettings): StepStatus {
  const mapping = settings.pedal.hintPedal
  if (!mapping) return { tone: 'optional', text: 'Optional' }
  const name = capitalize(controllerName(mapping.controller))
  return mapping.verified ? { tone: 'done', text: name } : { tone: 'action', text: `${name}, not tested` }
}

export function stepStatuses(s: MidiSnapshot, settings: AppSettings): Readonly<Record<StepId, StepStatus>> {
  return {
    piano: pianoStatus(s),
    playback: playbackStatus(s, settings.route),
    pedal: pedalStatus(settings),
  }
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
