/** Plain-language description of the learned hint pedal (spec "MIDI input, output, and pedal controls"). */
import type { HintPedalMapping, PedalSettings } from '../../core/model/settings'

const CONTROLLER_NAMES: Readonly<Record<number, string>> = {
  64: 'sustain (right pedal)',
  66: 'sostenuto (middle pedal)',
  67: 'soft (left pedal)',
}

/** "sustain (right pedal)", or "controller 11" when the piano sent something unusual. */
export function controllerName(controller: number): string {
  return CONTROLLER_NAMES[controller] ?? `controller ${controller}`
}

/** One-line summary of a mapping, or why none is set. */
export function describeHintPedal(mapping: HintPedalMapping | null): string {
  if (mapping === null) {
    return 'No hint pedal is set. The on-screen Hint button always works; set a pedal up in Connection to reveal names with your foot.'
  }
  const channel = mapping.channel === null ? 'any channel' : `channel ${mapping.channel + 1}`
  const direction = mapping.inverted ? 'down at or below' : 'down at or above'
  const verified = mapping.verified ? 'Tested.' : 'Not tested yet.'
  return `${capitalize(controllerName(mapping.controller))}, ${channel}. Counts as pressed ${direction} ${mapping.threshold}. ${verified}`
}

/** Observed pedals as a short list, or null when none were seen. */
export function describeObservedPedals(pedal: PedalSettings): string | null {
  if (pedal.observedControllers.length === 0) return null
  return pedal.observedControllers.map(controllerName).join(', ')
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
