/**
 * History for one comparison context only (spec "Results and timing"): best clean unassisted
 * runs are ranked on their own, assisted practice is listed apart and never ranked, and
 * incomplete attempts are diagnostics outside every ranking.
 */
import { useId, useState } from 'preact/hooks'
import { formatSeconds } from '../../core/history'
import type { ContextResults } from '../../core/history'
import type { AttemptRecord } from '../../core/model/practice'
import { Button } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { incompleteReason, plural, signedTime, timeText, whenText } from './format'
import styles from './results.module.css'

const INITIAL_ROWS = 5

type RowKind = 'clean' | 'errors' | 'assisted' | 'incomplete'

function rowSummary(a: AttemptRecord, kind: RowKind): string {
  const parts: string[] = []
  if (kind === 'incomplete') {
    parts.push(incompleteReason(a))
    parts.push(plural(a.wrongAttacks, 'wrong attack'))
  } else {
    parts.push(timeText(a))
    if (kind !== 'clean') parts.push(plural(a.wrongAttacks, 'wrong attack'))
    if (kind === 'assisted') parts.push(a.assistance.level === 'keyboard' ? 'keyboard guide' : 'note names')
  }
  return parts.join(' · ')
}

function AttemptRow({
  attempt,
  kind,
  selected,
  best,
  onSelect,
  now,
}: {
  attempt: AttemptRecord
  kind: RowKind
  selected: boolean
  best?: boolean
  onSelect: (id: string) => void
  now?: number | undefined
}) {
  return (
    <li>
      <button
        type="button"
        class={styles.row}
        data-selected={selected ? '' : undefined}
        data-kind={kind}
        data-attempt={attempt.id}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(attempt.id)}
      >
        <span class={styles.rowMain}>
          <span class={styles.rowWhen}>{whenText(attempt.createdAt, now)}</span>
          {best ? <span class={styles.badge}>Best</span> : null}
        </span>
        <span class={styles.rowStat}>{rowSummary(attempt, kind)}</span>
        <span class={styles.rowChevron} aria-hidden="true">
          <Icon name="forward" size={18} />
        </span>
      </button>
    </li>
  )
}

function Group({
  title,
  note,
  kind,
  attempts,
  selectedId,
  onSelect,
  bestId,
  now,
  empty,
}: {
  title: string
  note: string
  kind: RowKind
  attempts: readonly AttemptRecord[]
  selectedId: string | null
  onSelect: (id: string) => void
  bestId?: string | undefined
  now?: number | undefined
  empty?: string
}) {
  const [all, setAll] = useState(false)
  const headingId = useId()
  if (attempts.length === 0 && empty === undefined) return null
  const shown = all ? attempts : attempts.slice(0, INITIAL_ROWS)
  return (
    <section class={styles.group} aria-labelledby={headingId} data-group={kind}>
      <h3 id={headingId}>
        {title} <span class={styles.count}>{attempts.length}</span>
      </h3>
      <p class={styles.muted}>{note}</p>
      {attempts.length === 0 ? (
        <p class={styles.emptyLine}>{empty}</p>
      ) : (
        <ul class={styles.rows}>
          {shown.map((a) => (
            <AttemptRow
              key={a.id}
              attempt={a}
              kind={kind}
              selected={a.id === selectedId}
              best={a.id === bestId}
              onSelect={onSelect}
              now={now}
            />
          ))}
        </ul>
      )}
      {attempts.length > INITIAL_ROWS ? (
        <Button variant="ghost" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${attempts.length}`}
        </Button>
      ) : null}
    </section>
  )
}

export interface HistoryPanelProps {
  readonly history: ContextResults
  /** Heading detail: the context in words ("Bars 12–16 · Right hand at 0.75×"). */
  readonly contextText: string
  readonly selectedId: string | null
  readonly onSelect: (attemptId: string) => void
  readonly now?: number
}

export function HistoryPanel({ history, contextText, selectedId, onSelect, now }: HistoryPanelProps) {
  const headingId = useId()
  const best = history.bestClean
  return (
    <section class={styles.panel} aria-labelledby={headingId} data-panel="history">
      <header class={styles.panelHead}>
        <div>
          <h2 id={headingId}>History in this setting</h2>
          <p class={styles.muted}>{contextText}</p>
        </div>
      </header>
      <p class={styles.note}>
        Only attempts with the same score version, passage, hands, speed, accompaniment mode and matching rules are
        compared here. Change any of them and a separate history starts.
      </p>

      <div class={styles.bestRow}>
        <div class={styles.bestCard} data-state={best ? 'has-best' : 'no-best'} data-row="best-clean">
          <h3>Best clean unassisted</h3>
          {best ? (
            <>
              <p class={styles.bestValue}>
                {best.completionTimeSec === undefined ? '—' : formatSeconds(best.completionTimeSec)}
              </p>
              <p class={styles.muted}>
                {signedTime(best) !== null ? `${signedTime(best)} from expected · ` : ''}
                {whenText(best.createdAt, now)}
              </p>
              <p class={styles.muted}>Closest to the expected time, because faster is not automatically better.</p>
            </>
          ) : (
            <p class={styles.muted}>No completion with zero wrong notes and no assistance yet in this setting.</p>
          )}
        </div>
        <div class={styles.bestCard} data-row="streak">
          <h3>Practice streak</h3>
          <p class={styles.bestValue}>{history.streak.current}</p>
          <p class={styles.muted}>Best {history.streak.best} in this setting</p>
        </div>
      </div>

      <Group
        title="Clean and unassisted"
        note="Ranked by closeness to the expected time."
        kind="clean"
        attempts={history.cleanRanking}
        selectedId={selectedId}
        onSelect={onSelect}
        bestId={best?.id}
        now={now}
      />
      <Group
        title="Unassisted, with wrong notes"
        note="Newest first. Not ranked."
        kind="errors"
        attempts={history.unassistedWithErrors}
        selectedId={selectedId}
        onSelect={onSelect}
        now={now}
      />
      <Group
        title="Assisted practice"
        note="Note names or the keyboard guide were shown. Kept apart from your clean results and never ranked."
        kind="assisted"
        attempts={history.assisted}
        selectedId={selectedId}
        onSelect={onSelect}
        now={now}
      />
      <Group
        title="Incomplete attempts"
        note="Diagnostics only: paused, interrupted or stopped attempts are not ranked and have no completion time."
        kind="incomplete"
        attempts={history.incomplete}
        selectedId={selectedId}
        onSelect={onSelect}
        now={now}
      />
    </section>
  )
}
