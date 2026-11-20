import { msg } from '../../i18n/messages'
/** Plain-language description of the learned hint pedal (spec "MIDI input, output, and pedal controls"). */
import type { HintPedalMapping, PedalSettings } from '../../core/model/settings'

const CONTROLLER_NAMES: Readonly<Record<number, string>> = {
  64: 'sustain (right pedal)',
  66: 'sostenuto (middle pedal)',
  67: 'soft (left pedal)',
}

/** "sustain (right pedal)", or "controller 11" when the piano sent something unusual. */
export function controllerName(controller: number): string {
  return CONTROLLER_NAMES[controller] ? msg(CONTROLLER_NAMES[controller]!) : msg('controller {0}', controller)
}

/** One-line summary of a mapping, or why none is set. */
export function describeHintPedal(mapping: HintPedalMapping | null): string {
  if (mapping === null) {
    return msg(
      'No hint pedal is set. Set one up in Connection to reveal names with your foot, or enable automatic hints in Settings.',
    )
  }
  const channel = mapping.channel === null ? msg('any channel') : msg('channel {0}', mapping.channel + 1)
  const direction = mapping.inverted ? msg('down at or below') : msg('down at or above')
  const verified = mapping.verified ? msg('Tested.') : msg('Not tested yet.')
  return msg(
    '{0}, {1}. Counts as pressed {2} {3}. {4}',
    capitalize(controllerName(mapping.controller)),
    channel,
    direction,
    mapping.threshold,
    verified,
  )
}

/** Observed pedals as a short list, or null when none were seen. */
export function describeObservedPedals(pedal: PedalSettings): string | null {
  if (pedal.observedControllers.length === 0) return null
  return pedal.observedControllers.map(controllerName).join(', ')
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
