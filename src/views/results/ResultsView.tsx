/**
 * Passage Results (spec "Results and timing", "Repeating passages", "Suggested practice").
 * `ResultsView` reads `resultsRequest` and loads from storage; `ResultsPage` is the presentation
 * over loaded data. Nothing here starts practice: "Practice again" and "Practice this passage"
 * open Practice with the range, hands and speed preselected.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import type { Suggestion, SuggestionSelection } from '../../core/history'
import type { AttemptRecord } from '../../core/model/practice'
import { formatSeconds, timingAccuracy } from '../../core/history'
import { getStorage } from '../../app/services'
import { navigate, openPractice, openSettings, resultsRequest } from '../../app/navigation'
import type { ResultsRequest } from '../../app/navigation'
import { settings } from '../../app/state'
import { Button, Notice } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { SuggestionList, sessionDismissals } from '../shared/suggestions'
import { HistoryPanel } from './HistoryPanel'
import { ScorecardPanel } from './ScorecardPanel'
import { loadResultsData } from './data'
import type { ResultsData } from './data'
import { handsAndSpeed, plural, transportText, whenText } from './format'
import { deriveResults, passageText } from './model'
import styles from './results.module.css'

export interface ResultsPageProps {
  readonly data: ResultsData
  /** Attempt currently shown; null = the latest. */
  readonly selectedId: string | null
  readonly suggestions: SuggestionSelection
  /** Suggested practice is off in Settings (as opposed to this piece only). */
  readonly suggestionsGloballyOff?: boolean
  readonly now?: number
  readonly onSelect: (attemptId: string | null) => void
  readonly onPracticeAgain: (attempt: AttemptRecord) => void
  readonly onPracticeSuggestion: (suggestion: Suggestion) => void
  readonly onDismissSuggestion: (suggestion: Suggestion) => void
  readonly onDisableSuggestions: () => void
  readonly onEnableSuggestions: () => void
  readonly onOpenLibrary: () => void
  readonly onOpenSettings: () => void
}

