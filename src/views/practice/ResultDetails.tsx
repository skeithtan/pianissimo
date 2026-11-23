import { msg, messageLanguage } from '../../i18n/messages'
/**
 * The expanded result card (DECISIONS U99), loaded on its first expansion
 * (`ResultDetailsLoader`). The music is the point: the pass's mistakes ranked by severity
 * (`rankMistakes`), each place shown as a small excerpt of the score (`render/excerpt`) with the
 * teacher's ring and a ghost note for each key pressed that is not written there, and a plain
 * sentence per wrong key ("You pressed D♭ where D♮ is written"). The same wrong key pass after
 * pass leads the excerpts, under "Keeps happening". The pill previews the pass facts at the top.
 * Timing evidence and playback sit with each bar's other corrections. The pass numbers and earlier
 * passes sit below the corrections. Nothing here
 * navigates: a history row shows that pass's numbers in the card; an excerpt is only a picture.
 */
import { memo } from 'preact/compat'
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
import { passFacts } from './format'
import type { ResultDetailsProps } from './resultDetailsTypes'
import { TimingBarPlot } from './TimingBarPlot'
import { buildTimingReview, timingBarDetail, timingBarTitle, type TimingReviewData } from './timingReview'
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
    [details, p.model, p.rank, messageLanguage()],
  )
  const timing = useMemo(
    () => (details && p.result.timing ? buildTimingReview(details) : null),
    [details, p.result.timing],
  )
  const [limit, setLimit] = useState(EXCERPT_LIMIT)
  const hasTimingCorrections = !!timing?.bars.size
  const { shown, more } = useMemo(() => {
    const plans = planExcerpts(mistakes, timing?.bars.size ? Infinity : limit)
    if (timing?.bars.size) {
      const rankedBars = new Set(plans.shown.map((plan) => plan.occ))
      for (const occ of timing.bars.keys()) {
        if (!rankedBars.has(occ)) plans.shown.push({ occ, items: [] })
      }
    }
    return plans
  }, [mistakes, timing, limit])
  const noMistakes =
    shown.length === 0 &&
    p.result.wrongAttacks === 0 &&
    p.result.groupsFirstPass === p.result.groupsTotal &&
    (!p.result.timing || p.result.timing.onTime === p.result.timing.groups)
  const keeps = shown.filter((plan) => KEEPS.has(plan.items[0]?.level ?? 'timing'))
  const once = shown.filter((plan) => !KEEPS.has(plan.items[0]?.level ?? 'timing'))
  const measurer = useMemo(
    () => (typeof document === 'undefined' ? estimateMeasurer : (canvasMeasurer(document) ?? estimateMeasurer)),
    [],
  )
  // Mistake playback (U100): what is playing, and it stops when the card folds or goes.
  const playing = useStore(p.session.snippet)
  const session = p.session
  useEffect(() => () => session.stopSnippet(), [session])
  // One toggle for every card, so a card re-renders only when its own props change.
  const latest = useRef({ playing, session, id: p.result.id })
  latest.current = { playing, session, id: p.result.id }
  const toggle = useMemo(
    () =>
      (occ: number, kind: SnippetKind): Promise<string | null> => {
        const { playing: now, session: s, id } = latest.current
        if (now?.occ === occ && now.kind === kind) {
          s.stopSnippet()
          return Promise.resolve(null)
        }
        return s.playSnippet(id, occ, kind)
      },
    [],
  )
  const excerpt = (plan: ExcerptPlan<RankedMistake>, index: number) => (
    <Excerpt
      key={plan.occ}
      plan={plan}
      layout={p.layout}
      model={p.model}
      naming={p.naming}
      measurer={measurer}
      sounding={playing?.occ === plan.occ ? playing : null}
      blockedPlayed={session.snippetBlocked(p.result.id, plan.occ, 'played')}
      blockedWritten={session.snippetBlocked(p.result.id, plan.occ, 'written')}
      onListen={toggle}
      timing={timing}
      // Every affected bar stays in the list (U108); its notation is mounted only near the view.
      virtual={hasTimingCorrections}
      deferMusic={hasTimingCorrections && index >= EXCERPT_LIMIT}
    />
  )
  return (
    <div class={styles.details}>
      <p class={styles.verdict} data-testid="result-verdict">
        {verdict(p.result)}
      </p>
      {noMistakes && (p.result.passed || details) ? (
        <p class={styles.clean} data-testid="result-clean">
          {p.result.passed ? msg('No mistakes in this pass.') : msg('No wrong keys or timing marks in this pass.')}
        </p>
      ) : null}
      <PassFacts result={p.result} goal={p.goal} />
      {keeps.length ? (
        <section class={styles.group} data-group="keeps" aria-labelledby="result-keeps">
          <h3 id="result-keeps" class={styles.keepsHeading}>
            {msg('Keeps happening')}
          </h3>
          {keeps.map(excerpt)}
        </section>
      ) : null}
      {once.length ? (
        <section class={styles.group} data-group="once" aria-labelledby="result-once">
          <h3 id="result-once" class={styles.groupHeading}>
            {keeps.length ? msg('Also in this pass') : msg('In this pass')}
          </h3>
          {once.map(excerpt)}
        </section>
      ) : null}
      {more.length ? (
        <Button class={styles.more} onClick={() => setLimit((n) => n + MORE_STEP)}>
          {more.length === 1 ? msg('Show 1 more bar') : msg('Show {0} more bars', more.length)}
        </Button>
      ) : null}
      <div class={styles.folds}>
        {/* Only when scoring agrees: a group it counted early, late or missed is not "near the beat". */}
        {timing && !hasTimingCorrections && !timing.scoredOff ? (
          <details class={styles.fold} data-testid="timing-review-steady">
            <summary>{msg('Timing strip')}</summary>
            <p class={styles.muted}>{msg('All measured attacks were within {0} ms of the beat.', timing.nearBeat)}</p>
          </details>
        ) : null}
        <Earlier pieceId={p.pieceId} attemptId={p.result.id} {...(p.loadHistory ? { load: p.loadHistory } : {})} />
      </div>
    </div>
  )
}

