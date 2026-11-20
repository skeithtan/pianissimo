/**
 * The expanded result card (DECISIONS U99), loaded on its first expansion
 * (`ResultDetailsLoader`). The music is the point: the pass's mistakes ranked by severity
 * (`rankMistakes`), each place shown as a small excerpt of the score (`render/excerpt`) with the
 * teacher's ring and a ghost note for each key pressed that is not written there, and a plain
 * sentence per wrong key ("You pressed D♭ where D♮ is written"). The same wrong key pass after
 * pass leads the excerpts, under "Keeps happening". The pill previews the pass facts at the top.
 * Below the excerpts sit all the numbers and the earlier passes of this loop, folded. Nothing here
 * navigates: a history row shows that pass's numbers in the card; an excerpt is only a picture.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { AttemptSummary, SnippetState } from '../../app/session'
import type { SnippetKind } from '../../app/session/snippets'
import { passesText, pressGhost, rankMistakes, wrongPressLine, type RankedMistake } from '../../app/session/ranking'
import { getStorage } from '../../app/services'
import type { ScoreModel } from '../../core/model/score'
import type { NamingSettings } from '../../core/model/settings'
import { canvasMeasurer, estimateMeasurer, type PreparedLayout } from '../../render'
import type { CorrectionMark } from '../../render/shared/corrections'
import { EXCERPT_LIMIT, excerptMarkup, planExcerpts, type ExcerptPlan, type GhostNote } from '../../render/excerpt'
import { Button } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { HistoryPanel } from '../results/HistoryPanel'
import { ScorecardPanel } from '../results/ScorecardPanel'
import { loadResultsData, type ResultsData } from '../results/data'
import { handsAndSpeed } from '../results/format'
import { deriveResults, passageText } from '../results/model'
import { passFacts, wrongText } from './format'
import type { ResultDetailsProps } from './resultDetailsTypes'
import { buildTimingReview } from './timingReview'
import { TimingReviewStrip } from './TimingReviewStrip'
import { useStore } from './useStore'
import '../../render/excerpt.css'
import styles from './resultDetails.module.css'

/** More bars mounted per "Show more" (they are systems of real notation: keep it bounded). */
const MORE_STEP = 6
/** Wrong-key sentences listed per place; more are counted. */
const LINES_PER_PLACE = 4

const KEEPS: ReadonlySet<RankedMistake['level']> = new Set(['repeated', 'habit', 'trouble'])

