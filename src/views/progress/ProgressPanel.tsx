import { messageLanguage, msg } from '../../i18n/messages'
/**
 * The contents of Progress (U148; `ProgressSheet` loads them on the first opening), in three sections:
 * Work on next (the piece's suggestions, and their per-piece switch), Past passes (the stored attempts
 * of its current score version by comparison context, RV1; help is not told apart, U144) and
 * Recordings. It starts nothing and opens no screen: what a suggestion's button does is its caller's.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Suggestion } from '../../core/history'
import type { PassageWords } from '../../core/model/passage'
import type { PianissimoStorage } from '../../core/storage'
import { Button } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { RecordingList } from '../recordings/History'
import { HistoryPanel } from '../results/HistoryPanel'
import { ScorecardPanel } from '../results/ScorecardPanel'
import { loadResultsData, type ResultsData } from '../results/data'
import { attemptText, cleanText, handsAndSpeed, modeText, whenText } from '../results/format'
import { deriveResults, passGroups, passageText, type PassGroup } from '../results/model'
import { PieceSuggestionsModel, SuggestionList } from '../shared/suggestions'
import styles from './progress.module.css'

/** Contexts listed before "Show all". */
const INITIAL_GROUPS = 5

export interface ProgressPanelProps {
  readonly pieceId: string
  readonly storage: () => Promise<PianissimoStorage>
  /** The score already open (Practice): its takes need not load it again. */
  readonly model?: (PassageWords & { readonly scoreVersionId: string }) | undefined
  /** Practice these bars. */
  readonly onPractice: (suggestion: Suggestion) => void
  readonly onOpenSettings: () => void
}

export function ProgressPanel({ pieceId, storage, model, onPractice, onOpenSettings }: ProgressPanelProps) {
  return (
    <div class={styles.panel}>
      <WorkOnNext pieceId={pieceId} storage={storage} onPractice={onPractice} onOpenSettings={onOpenSettings} />
      <PastPasses pieceId={pieceId} storage={storage} />
      <section class={styles.section} aria-labelledby="progress-recordings">
        <h3 id="progress-recordings">{msg('Recordings')}</h3>
        <RecordingList storage={storage} pieceId={pieceId} model={model} />
      </section>
    </div>
  )
}

function WorkOnNext({ pieceId, storage, onPractice, onOpenSettings }: Omit<ProgressPanelProps, 'model'>) {
  const suggestions = useMemo(
    () => new PieceSuggestionsModel({ getStorage: storage }, pieceId),
    [pieceId, storage, messageLanguage()],
  )
  const [error, setError] = useState(false)
  useEffect(() => {
    void suggestions.start()
    return () => suggestions.dispose()
  }, [suggestions])
  const state = suggestions.state.value
  if (state.status !== 'ready')
    return (
      <section class={styles.section} aria-labelledby="progress-next">
        <h3 id="progress-next">{msg('Work on next')}</h3>
        {state.status === 'loading' ? (
          <p class={styles.muted}>{msg('Loading…')}</p>
        ) : (
          <>
            <p class={styles.muted}>{state.message}</p>
            <div>
              <Button onClick={() => void suggestions.load()}>{msg('Retry')}</Button>
            </div>
          </>
        )}
      </section>
    )
  const off = state.globallyDisabled
  const turn = (disabled: boolean) => {
    setError(false)
    suggestions.setDisabled(disabled).catch(() => setError(true))
  }
  return (
    <div class={styles.section}>
      <SuggestionList
        compact
        headingLevel={3}
        title={msg('Work on next')}
        suggestions={off ? [] : state.selection.active}
        improved={off ? [] : state.selection.improved}
        disabled={off || state.selection.disabled}
        onPractice={onPractice}
        onDismiss={(s) => suggestions.dismiss(s.id)}
        onDisableSuggestions={() => turn(true)}
        {...(off ? {} : { onEnableSuggestions: () => turn(false) })}
        disableLabel={msg('Turn off suggestions for this piece')}
      />
      {off ? (
        <p class={styles.muted}>
          {msg('Suggested practice is switched off in Settings.')}{' '}
          <Button variant="ghost" onClick={onOpenSettings}>
            {msg('Open Settings')}
          </Button>
        </p>
      ) : null}
      {error ? <p role="alert">{msg('The suggestion preference could not be saved. Try again.')}</p> : null}
    </div>
  )
}