export function ResultsPage(props: ResultsPageProps) {
  const { data, suggestions, now } = props
  const model = useMemo(
    () =>
      deriveResults({
        attempts: data.attempts,
        occurrences: data.occurrences,
        attemptId: props.selectedId ?? undefined,
      }),
    [data.attempts, data.occurrences, props.selectedId],
  )
  const { attempt, scorecard, labeler } = model
  const piece = data.piece
  const current = attempt !== null && attempt.context.scoreVersionId === piece.scoreVersionId

  const suggestionList = (
    <SuggestionList
      suggestions={props.suggestionsGloballyOff ? [] : suggestions.active}
      improved={props.suggestionsGloballyOff ? [] : suggestions.improved}
      disabled={suggestions.disabled || props.suggestionsGloballyOff === true}
      onPractice={props.onPracticeSuggestion}
      onDismiss={props.onDismissSuggestion}
      onDisableSuggestions={props.onDisableSuggestions}
      {...(props.suggestionsGloballyOff ? {} : { onEnableSuggestions: props.onEnableSuggestions })}
      disableLabel="Turn off suggestions for this piece"
    />
  )
  const globalOff = props.suggestionsGloballyOff ? (
    <p class={styles.note}>
      Suggested practice is switched off in Settings.{' '}
      <Button variant="ghost" onClick={props.onOpenSettings}>
        Open Settings
      </Button>
    </p>
  ) : null

  return (
    <div class={styles.page} data-view="results">
      <header class={styles.hero}>
        <Button variant="ghost" icon="back" onClick={props.onOpenLibrary}>
          Library
        </Button>
        <div>
          <h1>Results</h1>
          <p class={styles.pieceName}>
            {piece.title}
            {piece.composer ? <span class={styles.muted}> · {piece.composer}</span> : null}
          </p>
        </div>
      </header>

      {model.requestedMissing ? (
        <Notice tone="warning">That attempt could not be found, so the most recent one is shown.</Notice>
      ) : null}

      {attempt === null || scorecard === null ? (
        <>
          <section class={styles.empty} data-state="no-attempts">
            <h2>No attempts yet</h2>
            <p>
              Scored attempts appear here after you finish or leave a passage. Choose a passage in Practice and play it
              through. Ordinary reading and Preview are not scored.
            </p>
            <div class={styles.actions}>
              <Button variant="primary" icon="target" onClick={() => openPractice({ pieceId: piece.id })}>
                Open Practice
              </Button>
            </div>
          </section>
          {suggestionList}
          {globalOff}
        </>
      ) : (
        <>
          <section class={styles.context} aria-label="Comparison context" data-row="context">
            <div class={styles.contextFacts}>
              <span class={styles.contextMain}>{passageText(labeler, attempt.context, data.words)}</span>
              <span class={styles.fact}>{handsAndSpeed(attempt.context)}</span>
              {transportText(attempt.context) ? (
                <span class={styles.fact}>{transportText(attempt.context)}</span>
              ) : null}
            </div>
            <div class={styles.actions}>
              <Button
                variant="primary"
                icon="repeat"
                disabled={!current || attempt.context.hands === 'none'}
                onClick={() => props.onPracticeAgain(attempt)}
              >
                Practice again
              </Button>
              {!model.isLatest ? <Button onClick={() => props.onSelect(null)}>Back to latest</Button> : null}
            </div>
          </section>
          {!current ? (
            <Notice tone="info">
              This attempt used an earlier version of the score, so it cannot be practiced again from here and the bar
              numbers may differ.
            </Notice>
          ) : null}

          <div class={styles.columns}>
            <div class={styles.column}>
              <ScorecardPanel
                attempt={attempt}
                scorecard={scorecard}
                isLatest={model.isLatest}
                {...(now !== undefined ? { now } : {})}
              />
              {current ? (
                <>
                  {suggestionList}
                  {globalOff}
                </>
              ) : null}
            </div>
            <div class={styles.column}>
              {model.history ? (
                <HistoryPanel
                  history={model.history}
                  contextText={`${passageText(labeler, attempt.context, data.words)} · ${handsAndSpeed(attempt.context)}`}
                  selectedId={attempt.id}
                  onSelect={props.onSelect}
                  {...(now !== undefined ? { now } : {})}
                />
              ) : (
                <section class={styles.panel} data-panel="history">
                  <h2>History</h2>
                  <p class={styles.note}>Ordinary reading is not compared with scored attempts.</p>
                </section>
              )}
              {model.others.length > 0 ? (
                <section class={styles.panel} aria-labelledby="others-heading" data-panel="others">
                  <h2 id="others-heading">Other settings you have practiced</h2>
                  <p class={styles.note}>
                    Results are never mixed across different passages, hands, speeds, accompaniment or keep-time
                    windows, so each is kept on its own.
                  </p>
                  <ul class={styles.others}>
                    {model.others.map((o) => (
                      <li key={o.results.contextKey} class={styles.other} data-context={o.results.contextKey}>
                        <div>
                          <strong>
                            {passageText(labeler, o.results.context, data.words)} · {handsAndSpeed(o.results.context)}
                          </strong>
                          <p class={styles.muted}>
                            {plural(o.count, 'attempt')} ·{' '}
                            {o.results.bestClean?.completionTimeSec !== undefined
                              ? `best clean unassisted ${
                                  o.results.context.transport === 'strict'
                                    ? `±${Math.round(timingAccuracy(o.results.bestClean)?.meanAbsOffsetMs ?? 0)} ms`
                                    : formatSeconds(o.results.bestClean.completionTimeSec)
                                }`
                              : 'no clean unassisted run yet'}{' '}
                            · last {whenText(o.latest.createdAt, now)}
                          </p>
                        </div>
                        <Button
                          onClick={() => props.onSelect(o.latest.id)}
                          aria-label={`View latest attempt: ${passageText(labeler, o.results.context, data.words)}, ${handsAndSpeed(o.results.context)}`}
                        >
                          View latest
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function EmptyResults() {
  return (
    <div class={styles.page} data-view="results">
      <section class={styles.empty} data-state="no-request">
        <Icon name="chart" size={32} />
        <h1>Results</h1>
        <p>
          Your scorecards, history and suggested practice appear here after you practice a passage. Pick a piece in the
          Library to begin.
        </p>
        <div class={styles.actions}>
          <Button variant="primary" onClick={() => navigate('library')}>
            Go to the Library
          </Button>
        </div>
      </section>
    </div>
  )
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly data: ResultsData; readonly suggestions: SuggestionSelection }

function ResultsLoader({ request }: { request: ResultsRequest }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [selected, setSelected] = useState<string | null>(request.attemptId ?? null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setLoad({ status: 'loading' })
    void (async () => {
      try {
        const storage = await getStorage()
        const loaded = await loadResultsData(storage, request, sessionDismissals)
        if (!live) return
        setLoad(
          loaded.kind === 'missing'
            ? { status: 'missing' }
            : { status: 'ready', data: loaded.data, suggestions: loaded.data.suggestions },
        )
      } catch {
        if (live) setLoad({ status: 'error' })
      }
    })()
    return () => {
      live = false
    }
  }, [request.pieceId, request.attemptId, attempt])

  if (load.status === 'loading') {
    return (
      <div class={styles.page} data-view="results" aria-busy="true">
        <p class={styles.muted} role="status">
          Loading results…
        </p>
      </div>
    )
  }
  if (load.status === 'missing') {
    return (
      <div class={styles.page} data-view="results">
        <section class={styles.empty} data-state="missing">
          <h1>Results</h1>
          <p>That piece is no longer in your library, so there are no results to show.</p>
          <div class={styles.actions}>
            <Button variant="primary" onClick={() => navigate('library')}>
              Go to the Library
            </Button>
          </div>
        </section>
      </div>
    )
  }
  if (load.status === 'error') {
    return (
      <div class={styles.page} data-view="results">
        <Notice tone="danger">Results could not be loaded from this browser's storage.</Notice>
        <div class={styles.actions}>
          <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
          <Button variant="ghost" onClick={() => navigate('library')}>
            Library
          </Button>
        </div>
      </div>
    )
  }

  const { data, suggestions } = load
  const pieceId = data.piece.id
  const refreshSuggestions = async (): Promise<void> => {
    const storage = await getStorage()
    const next = await storage.loadSuggestions(pieceId, sessionDismissals)
    setLoad((prev) => (prev.status === 'ready' ? { ...prev, suggestions: next } : prev))
  }

  return (
    <ResultsPage
      data={data}
      selectedId={selected}
      suggestions={suggestions}
      suggestionsGloballyOff={!settings.value.suggestions.enabled}
      onSelect={setSelected}
      onPracticeAgain={(a) =>
        openPractice({
          pieceId,
          preset: { passage: a.context.passage, hands: a.context.hands, multiplier: a.context.multiplier },
        })
      }
      onPracticeSuggestion={(s) =>
        openPractice({ pieceId, preset: { passage: s.passage, hands: s.hands, multiplier: s.multiplier } })
      }
      onDismissSuggestion={(s) => {
        sessionDismissals.dismiss(s.id)
        void refreshSuggestions()
      }}
      onDisableSuggestions={() => {
        void (async () => {
          const storage = await getStorage()
          await storage.setSuggestionsDisabled(pieceId, true)
          await refreshSuggestions()
        })()
      }}
      onEnableSuggestions={() => {
        void (async () => {
          const storage = await getStorage()
          await storage.setSuggestionsDisabled(pieceId, false)
          await refreshSuggestions()
        })()
      }}
      onOpenLibrary={() => navigate('library')}
      onOpenSettings={openSettings}
    />
  )
}

export function ResultsView() {
  const request = resultsRequest.value
  if (!request) return <EmptyResults />
  return <ResultsLoader key={`${request.pieceId}:${request.attemptId ?? ''}`} request={request} />
}

export default ResultsView