export function ResultDetails(p: ResultDetailsProps) {
  // Ranked once per result, on this render after the tap, never in the input path.
  const details = useMemo(() => {
    const current = p.session.resultDetails()
    return current?.attemptId === p.result.id ? current : null
  }, [p.session, p.result.id])
  const mistakes = useMemo(
    () => (details ? (p.rank ?? rankMistakes)(details.records, details.timeline, p.model, details.marks) : []),
    [details, p.model, p.rank],
  )
  const timing = useMemo(
    () => (details && p.result.timing ? buildTimingReview(details) : null),
    [details, p.result.timing],
  )
  const [limit, setLimit] = useState(EXCERPT_LIMIT)
  const { shown, more } = useMemo(() => planExcerpts(mistakes, limit), [mistakes, limit])
  const keeps = shown.filter((plan) => KEEPS.has(plan.items[0]!.level))
  const once = shown.filter((plan) => !KEEPS.has(plan.items[0]!.level))
  const measurer = useMemo(
    () => (typeof document === 'undefined' ? estimateMeasurer : (canvasMeasurer(document) ?? estimateMeasurer)),
    [],
  )
  // Mistake playback (U100): what is playing, and it stops when the card folds or goes.
  const playing = useStore(p.session.snippet)
  const session = p.session
  useEffect(() => () => session.stopSnippet(), [session])
  const listen: Listen = {
    attemptId: p.result.id,
    playing,
    blocked: (occ, kind) => session.snippetBlocked(p.result.id, occ, kind),
    toggle: (occ, kind) => {
      if (playing?.occ === occ && playing.kind === kind) {
        session.stopSnippet()
        return Promise.resolve(null)
      }
      return session.playSnippet(p.result.id, occ, kind)
    },
  }
  const excerpt = (plan: ExcerptPlan<RankedMistake>) => (
    <Excerpt
      key={plan.occ}
      plan={plan}
      layout={p.layout}
      model={p.model}
      naming={p.naming}
      measurer={measurer}
      listen={listen}
    />
  )
  const timingStrip =
    timing && details ? (
      <TimingReviewStrip key={p.result.id} data={timing} layout={p.layout} marks={details.marks} measurer={measurer} />
    ) : null
  return (
    <div class={styles.details}>
      <p class={styles.verdict} data-testid="result-verdict">
        {verdict(p.result)}
      </p>
      {mistakes.length === 0 && !timing?.hasTimingDeviation ? (
        <p class={styles.clean} data-testid="result-clean">
          {p.result.passed ? 'No mistakes in this pass.' : 'No wrong keys or timing marks in this pass.'}
        </p>
      ) : null}
      <PassFacts result={p.result} goal={p.goal} />
      {keeps.length ? (
        <section class={styles.group} data-group="keeps" aria-labelledby="result-keeps">
          <h3 id="result-keeps" class={styles.keepsHeading}>
            Keeps happening
          </h3>
          {keeps.map(excerpt)}
        </section>
      ) : null}
      {once.length ? (
        <section class={styles.group} data-group="once" aria-labelledby="result-once">
          <h3 id="result-once" class={styles.groupHeading}>
            {keeps.length ? 'Also in this pass' : 'In this pass'}
          </h3>
          {once.map(excerpt)}
        </section>
      ) : null}
      {more.length ? (
        <Button class={styles.more} onClick={() => setLimit((n) => n + MORE_STEP)}>
          {more.length === 1 ? 'Show 1 more bar' : `Show ${more.length} more bars`}
        </Button>
      ) : null}
      {timing?.hasTimingDeviation ? timingStrip : null}
      {timing?.hasTimingDeviation ? null : timingStrip}
      <Earlier pieceId={p.pieceId} attemptId={p.result.id} {...(p.loadHistory ? { load: p.loadHistory } : {})} />
    </div>
  )
}

/** The excerpts' playback controls (U100). */
interface Listen {
  readonly attemptId: string
  readonly playing: SnippetState | null
  blocked(occ: number, kind: SnippetKind): string | null
  /** Plays (or stops, when it is the one playing); resolves with why it did not play. */
  toggle(occ: number, kind: SnippetKind): Promise<string | null>
}

const SNIPPET_LABEL: Readonly<Record<SnippetKind, string>> = {
  played: 'What you played',
  written: 'As written',
}

/**
 * "What you played" (the pass's own key presses in this bar, replayed) and "As written" (the bar
 * from the score at the pass's speed). The one sounding shows Stop; a short line says why one
 * cannot play, or that long pauses were shortened.
 */
function ListenControls({ occ, bar, listen }: { occ: number; bar: string; listen: Listen }) {
  const [refused, setRefused] = useState<string | null>(null)
  const kinds: SnippetKind[] = ['played', 'written']
  const blocked = kinds.map((k) => listen.blocked(occ, k))
  const on = listen.playing?.occ === occ ? listen.playing : null
  const note = on?.shortened ? 'Long pauses are shortened.' : (refused ?? blocked[0] ?? blocked[1])
  return (
    <div class={styles.listen} data-testid="excerpt-listen">
      <div class={styles.listenButtons} role="group" aria-label={`Listen to bar ${bar}`}>
        {kinds.map((kind, i) => {
          const sounding = on?.kind === kind
          return (
            <button
              key={kind}
              type="button"
              class={styles.listenButton}
              aria-pressed={sounding}
              disabled={!sounding && blocked[i] !== null}
              title={blocked[i] ?? undefined}
              data-kind={kind}
              onClick={() => {
                setRefused(null)
                void listen.toggle(occ, kind).then((why) => setRefused(why))
              }}
            >
              <Icon name={sounding ? 'stop' : 'play'} size={16} />
              <span>{SNIPPET_LABEL[kind]}</span>
            </button>
          )
        })}
      </div>
      {note ? <p class={styles.listenNote}>{note}</p> : null}
    </div>
  )
}

