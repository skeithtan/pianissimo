/**
 * Which Metronome preference applies (DECISIONS P20): a Keep time attempt clicks after its
 * count-in per `metronome.keepTime` (default on); everything else (Listen, ordinary reading,
 * scored practice, Play through) per `metronome.enabled` (default off). The count-in itself always
 * clicks. Pure: the session and the Practice menu's switch share these rules.
 */
import type { HandSelection } from '../../core/model/score'
import type { MetronomeSettings } from '../../core/model/settings'

/** Which Metronome preference a Start uses (DECISIONS P20). */
export type MetronomeScope = 'general' | 'keepTime'

/** Keep time's own preference during its attempts (Keep time on and a hand selected); else the general one. */
export function metronomeScope(rhythm: boolean, hands: HandSelection): MetronomeScope {
  return rhythm && hands !== 'none' ? 'keepTime' : 'general'
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