/** Plays (or stops, when it is the one playing) a bar's snippet; resolves with why it did not play. */
type ListenToggle = (occ: number, kind: SnippetKind) => Promise<string | null>

const SNIPPET_LABEL: Readonly<Record<SnippetKind, string>> = {
  played: 'What you played',
  written: 'As written',
}

/**
 * "What you played" (the pass's own key presses in this bar, replayed) and "As written" (the bar
 * from the score at the pass's speed). The one sounding shows Stop; a short line says why one
 * cannot play, or that long pauses were shortened.
 */
function ListenControls({
  occ,
  bar,
  sounding,
  blockedPlayed,
  blockedWritten,
  onListen,
}: {
  occ: number
  bar: string
  /** This bar's snippet while it sounds, else null. */
  sounding: SnippetState | null
  blockedPlayed: string | null
  blockedWritten: string | null
  onListen: ListenToggle
}) {
  const [refused, setRefused] = useState<string | null>(null)
  const kinds: SnippetKind[] = ['played', 'written']
  const blocked = [blockedPlayed, blockedWritten]
  const on = sounding
  const note = on?.shortened ? msg('Long pauses are shortened.') : (refused ?? blocked[0] ?? blocked[1])
  return (
    <div class={styles.listen} data-testid="excerpt-listen">
      <div class={styles.listenButtons} role="group" aria-label={msg('Listen to bar {0}', bar)}>
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
                void onListen(occ, kind).then((why) => setRefused(why))
              }}
            >
              <Icon name={sounding ? 'stop' : 'play'} size={16} />
              <span>{msg(SNIPPET_LABEL[kind])}</span>
            </button>
          )
        })}
      </div>
      {note ? <p class={styles.listenNote}>{note}</p> : null}
    </div>
  )
}