/** One bar of the score with its marks, and what went wrong there in words. */
function Excerpt({
  plan,
  layout,
  model,
  naming,
  measurer,
  listen,
}: {
  plan: ExcerptPlan<RankedMistake>
  layout: PreparedLayout | null
  model: ScoreModel
  naming: NamingSettings
  measurer: NonNullable<Parameters<typeof excerptMarkup>[2]>['measurer']
  listen: Listen
}) {
  const lead = plan.items[0]!
  const markup = useMemo(() => {
    if (!layout) return null
    const marks: CorrectionMark[] = plan.items
      .filter((m) => m.mark)
      .map((m) => ({ notes: m.notes, kind: m.mark!.kind as CorrectionMark['kind'], text: m.mark!.text }))
    const ghosts = plan.items.flatMap((m) =>
      m.presses.map((press) => pressGhost(press, m.notes, model)).filter((g): g is GhostNote => g !== null),
    )
    return excerptMarkup(layout, plan.occ, { marks, ghosts, ...(measurer ? { measurer } : {}) })
  }, [layout, plan, model, measurer])
  const lines = plan.items.flatMap((m) => itemLines(m, model, naming))
  const extra = lines.length - LINES_PER_PLACE
  return (
    <figure
      class={styles.excerpt}
      data-testid="result-excerpt"
      data-occ={plan.occ}
      data-level={lead.level}
      aria-label={`Bar ${lead.bar}`}
    >
      <figcaption class={styles.caption}>
        <span class={styles.bar}>Bar {lead.bar}</span>
        <span class={styles.reason} data-level={lead.level}>
          {lead.reason}
        </span>
      </figcaption>
      {markup ? (
        <div
          class={`${styles.music} pn-excerpt`}
          data-testid="excerpt-music"
          style={{ '--excerpt-w': `${markup.width}px` }}
          // Sanitized segment markup plus shapes built from numbers and escaped text (render/excerpt).
          dangerouslySetInnerHTML={{ __html: markup.svg }}
        />
      ) : null}
      <ul class={styles.lines}>
        {lines.slice(0, extra > 0 ? LINES_PER_PLACE - 1 : LINES_PER_PLACE).map((line, i) => (
          <li key={i} data-repeat={line.flag ? '' : undefined}>
            {line.text}
            {line.flag ? <strong class={styles.flag}> ({line.flag})</strong> : null}
          </li>
        ))}
        {extra > 0 ? <li class={styles.muted}>and {extra + 1} more wrong keys here</li> : null}
      </ul>
      <ListenControls occ={plan.occ} bar={lead.bar} listen={listen} />
    </figure>
  )
}

const MARK_WORDS: Readonly<Record<string, string>> = {
  missed: 'Missed: the music moved on before it was played',
  early: 'Too soon: pressed before its time',
  late: 'Too late: played after the music reached it',
  spread: 'Not together: the chord was spread out',
  tie: 'A tied note pressed again: hold it instead',
}

function itemLines(m: RankedMistake, model: ScoreModel, naming: NamingSettings): { text: string; flag: string }[] {
  if (m.presses.length > 0)
    return m.presses.map((press) => ({ text: wrongPressLine(press, model, naming), flag: passesText(press.passes) }))
  const words = (m.mark && MARK_WORDS[m.mark.kind]) ?? m.mark?.text ?? m.reason
  return [{ text: words, flag: '' }]
}

