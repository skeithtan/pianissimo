/**
 * Which Metronome preference applies (DECISIONS P20): a Keep time attempt clicks after its
 * count-in per `metronome.keepTime` (default on); Listen, Wait and Follow per `metronome.enabled`
 * (default off). The count-in itself always clicks. Pure: the session and the menu's switch share
 * these rules.
 */
import type { PracticeMode } from '../../core/model/practice'
import type { MetronomeSettings } from '../../core/model/settings'

/** Which Metronome preference a Start uses (DECISIONS P20). */
export type MetronomeScope = 'general' | 'keepTime'

/** Keep time has its own preference; the other modes share the general one. */
export function metronomeScope(mode: PracticeMode): MetronomeScope {
  return mode === 'time' ? 'keepTime' : 'general'
}

/** Is the click on for that scope? */
export function metronomeOn(settings: MetronomeSettings, scope: MetronomeScope): boolean {
  return scope === 'keepTime' ? settings.keepTime : settings.enabled
}

/** The settings patch that switches that scope's click: `{ metronome: { enabled } }` or `{ metronome: { keepTime } }`. */
export function metronomePatch(
  scope: MetronomeScope,
  on: boolean,
): { readonly metronome: { readonly enabled: boolean } | { readonly keepTime: boolean } } {
  return scope === 'keepTime' ? { metronome: { keepTime: on } } : { metronome: { enabled: on } }
}
