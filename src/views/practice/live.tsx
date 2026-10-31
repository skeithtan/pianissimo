/**
 * Small components subscribed to the session's per-frame stores, so the cursor, the correction
 * cue and the keyboard guide update without re-rendering the whole practice screen.
 */
import { useMemo } from 'preact/hooks'
import type { PracticeSession } from '../../app/session'
import { barLabel } from '../../core/engine'
import type { PassageRange } from '../../core/model/practice'
import type { ScoreModel } from '../../core/model/score'
import type { NamingSettings } from '../../core/model/settings'
import { DOUBLE_FLAT, DOUBLE_SHARP, FLAT, NATURAL, SHARP } from '../../core/naming'
import { KeyboardGuide } from '../../render/keyboard'
import { useFadePresence } from '../../ui/fade'
import { overviewMeasures } from '../../ui/overviewMath'
import { ScoreOverview, type OverviewPositionSource } from '../../ui/ScoreOverview'
import { useStore } from './useStore'
import styles from './practice.module.css'

/**
 * The whole-piece overview: its own full-width row with nothing else in it (U11); the loop shows
 * only in Repeat mode. It never recedes (U13): the learner keeps their place while playing.
 */
export function OverviewBar({
  session,
  model,
  range,
}: {
  session: PracticeSession
  model: ScoreModel
  range: PassageRange | null
}) {
  const measures = useMemo(() => overviewMeasures(model), [model])
  // The session publishes progress every frame while playing: the overview follows it without
  // re-rendering (transforms only; a render only when the bar changes).
  const follow = useMemo<OverviewPositionSource>(
    () => ({
      get: () => session.progress.get().position,
      subscribe: (fn) => session.progress.subscribe((p) => fn(p.position)),
    }),
    [session],
  )
  return (
    <div class={styles.overview}>
      <ScoreOverview
        measures={measures}
        follow={follow}
        loop={range}
        onScrub={(occ) => session.seek(occ)}
        onLoopChange={(next) => session.setSelection({ range: next })}
        describe={(occ, count) => `Bar ${barLabel(model, occ)} of ${count}`}
      />
    </div>
  )
}

const ACCIDENTAL_WORDS: Readonly<Record<string, string>> = {
  [SHARP]: 'sharp',
  [FLAT]: 'flat',
  [NATURAL]: 'natural',
  [DOUBLE_SHARP]: 'double sharp',
  [DOUBLE_FLAT]: 'double flat',
}

/**
 * A correction cue at the learner's eyes (U30 revised): just left of the fixed cursor line, over
 * notes already played and never over the notes still to play. An octave cue is an up / down
 * arrow; an accidental cue names the target with its accidental emphasized ("F♯4").
 */
export function StageCue({ session }: { session: PracticeSession }) {
  const f = useStore(session.feedback)
  const cue = f.visible ? f.cue : null
  if (!cue) return null
  if (cue.kind === 'octave') {
    return (
      <div
        class={styles.stageCue}
        data-testid="stage-cue"
        data-kind="octave"
        data-direction={cue.direction}
        role="img"
        aria-label={cue.direction === 'up' ? 'Play an octave higher' : 'Play an octave lower'}
      >
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <path
            d={cue.direction === 'up' ? 'M12 20V4m-7 7 7-7 7 7' : 'M12 4v16m-7-7 7 7 7-7'}
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
    )
  }
  const at = cue.text.indexOf(cue.accidental)
  const name = at < 0 ? cue.text : cue.text.slice(0, at)
  const rest = at < 0 ? '' : cue.text.slice(at + cue.accidental.length)
  const word = ACCIDENTAL_WORDS[cue.accidental] ?? ''
  const spoken = [name, word, rest].filter(Boolean).join(' ')
  return (
    <div
      class={styles.stageCue}
      data-testid="stage-cue"
      data-kind="accidental"
      role="img"
      aria-label={`Play ${spoken} instead`}
    >
      <span aria-hidden="true">
        {name}
        <strong>{cue.accidental}</strong>
        {rest}
      </span>
    </div>
  )
}

/**
 * The keyboard guide in a slot that slides open and closed (its grid row animates 0fr ↔ 1fr), so
 * the stage above follows smoothly. The guide stays mounted while the slot closes and fades out
 * at the same time (`useFadePresence`); a closed slot holds nothing.
 */
export function GuidePanel({
  session,
  fadeMs,
  naming,
}: {
  session: PracticeSession
  fadeMs: number
  naming: NamingSettings
}) {
  const ui = useStore(session.ui)
  const guide = useStore(session.guide)
  const presence = useFadePresence(ui.keyboardVisible, fadeMs)
  return (
    <div class={styles.guideSlot} data-open={ui.keyboardVisible ? 'true' : 'false'} data-testid="guide-slot">
      <div class={styles.guideSlotInner}>
        {presence.mounted ? (
          <section class={styles.guide} aria-label="Keyboard guide">
            <KeyboardGuide
              keys={guide.keys}
              rollDirection={guide.rollDirection}
              visible={ui.keyboardVisible}
              fadeMs={fadeMs}
              naming={naming}
            />
          </section>
        ) : null}
      </div>
    </div>
  )
}