/** "Clean pass: no wrong notes and no help." or why not, in one plain sentence. */
export function verdict(r: AttemptSummary): string {
  if (r.passed) return 'Clean pass: no wrong notes and no help.'
  if (r.wrongAttacks > 0) return `Not clean: ${wrongText(r.wrongAttacks).toLowerCase()}.`
  if (r.timing && r.timing.onTime < r.timing.groups) return 'Not clean: the timing slipped.'
  if (r.assistance === 'keyboard') return 'Not clean: the keyboard guide helped.'
  if (r.assistance === 'names') return 'Not clean: note names helped.'
  return 'Completed, but not counted as clean.'
}

function PassFacts({ result, goal }: { result: AttemptSummary; goal: number | null }) {
  return (
    <section class={styles.group} aria-labelledby="result-facts">
      <h3 id="result-facts" class={styles.groupHeading}>
        This pass
      </h3>
      <ul class={styles.facts} data-testid="result-facts">
        {passFacts(result, goal).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  )
}

async function storedHistory(pieceId: string, attemptId: string): Promise<ResultsData | null> {
  const storage = await getStorage()
  const loaded = await loadResultsData(storage, { pieceId, attemptId })
  return loaded.kind === 'ready' ? loaded.data : null
}

/**
 * Folded: all the numbers of this pass (the Results scorecard) and the earlier passes of this
 * loop (the Results history of its comparison context). A history row shows that pass's numbers
 * here, with a way back to this pass; nothing opens another screen.
 */
function Earlier({
  pieceId,
  attemptId,
  load = storedHistory,
}: {
  pieceId: string
  attemptId: string
  load?: (pieceId: string, attemptId: string) => Promise<ResultsData | null>
}) {
  const [data, setData] = useState<ResultsData | null | 'loading' | 'error'>('loading')
  const [selected, setSelected] = useState<string>(attemptId)
  const numbers = useRef<HTMLDetailsElement>(null)
  // A history row shows that pass's numbers above the list: bring them into view.
  useEffect(() => {
    if (selected !== attemptId) numbers.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, attemptId])
  useEffect(() => {
    let live = true
    load(pieceId, attemptId).then(
      (d) => live && setData(d),
      () => live && setData('error'),
    )
    return () => {
      live = false
    }
  }, [pieceId, attemptId, load])
  const model = useMemo(
    () =>
      data && typeof data === 'object'
        ? deriveResults({ attempts: data.attempts, occurrences: data.occurrences, attemptId: selected })
        : null,
    [data, selected],
  )
  if (data === 'loading') return <p class={styles.muted}>Loading earlier passes…</p>
  if (data === 'error' || data === null || !model?.attempt || !model.scorecard)
    return <p class={styles.muted}>Earlier passes could not be loaded.</p>
  const attempt = model.attempt
  const isThis = attempt.id === attemptId
  const context = `${passageText(model.labeler, attempt.context, data.words)} · ${handsAndSpeed(attempt.context)}`
  return (
    <>
      <details ref={numbers} class={styles.fold} data-testid="result-numbers" open={!isThis || undefined}>
        <summary>{isThis ? 'All the numbers for this pass' : 'An earlier pass'}</summary>
        {!isThis ? (
          <Button class={styles.backToPass} icon="back" onClick={() => setSelected(attemptId)}>
            Back to this pass
          </Button>
        ) : null}
        <ScorecardPanel attempt={attempt} scorecard={model.scorecard} isLatest={isThis} />
      </details>
      {model.history && model.historyCount > 1 ? (
        <details class={styles.fold} data-testid="result-history">
          <summary>Earlier passes of this loop ({model.historyCount - 1})</summary>
          <HistoryPanel history={model.history} contextText={context} selectedId={attempt.id} onSelect={setSelected} />
        </details>
      ) : null}
    </>
  )
}