function PastPasses({ pieceId, storage }: Pick<ProgressPanelProps, 'pieceId' | 'storage'>) {
  const [data, setData] = useState<ResultsData | 'loading' | 'error'>('loading')
  const [reload, setReload] = useState(0)
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setData('loading')
    storage()
      .then((s) => loadResultsData(s, { pieceId }))
      .then(
        (loaded) => live && setData(loaded.kind === 'ready' ? loaded.data : 'error'),
        () => live && setData('error'),
      )
    return () => {
      live = false
    }
  }, [pieceId, storage, reload])
  const groups = useMemo(() => (typeof data === 'object' ? passGroups(data.attempts) : []), [data])
  const shown = all ? groups : groups.slice(0, INITIAL_GROUPS)
  return (
    <section class={styles.section} aria-labelledby="progress-passes">
      <h3 id="progress-passes">{msg('Past passes')}</h3>
      {data === 'loading' ? (
        <p class={styles.muted}>{msg('Loading earlier passes…')}</p>
      ) : data === 'error' ? (
        <>
          <p class={styles.muted}>{msg('Earlier passes could not be loaded.')}</p>
          <div>
            <Button onClick={() => setReload((n) => n + 1)}>{msg('Retry')}</Button>
          </div>
        </>
      ) : groups.length === 0 ? (
        <p class={styles.muted}>{msg('No passes yet.')}</p>
      ) : (
        <ul class={styles.groups}>
          {shown.map((group) => {
            const key = group.results.contextKey
            return (
              <PassGroupRow
                key={key}
                group={group}
                data={data}
                open={open === key}
                onToggle={() => setOpen((old) => (old === key ? null : key))}
              />
            )
          })}
        </ul>
      )}
      {groups.length > INITIAL_GROUPS ? (
        <div>
          <Button variant="ghost" onClick={() => setAll(!all)}>
            {all ? msg('Show fewer') : msg('Show all {0}', groups.length)}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

/** One comparison context: its bars and settings, how many passes, the best clean one and the last. */
function PassGroupRow({
  group,
  data,
  open,
  onToggle,
}: {
  group: PassGroup
  data: ResultsData
  open: boolean
  onToggle: () => void
}) {
  const { results, latest, count } = group
  const { labeler } = useMemo(() => deriveResults({ attempts: [], occurrences: data.occurrences }), [data])
  const bars = passageText(labeler, results.context, data.words)
  const best = results.cleanCompletions[0]
  return (
    <li class={styles.group} data-context={results.contextKey}>
      <button type="button" class={styles.summary} aria-expanded={open} onClick={onToggle}>
        <span class={styles.words}>
          <strong>{bars}</strong>
          <small>
            {modeText(results.context)} · {handsAndSpeed(results.context)}
          </small>
          <small>
            {count === 1 ? msg('1 pass') : msg('{0} passes', count)} ·{' '}
            {best ? msg('Best clean: {0}', cleanText(best)) : msg('No clean pass yet')}
          </small>
          <small>
            {msg('Last: {0}', whenText(latest.createdAt))} · {attemptText(latest)}
          </small>
        </span>
        <span class={styles.chevron} aria-hidden="true">
          <Icon name={open ? 'up' : 'down'} size={18} />
        </span>
      </button>
      {open ? <PassGroupDetail group={group} data={data} bars={bars} /> : null}
    </li>
  )
}

/** The context's history and, from a row of it, that pass's scorecard in its place. */
function PassGroupDetail({ group, data, bars }: { group: PassGroup; data: ResultsData; bars: string }) {
  const [selected, setSelected] = useState<string | null>(null)
  const last = useRef<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const shown = useMemo(
    () =>
      selected === null
        ? null
        : deriveResults({ attempts: data.attempts, occurrences: data.occurrences, attemptId: selected }),
    [data, selected],
  )
  // Focus follows what is shown: the way back, then the row it came from.
  useEffect(() => {
    const target = selected === null ? last.current && `[data-attempt="${last.current}"]` : 'button'
    if (target) root.current?.querySelector<HTMLElement>(target)?.focus()
    last.current = selected
  }, [selected])
  return (
    <div class={styles.detail} ref={root}>
      {shown?.attempt && shown.scorecard ? (
        <>
          <div>
            <Button icon="back" onClick={() => setSelected(null)}>
              {msg('Back to these passes')}
            </Button>
          </div>
          <ScorecardPanel
            attempt={shown.attempt}
            scorecard={shown.scorecard}
            isLatest={shown.attempt.id === group.latest.id}
          />
        </>
      ) : null}
      {/* Kept, so that coming back finds it as it was left. */}
      <div hidden={selected !== null}>
        <HistoryPanel
          history={group.results}
          contextText={`${bars} · ${handsAndSpeed(group.results.context)}`}
          selectedId={null}
          onSelect={setSelected}
        />
      </div>
    </div>
  )
}
