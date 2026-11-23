import { msg } from '../../i18n/messages'
/**
 * History for one comparison context only (spec "Results and timing"): clean passes are ranked, the
 * others are listed newest first, and incomplete attempts are diagnostics outside every ranking. Help
 * is not told apart (U144).
 */
import { useId, useState } from 'preact/hooks'
import type { ContextResults } from '../../core/history'
import type { AttemptRecord } from '../../core/model/practice'
import { Button } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { attemptText, cleanText, signedTime, whenText } from './format'
import styles from './results.module.css'

const INITIAL_ROWS = 5

type RowKind = 'clean' | 'errors' | 'incomplete'

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
          {best ? <span class={styles.badge}>{msg('Best')}</span> : null}
        </span>
        <span class={styles.rowStat}>{attemptText(attempt)}</span>
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
}: {
  title: string
  note: string
  kind: RowKind
  attempts: readonly AttemptRecord[]
  selectedId: string | null
  onSelect: (id: string) => void
  bestId?: string | undefined
  now?: number | undefined
}) {
  const [all, setAll] = useState(false)
  const headingId = useId()
  if (attempts.length === 0) return null
  const shown = all ? attempts : attempts.slice(0, INITIAL_ROWS)
  return (
    <section class={styles.group} aria-labelledby={headingId} data-group={kind}>
      <h3 id={headingId}>
        {title} <span class={styles.count}>{attempts.length}</span>
      </h3>
      <p class={styles.muted}>{note}</p>
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
      {attempts.length > INITIAL_ROWS ? (
        <Button variant="ghost" onClick={() => setAll(!all)}>
          {all ? msg('Show fewer') : msg('Show all {0}', attempts.length)}
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
  const clean = history.cleanCompletions
  const best = clean[0] ?? null
  return (
    <section class={styles.panel} aria-labelledby={headingId} data-panel="history">
      <header class={styles.panelHead}>
        <div>
          <h2 id={headingId}>{msg('History in this setting')}</h2>
          <p class={styles.muted}>{contextText}</p>
        </div>
      </header>
      <p class={styles.note}>
        {msg(
          'Only attempts with the same score version, passage, hands, speed, accompaniment or keep-time mode (and its timing window) and matching rules are compared here. Change any of them and a separate history starts.',
        )}
      </p>

      <div class={styles.bestRow}>
        <div class={styles.bestCard} data-state={best ? 'has-best' : 'no-best'} data-row="best-clean">
          <h3>{msg('Best clean')}</h3>
          {best ? (
            <>
              <p class={styles.bestValue}>{cleanText(best)}</p>
              <p class={styles.muted}>
                {signedTime(best) !== null ? msg('{0} from expected · ', signedTime(best)) : ''}
                {whenText(best.createdAt, now)}
              </p>
              <p class={styles.muted}>
                {best.context.transport === 'strict'
                  ? msg('Smallest average offset from the music, over all groups.')
                  : msg('Closest to the expected time, because faster is not automatically better.')}
              </p>
            </>
          ) : (
            <p class={styles.muted}>{msg('No completion with zero wrong notes yet in this setting.')}</p>
          )}
        </div>
        <div class={styles.bestCard} data-row="streak">
          <h3>{msg('Practice streak')}</h3>
          <p class={styles.bestValue}>{history.streak.current}</p>
          <p class={styles.muted}>{msg('Best {0} in this setting', history.streak.best)}</p>
        </div>
      </div>

      <Group
        title={msg('Clean')}
        note={
          clean.some((a) => a.context.transport === 'strict')
            ? msg('Ranked by average offset from the music.')
            : msg('Ranked by closeness to the expected time.')
        }
        kind="clean"
        attempts={clean}
        selectedId={selectedId}
        onSelect={onSelect}
        bestId={best?.id}
        now={now}
      />
      <Group
        title={msg('Not clean')}
        note={msg('Newest first. Not ranked.')}
        kind="errors"
        attempts={history.notClean}
        selectedId={selectedId}
        onSelect={onSelect}
        now={now}
      />
      <Group
        title={msg('Incomplete attempts')}
        note={msg(
          'Diagnostics only: paused, interrupted or stopped attempts are not ranked and have no completion time.',
        )}
        kind="incomplete"
        attempts={history.incomplete}
        selectedId={selectedId}
        onSelect={onSelect}
        now={now}
      />
    </section>
  )
}