interface ExcerptProps {
  plan: ExcerptPlan<RankedMistake>
  layout: PreparedLayout | null
  model: ScoreModel
  naming: NamingSettings
  measurer: NonNullable<Parameters<typeof excerptMarkup>[2]>['measurer']
  sounding: SnippetState | null
  blockedPlayed: string | null
  blockedWritten: string | null
  onListen: ListenToggle
  timing: TimingReviewData | null
  /** A long list (every off-beat bar, U108): the notation is mounted only while near the view. */
  virtual: boolean
  /** Starts without its notation (further down a long list) until it comes near the view. */
  deferMusic: boolean
}

/** Notation this far outside the scrolling list's view is mounted ahead (px above and below). */
const EXCERPT_AHEAD_PX = 240

/**
 * One bar of the score with its marks, and what went wrong there in words. Memoized: the session's
 * frequent updates re-render the card only when something it shows changed.
 */
const Excerpt = memo(function Excerpt({
  plan,
  layout,
  model,
  naming,
  measurer,
  sounding,
  blockedPlayed,
  blockedWritten,
  onListen,
  timing,
  virtual,
  deferMusic,
}: ExcerptProps) {
  const lead = plan.items[0]
  const timedBar = timing?.bars.get(plan.occ)
  const barLabel = lead?.bar ?? timedBar!.label
  const level = lead?.level ?? 'timing'
  const timingTitle = timedBar ? timingBarTitle(timedBar) : ''
  const figure = useRef<HTMLElement>(null)
  const observable = virtual && typeof IntersectionObserver !== 'undefined'
  const [showMusic, setShowMusic] = useState(() => !observable || !deferMusic)
  // The notation's height when it was last unmounted: the placeholder keeps it, so the list
  // (and its scroll position) does not move.
  const [musicHeight, setMusicHeight] = useState<number | null>(null)
  useEffect(() => {
    const el = figure.current
    if (!observable || !el) return
    const root = el.closest('[data-testid="result-details"]')
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (!entry) return
        if (!entry.isIntersecting) {
          const music = el.querySelector(`.${styles.music}`)
          const height = music?.getBoundingClientRect().height ?? 0
          if (height > 0) setMusicHeight(height)
        }
        setShowMusic(entry.isIntersecting)
      },
      { root, rootMargin: `${EXCERPT_AHEAD_PX}px 0px` },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [observable])
  const markup = useMemo(() => {
    if (!layout || !showMusic) return null
    const marks: CorrectionMark[] = plan.items
      .filter((m) => m.mark)
      .map((m) => ({ notes: m.notes, kind: m.mark!.kind as CorrectionMark['kind'], text: m.mark!.text }))
    const ghosts = plan.items.flatMap((m) =>
      m.presses.map((press) => pressGhost(press, m.notes, model)).filter((g): g is GhostNote => g !== null),
    )
    return excerptMarkup(layout, plan.occ, { marks, ghosts, ...(measurer ? { measurer } : {}) })
  }, [layout, plan, model, measurer, showMusic])
  const score = markup ? (
    <div
      class={styles.score}
      // Sanitized segment markup plus shapes built from numbers and escaped text (render/excerpt).
      dangerouslySetInnerHTML={{ __html: markup.svg }}
    />
  ) : null
  const lines = plan.items.flatMap((m) => itemLines(m, model, naming))
  const extra = lines.length - LINES_PER_PLACE
  return (
    <figure
      class={styles.excerpt}
      ref={figure}
      data-testid="result-excerpt"
      data-occ={plan.occ}
      data-level={level}
      aria-label={msg('Bar {0}', barLabel)}
    >
      <figcaption class={styles.caption}>
        <span class={styles.bar}>{msg('Bar {0}', barLabel)}</span>
        <span class={styles.reason} data-level={level}>
          {lead?.reason ?? timingTitle}
        </span>
      </figcaption>
      {showMusic && (markup || timedBar) ? (
        <div
          class={`${styles.music} pn-excerpt`}
          data-testid={markup ? 'excerpt-music' : undefined}
          style={{ '--excerpt-w': `${markup?.width ?? 240}px` }}
        >
          {timing && timedBar ? (
            <div class={styles.timedScore}>
              {score}
              <TimingBarPlot
                bar={timedBar}
                layout={layout}
                markup={markup}
                tolerance={timing.tolerance}
                nearBeat={timing.nearBeat}
              />
            </div>
          ) : (
            score
          )}
        </div>
      ) : !showMusic && (layout || timedBar) ? (
        <div
          class={styles.musicPlaceholder}
          data-testid="excerpt-placeholder"
          aria-hidden="true"
          style={musicHeight !== null ? { height: `${musicHeight}px` } : undefined}
        />
      ) : null}
      {lines.length ? (
        <ul class={styles.lines}>
          {lines.slice(0, extra > 0 ? LINES_PER_PLACE - 1 : LINES_PER_PLACE).map((line, i) => (
            <li key={i} data-repeat={line.flag ? '' : undefined}>
              {line.text}
              {line.flag ? <strong class={styles.flag}> ({line.flag})</strong> : null}
            </li>
          ))}
          {extra > 0 ? <li class={styles.muted}>{msg('and {0} more wrong keys here', extra + 1)}</li> : null}
        </ul>
      ) : null}
      {timing && timedBar ? (
        <p class={styles.timingDetail} data-testid="timing-review-summary">
          {lead && lead.level !== 'missed' ? `${timingTitle} · ` : null}
          {timingBarDetail(timedBar, timing.nearBeat)}
        </p>
      ) : null}
      <ListenControls
        occ={plan.occ}
        bar={barLabel}
        sounding={sounding}
        blockedPlayed={blockedPlayed}
        blockedWritten={blockedWritten}
        onListen={onListen}
      />
    </figure>
  )
})

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
  return [{ text: msg(words), flag: '' }]
}

