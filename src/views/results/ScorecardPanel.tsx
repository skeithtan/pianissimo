/**
 * The scorecard of one attempt (spec "Results and timing"): a transparent set of results, no
 * points total and no "missed notes" metric. Persistent score labels, temporary hints and the
 * keyboard guide are reported on separate lines. Timing is neutral: faster is not better.
 */
import type { ComponentChildren } from 'preact'
import { useId } from 'preact/hooks'
import { COMPLETION_TIME_DEFINITION, formatSeconds } from '../../core/history'
import type { Scorecard, ScorecardRowId } from '../../core/history'
import type { AttemptRecord } from '../../core/model/practice'
import { describeRule } from '../../core/naming'
import type { ClefKey } from '../../core/model/score'
import type { ClefLabelRule } from '../../core/model/settings'
import { Icon } from '../../ui/icons'
import { LABEL_MODE_TEXT, incompleteReason, plural, whenText } from './format'
import { earlyAttackCount, passReason } from './model'
import type { PassReason } from './model'
import styles from './results.module.css'

const PASS_TEXT: Readonly<Record<PassReason, string>> = {
  passed: 'Pass: completed with no wrong notes and no assistance',
  'wrong-notes': 'Not a pass: wrong-note attacks',
  assistance: 'Not a pass: assistance was used',
  timing: 'Not a pass: outside the timing tolerance',
  missed: 'Not a pass: some groups were missed',
  incomplete: 'Incomplete: not counted as a pass or a fail',
}

/** The rhythm mode (strict transport) timing rows, in order; the music set the pace. */
const RHYTHM_TILES: readonly { id: ScorecardRowId; label: string; detail?: string }[] = [
  { id: 'on-time', label: 'On-time groups', detail: 'Completed within the timing window' },
  { id: 'early', label: 'Early groups' },
  { id: 'late', label: 'Late groups' },
  { id: 'missed', label: 'Missed groups', detail: 'The music moved on before the group was complete' },
  { id: 'offset', label: 'Average offset', detail: 'Neutral: negative is ahead of the music, positive behind' },
  { id: 'tolerance', label: 'Timing window' },
]

function Tile({
  label,
  value,
  detail,
  tone,
  wide,
  children,
  testId,
}: {
  label: string
  value: ComponentChildren
  detail?: ComponentChildren
  tone?: 'good' | 'muted' | undefined
  wide?: boolean
  children?: ComponentChildren
  testId?: string
}) {
  return (
    <div class={styles.tile} data-wide={wide ? '' : undefined} data-tone={tone} data-row={testId}>
      <dt>{label}</dt>
      <dd>
        <span class={styles.tileValue}>{value}</span>
        {detail ? <span class={styles.tileDetail}>{detail}</span> : null}
        {children}
      </dd>
    </div>
  )
}

function isCondition(value: unknown): value is { enabled: boolean } {
  return typeof value === 'object' && value !== null && typeof (value as { enabled?: unknown }).enabled === 'boolean'
}

/** The label rules recorded with the attempt (`rulesJson`: the per-clef rules, or the labels settings holding them). */
export function labelRules(rulesJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(rulesJson)
    if (typeof parsed !== 'object' || parsed === null) return []
    const holder = parsed as Record<string, unknown>
    const rules =
      typeof holder['rules'] === 'object' && holder['rules'] !== null
        ? (holder['rules'] as Record<string, unknown>)
        : holder
    const out: string[] = []
    for (const [clef, rule] of Object.entries(rules)) {
      if (typeof rule !== 'object' || rule === null) continue
      const { below, above } = rule as { below?: unknown; above?: unknown }
      if (!isCondition(below) || !isCondition(above) || (!below.enabled && !above.enabled)) continue
      out.push(describeRule(rule as ClefLabelRule, clef as ClefKey))
    }
    return out
  } catch {
    return []
  }
}

