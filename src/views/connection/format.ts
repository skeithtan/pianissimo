/** Text for the live input test: event rows, controller names, pedal value behavior. */
import type { MidiInputEvent } from '../../core/midi/types'
import type { NamingSettings } from '../../core/model/settings'
import { keyName } from '../../render/keyboard/landmarks'
import type { ControllerMeter } from './liveMonitor'

const PEDALS: Readonly<Record<number, string>> = { 64: 'Sustain', 66: 'Sostenuto', 67: 'Soft' }

/** "Sustain", "Sostenuto", "Soft", or "Controller 11". */
export function pedalName(controller: number): string {
  return PEDALS[controller] ?? `Controller ${controller}`
}

export interface EventRow {
  readonly kind: 'Note on' | 'Note off' | 'Pedal'
  readonly what: string
  readonly value: string
  readonly channel: string
}

/** One row of the last-events list, e.g. Note on · C4 (60) · vel 87 · ch 1. */
export function eventRow(ev: MidiInputEvent, naming: NamingSettings): EventRow {
  const channel = `ch ${ev.channel + 1}`
  if (ev.kind === 'cc') {
    return { kind: 'Pedal', what: `${pedalName(ev.controller)} (CC ${ev.controller})`, value: `= ${ev.value}`, channel }
  }
  return {
    kind: ev.kind === 'noteon' ? 'Note on' : 'Note off',
    what: `${keyName(ev.note, naming)} (${ev.note})`,
    value: `vel ${ev.velocity}`,
    channel,
  }
}

/** How a controller behaves so far: "Continuous", "On/off" or "One value". */
export function meterBehavior(m: Pick<ControllerMeter, 'distinct'>): string {
  if (m.distinct > 2) return 'Continuous'
  if (m.distinct === 2) return 'On/off'
  return 'One value so far'
}