/** "Clean pass: no wrong notes." or why not, in one plain sentence. */
export function verdict(r: AttemptSummary): string {
  if (r.passed) return msg('Clean pass: no wrong notes.')
  if (r.wrongAttacks === 1) return msg('Not clean: 1 wrong note.')
  if (r.wrongAttacks > 0) return msg('Not clean: {0} wrong notes.', r.wrongAttacks)
  if (r.timing && r.timing.onTime < r.timing.groups) return msg('Not clean: the timing slipped.')
  return msg('Completed, but not counted as clean.')
}

function PassFacts({ result, goal }: { result: AttemptSummary; goal: number | null }) {
  return (
    <section class={styles.group} aria-labelledby="result-facts">
      <h3 id="result-facts" class={styles.groupHeading}>
        {msg('This pass')}
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
 * here, with a way back to this pass; nothing opens another screen. Help is left out (U144).
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
  if (data === 'loading') return <p class={styles.muted}>{msg('Loading earlier passes…')}</p>
  if (data === 'error' || data === null || !model?.attempt || !model.scorecard)
    return <p class={styles.muted}>{msg('Earlier passes could not be loaded.')}</p>
  const attempt = model.attempt
  const isThis = attempt.id === attemptId
  const context = `${passageText(model.labeler, attempt.context, data.words)} · ${handsAndSpeed(attempt.context)}`
  return (
    <>
      <details ref={numbers} class={styles.fold} data-testid="result-numbers" open={!isThis || undefined}>
        <summary>{isThis ? msg('All the numbers for this pass') : msg('An earlier pass')}</summary>
        {!isThis ? (
          <Button class={styles.backToPass} icon="back" onClick={() => setSelected(attemptId)}>
            {msg('Back to this pass')}
          </Button>
        ) : null}
        <ScorecardPanel attempt={attempt} scorecard={model.scorecard} isLatest={isThis} assistance={false} />
      </details>
      {model.history && model.historyCount > 1 ? (
        <details class={styles.fold} data-testid="result-history">
          <summary>{msg('Earlier passes of this loop ({0})', model.historyCount - 1)}</summary>
          <HistoryPanel
            history={model.history}
            contextText={context}
            selectedId={attempt.id}
            onSelect={setSelected}
            assistance={false}
          />
        </details>
      ) : null}
    </>
  )
}