function Assistance({ attempt, card }: { attempt: AttemptRecord; card: Scorecard }) {
  const a = card.assistance
  const rules = a.labelMode === 'conditional' ? labelRules(attempt.assistance.labelSettings.rulesJson) : []
  const labelsUsed = a.persistentLabelNotes > 0
  const hintsUsed = a.hintRequests + a.autoHints + a.hintGroups > 0
  return (
    <ul class={styles.assistList} aria-label="Assistance details">
      <li data-used={labelsUsed ? '' : undefined} data-row="assist-labels">
        <strong>Persistent score labels</strong>
        <span>
          Setting: {LABEL_MODE_TEXT[a.labelMode]}.{' '}
          {labelsUsed
            ? `Revealed ${plural(a.persistentLabelNotes, 'note')} in ${plural(a.persistentLabelGroups, 'group')}, including labels seen in advance.`
            : 'No notes were revealed by labels.'}
        </span>
        {rules.length > 0 ? (
          <details class={styles.inlineDetails}>
            <summary>Label rules at the time</summary>
            <ul>
              {rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </li>
      <li data-used={hintsUsed ? '' : undefined} data-row="assist-hints">
        <strong>Temporary hints</strong>
        <span>
          {hintsUsed
            ? `${plural(a.hintRequests, 'hint request')} (manual), ${plural(a.autoHints, 'automatic hint')}. ${plural(a.hintGroups, 'group')} revealed.`
            : 'No hints were requested or shown automatically.'}
        </span>
      </li>
      <li data-used={a.keyboardShown ? '' : undefined} data-row="assist-keyboard">
        <strong>Keyboard guide</strong>
        <span>{a.keyboardShown ? 'Shown during this attempt.' : 'Not shown.'}</span>
      </li>
    </ul>
  )
}

export interface ScorecardPanelProps {
  readonly attempt: AttemptRecord
  readonly scorecard: Scorecard
  readonly isLatest: boolean
  readonly now?: number
}

export function ScorecardPanel({ attempt, scorecard: card, isLatest, now }: ScorecardPanelProps) {
  const headingId = useId()
  const early = earlyAttackCount(attempt)
  const reason = passReason(attempt, card.assistance.assisted)
  const completed = card.completion === 'completed'
  // An incomplete attempt has no completion time or tempo comparison, whatever the record holds.
  const timing = completed ? card.timing : 'none'
  const rows = new Map(card.rows.map((r) => [r.id, r]))
  const streakRow = rows.get('streak')
  const diffRow = rows.get('time-difference')

  return (
    <section class={styles.panel} aria-labelledby={headingId} data-completion={card.completion} data-timing={timing}>
      <header class={styles.panelHead}>
        <div>
          <h2 id={headingId}>{isLatest ? 'Latest attempt' : 'Earlier attempt'}</h2>
          <p class={styles.muted}>
            {whenText(attempt.createdAt, now)}
            {attempt.kind === 'reading' ? ' · ordinary reading' : ''}
          </p>
        </div>
        <p
          class={styles.status}
          data-state={completed ? 'completed' : 'incomplete'}
          data-pass={attempt.passed ? '' : undefined}
        >
          <Icon name={completed ? 'check' : 'alert'} size={18} />
          <span>{completed ? 'Completed' : attempt.completion === 'abandoned' ? 'Abandoned' : 'Interrupted'}</span>
          {!completed ? <small>{incompleteReason(attempt)}</small> : null}
        </p>
      </header>

      {attempt.kind === 'reading' ? (
        <p class={styles.note}>This was ordinary reading, not a scored attempt, so it is not compared with anything.</p>
      ) : (
        <p class={styles.passLine} data-reason={reason}>
          {PASS_TEXT[reason]}
        </p>
      )}
      {!completed && attempt.kind === 'scored' ? (
        <p class={styles.note}>
          Incomplete attempts keep their diagnostics below but stay out of rankings and completion times.
        </p>
      ) : null}

      <dl class={styles.tiles}>
        <Tile
          testId="wrong-attacks"
          label="Wrong-note attacks"
          value={card.wrongAttacks}
          detail={
            card.wrongAttacks === 0
              ? 'None'
              : early !== null
                ? `${early} of them too early (right key, pressed before its moment)`
                : undefined
          }
          tone={card.wrongAttacks === 0 ? 'good' : undefined}
        />
        <Tile
          testId="first-pass"
          label="First-pass groups"
          value={card.firstPassPercent === null ? '—' : `${Math.round(card.firstPassPercent)}%`}
          detail={`${attempt.groupsFirstPass} of ${attempt.groupsTotal} onset groups without a wrong attack`}
        />

        {timing === 'rhythm' ? (
          <>
            {RHYTHM_TILES.map(({ id, label, detail }) => {
              const row = rows.get(id)
              return row ? (
                <Tile key={id} testId={id} label={label} value={row.value} detail={row.detail ?? detail} />
              ) : null
            })}
          </>
        ) : attempt.context.transport === 'strict' ? null : timing === 'scored' || timing === 'ungraded' ? (
          <Tile
            testId="completion-time"
            label={timing === 'ungraded' ? 'Time to solve' : 'Completion time'}
            value={card.completionTimeSec === null ? '—' : formatSeconds(card.completionTimeSec)}
            detail={timing === 'ungraded' ? 'Ungraded: a single onset group has no tempo ratio.' : undefined}
          />
        ) : (
          <Tile
            testId="completion-time"
            label="Completion time"
            value="—"
            tone="muted"
            detail={
              timing === 'unscored'
                ? `Timing not scored: ${card.timingNote ?? 'unresolved tempo issue'}`
                : 'Not completed'
            }
          />
        )}
        {timing === 'scored' && card.expectedTimeSec !== null ? (
          <Tile
            testId="expected-time"
            label="Expected time"
            value={formatSeconds(card.expectedTimeSec)}
            detail="Reference attack span at this speed"
          />
        ) : null}
        {timing === 'scored' && diffRow ? (
          <Tile
            testId="time-difference"
            label="Time difference"
            value={diffRow.value}
            detail="Actual minus expected. Neutral: faster is not automatically better."
          />
        ) : null}
        {timing === 'scored' && card.notatedDurationSec !== null ? (
          <Tile
            testId="notated-duration"
            label="Full notated duration"
            value={formatSeconds(card.notatedDurationSec)}
            detail="Including final sustain and trailing rests"
          />
        ) : null}

        {streakRow ? (
          <Tile
            testId="streak"
            label="Practice streak"
            value={streakRow.value}
            detail={`${streakRow.detail ?? ''} in this setting`.trim()}
          />
        ) : null}

        <Tile
          testId="assistance"
          label="Assistance"
          wide
          value={
            card.assistance.level === 'none'
              ? 'None'
              : card.assistance.level === 'names'
                ? 'Note names'
                : 'Keyboard guide'
          }
          tone={card.assistance.assisted ? undefined : 'good'}
        >
          <Assistance attempt={attempt} card={card} />
        </Tile>
      </dl>

      {(timing === 'scored' || timing === 'ungraded') && attempt.context.transport !== 'strict' ? (
        <details class={styles.details}>
          <summary>How completion time is measured</summary>
          <p>{COMPLETION_TIME_DEFINITION}</p>
        </details>
      ) : null}
    </section>
  )
}
