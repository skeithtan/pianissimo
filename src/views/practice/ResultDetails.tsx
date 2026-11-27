import { msg, messageLanguage } from '../../i18n/messages'
/**
 * The expanded result card (DECISIONS U99), loaded on its first expansion
 * (`ResultDetailsLoader`). The music is the point: the pass's mistakes ranked by severity
 * (`rankMistakes`), each place shown as a small excerpt of the score (`render/excerpt`) with the
 * teacher's ring and a ghost note for each key pressed that is not written there, and a plain
 * sentence per wrong key ("You pressed D♭ where D♮ is written"). The same wrong key pass after
 * pass leads the excerpts, under "Keeps happening". Under the verdict come the actions, then the
 * first thing the pill peeks at: the mistakes, or the pass facts when it was clean or has none (U142).
 * Timing evidence and playback sit with each bar's other corrections. The facts, numbers and earlier
 * passes sit below the corrections (a Wait run has none: it is not stored, U142). Nothing here
 * navigates: a history row shows that pass's numbers in the card; an excerpt is only a picture.
 */
import type { ComponentChildren } from 'preact'
import { memo } from 'preact/compat'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { AttemptSummary, SnippetState } from '../../app/session'
import type { SnippetKind } from '../../app/session/snippets'
import {
  passesText,
  patternLines,
  pressGhost,
  rankMistakes,
  wrongPressLine,
  type RankedMistake,
} from '../../app/session/ranking'
import { mistakePatterns } from '../../app/session/patterns'
import { getStorage } from '../../app/services'
import { barLabel as scoreBarLabel } from '../../core/engine'
import type { Hand, ScoreModel } from '../../core/model/score'
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
import { cleanText, passFacts, verdict } from './format'
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
/** Maximum bar labels listed in "Fixed this pass" before summarizing the rest. */
const FIXED_BAR_LIMIT = 6

const KEEPS: ReadonlySet<RankedMistake['level']> = new Set(['repeated', 'habit', 'trouble', 'hesitation'])

const keepsHappening = (plan: ExcerptPlan<RankedMistake>) => KEEPS.has(plan.items[0]?.level ?? 'timing')

/** The bars to show: the ranked mistakes', then Keep time's other affected bars (U108). */
function planBars(mistakes: readonly RankedMistake[], timing: TimingReviewData | null, limit: number) {
  const plans = planExcerpts(mistakes, timing?.bars.size ? Infinity : limit)
  if (timing?.bars.size) {
    const rankedBars = new Set(plans.shown.map((plan) => plan.occ))
    for (const occ of timing.bars.keys()) {
      if (!rankedBars.has(occ)) plans.shown.push({ occ, items: [] })
    }
  }
  return plans
}

/** One bar's music with its rings and ghost notes, cut from the prepared layout. */
function drawBar(
  plan: ExcerptPlan<RankedMistake>,
  layout: PreparedLayout,
  model: ScoreModel,
  measurer: ExcerptProps['measurer'],
) {
  const marks: CorrectionMark[] = plan.items
    .filter((m) => m.mark)
    .map((m) => ({
      notes: m.notes,
      kind: m.mark!.kind as CorrectionMark['kind'],
      text: m.mark!.text,
      ...(m.mark!.repeat !== undefined ? { repeat: m.mark!.repeat } : {}),
    }))
  const ghosts = plan.items.flatMap((m) =>
    m.presses.map((press) => pressGhost(press, m.notes, model)).filter((g): g is GhostNote => g !== null),
  )
  return excerptMarkup(layout, plan.occ, { marks, ghosts, ...(measurer ? { measurer } : {}) })
}

const cardMeasurer = () =>
  typeof document === 'undefined' ? estimateMeasurer : (canvasMeasurer(document) ?? estimateMeasurer)

/** The card's first excerpt, for the pill's peek (U142): its caption, and the top of its music. */
export interface PeekDrawing {
  readonly bar: string
  readonly level: RankedMistake['level']
  readonly reason: string
  readonly keeps: boolean
  readonly svg: string
  readonly width: number
  /** What the peek leaves out above the staff (its words and leaders), so that the music is what shows. */
  readonly skip: number
}

/** Layout px the peek keeps above the top staff. */
const PEEK_ABOVE = 4

/** Draws it, outside the input path (`ResultPeek` picks a quiet moment); null when there is none. */
export function drawPeek(p: ResultDetailsProps): PeekDrawing | null {
  const details = p.session.resultDetails()
  if (details?.attemptId !== p.result.id || !p.layout) return null
  const mistakes = (p.rank ?? rankMistakes)(
    details.records.at(-1),
    details.timeline,
    p.model,
    details.marks,
    details.spots,
  )
  const { shown } = planBars(mistakes, null, EXCERPT_LIMIT)
  const plan = shown.find(keepsHappening) ?? shown[0]
  const lead = plan?.items[0]
  if (!plan || !lead) return null
  const markup = drawBar(plan, p.layout, p.model, cardMeasurer())
  if (!markup) return null
  return {
    bar: lead.bar,
    level: lead.level,
    reason: lead.reason,
    keeps: keepsHappening(plan),
    svg: markup.svg,
    width: markup.width,
    skip: Math.max(0, markup.staffTop - PEEK_ABOVE),
  }
}

export function PeekExcerpt({ drawing }: { drawing: PeekDrawing }) {
  return (
    <div class={styles.peek}>
      <Caption bar={drawing.bar} level={drawing.level} reason={drawing.reason} />
      <div
        class={`${styles.music} pn-excerpt`}
        style={{ '--excerpt-w': `${drawing.width}px`, '--peek-skip': `${(drawing.skip / drawing.width) * 100}%` }}
      >
        {/* Sanitized segment markup plus shapes built from numbers and escaped text (render/excerpt). */}
        <div class={styles.score} dangerouslySetInnerHTML={{ __html: drawing.svg }} />
      </div>
    </div>
  )
}

function Caption({
  bar,
  level,
  reason,
  children,
}: {
  bar: string
  level: RankedMistake['level']
  reason: string
  children?: ComponentChildren
}) {
  return (
    <div class={styles.caption}>
      <span class={styles.bar}>{msg('Bar {0}', bar)}</span>
      <span class={styles.reason} data-level={level}>
        {reason}
      </span>
      {children}
    </div>
  )
}

export function ResultDetails(p: ResultDetailsProps) {
  // Ranked once per result, on this render after the tap, never in the input path.
  const details = useMemo(() => {
    const current = p.session.resultDetails()
    return current?.attemptId === p.result.id ? current : null
  }, [p.session, p.result.id])
  const mistakes = useMemo(
    () =>
      details
        ? (p.rank ?? rankMistakes)(details.records.at(-1), details.timeline, p.model, details.marks, details.spots)
        : [],
    [details, p.model, p.rank, messageLanguage()],
  )
  const timing = useMemo(
    () => (details && p.result.timing ? buildTimingReview(details) : null),
    [details, p.result.timing],
  )
  const [limit, setLimit] = useState(EXCERPT_LIMIT)
  const hasTimingCorrections = !!timing?.bars.size
  const { shown, more } = useMemo(() => planBars(mistakes, timing, limit), [mistakes, timing, limit])
  const clean = shown.length === 0 && (p.result.passed || details) ? cleanText(p.result) : null
  const keeps = shown.filter(keepsHappening)
  const once = shown.filter((plan) => !keepsHappening(plan))
  const measurer = useMemo(cardMeasurer, [])
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
  const drill = useMemo(
    () => (group: number) => {
      const { session: s, id } = latest.current
      s.drillSpot(id, group)
    },
    [],
  )
  const drillGroup = (plan: ExcerptPlan<RankedMistake>): number | null => {
    const group = plan.items[0]?.group
    return group !== undefined && session.canDrill(p.result.id, group) ? group : null
  }
  const patterns = useMemo(() => {
    const record = details?.records.at(-1)
    if (!details || !record) return []
    return patternLines(mistakePatterns(record, details.timeline, p.model), p.naming)
  }, [details, p.model, p.naming, messageLanguage()])
  const fixedLine = useMemo(() => {
    if (!details || details.fixed.length === 0) return null
    const bars: string[] = []
    const seen = new Set<string>()
    for (const g of details.fixed) {
      const group = details.timeline.groups[g]
      if (!group) continue
      const label = scoreBarLabel(p.model, group.occ)
      if (seen.has(label)) continue
      seen.add(label)
      bars.push(label)
    }
    if (bars.length === 0) return null
    const shownBars = bars
      .slice(0, FIXED_BAR_LIMIT)
      .map((b) => msg('bar {0}', b))
      .join(', ')
    const rest = bars.length - FIXED_BAR_LIMIT
    return rest > 0
      ? msg('Fixed this pass: {0}, and {1} more', shownBars, rest)
      : msg('Fixed this pass: {0}', shownBars)
  }, [details, p.model, messageLanguage()])
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
      drillGroup={drillGroup(plan)}
      onDrill={drill}
      timing={timing}
      // Every affected bar stays in the list (U108); its notation is mounted only near the view.
      virtual={hasTimingCorrections}
      deferMusic={hasTimingCorrections && index >= EXCERPT_LIMIT}
    />
  )
  const facts = <PassFacts result={p.result} goal={p.goal} />
  // A clean pass leads with its facts, whatever marks it has; any other with what to correct.
  const factsFirst = p.result.passed
  return (
    <div class={styles.details}>
      <p class={styles.verdict} data-testid="result-verdict">
        {verdict(p.result)}
      </p>
      {p.actions}
      {patterns.length > 0 ? (
        <p class={styles.patterns} data-testid="result-patterns">
          {patterns.join(' ')}
        </p>
      ) : null}
      {fixedLine ? (
        <p class={styles.fixed} data-testid="result-fixed">
          {fixedLine}
        </p>
      ) : null}
      {clean ? (
        <p class={styles.clean} data-testid="result-clean">
          {clean}
        </p>
      ) : null}
      {factsFirst ? facts : null}
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
          {/* Alone, the list says what it is: the heading is for assistive technology. */}
          <h3 id="result-once" class={keeps.length ? styles.groupHeading : 'visually-hidden'}>
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
      {factsFirst ? null : facts}
      {p.result.run ? null : (
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
      )}
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
  onDrill,
}: {
  occ: number
  bar: string
  /** This bar's snippet while it sounds, else null. */
  sounding: SnippetState | null
  blockedPlayed: string | null
  blockedWritten: string | null
  onListen: ListenToggle
  /** Drill this spot (U168), when it can be drilled. */
  onDrill: (() => void) | undefined
}) {
  const [refused, setRefused] = useState<string | null>(null)
  const kinds: SnippetKind[] = ['played', 'written']
  const blocked = [blockedPlayed, blockedWritten]
  const on = sounding
  const note = on?.shortened ? msg('Long pauses are shortened.') : (refused ?? blocked[0] ?? blocked[1])
  return (
    <div class={styles.listen} data-testid="excerpt-listen">
      <div class={styles.excerptActions}>
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
        {onDrill ? (
          <button
            type="button"
            class={`${styles.listenButton} ${styles.drillButton}`}
            data-testid="drill-spot"
            onClick={onDrill}
          >
            <Icon name="repeat" size={16} />
            <span>{msg('Drill this spot')}</span>
          </button>
        ) : null}
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
  /** The group "Drill this spot" drills, or null when this bar cannot be drilled. */
  drillGroup: number | null
  onDrill: (group: number) => void
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
  drillGroup,
  onDrill,
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
    return layout && showMusic ? drawBar(plan, layout, model, measurer) : null
  }, [layout, plan, model, measurer, showMusic])
  const score = markup ? (
    <div
      class={styles.score}
      // Sanitized segment markup plus shapes built from numbers and escaped text (render/excerpt).
      dangerouslySetInnerHTML={{ __html: markup.svg }}
    />
  ) : null
  const pressLines = plan.items.flatMap((m) =>
    m.presses.map((press) => ({ text: wrongPressLine(press, model, naming), flag: passesText(press.passes) })),
  )
  const extra = pressLines.length - LINES_PER_PLACE
  // Past the limit: the first wrong keys, the count of the rest, then each place's other lines.
  const lines =
    extra > 0 ? pressLines.slice(0, LINES_PER_PLACE - 1) : plan.items.flatMap((m) => itemLines(m, model, naming))
  const trailing = extra > 0 ? plan.items.flatMap((m) => extraItemLines(m)) : []
  const histories = plan.items.filter((m) => m.history.length >= 2)
  return (
    <figure
      class={styles.excerpt}
      ref={figure}
      data-testid="result-excerpt"
      data-occ={plan.occ}
      data-level={level}
      aria-label={msg('Bar {0}', barLabel)}
    >
      <figcaption>
        <Caption bar={barLabel} level={level} reason={lead?.reason ?? timingTitle}>
          {histories.map((m) => (
            <PlaceHistory key={m.group} history={m.history} />
          ))}
        </Caption>
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
      {lines.length || trailing.length ? (
        <ul class={styles.lines}>
          {lines.map((line, i) => (
            <li key={i} data-repeat={line.flag ? '' : undefined}>
              {line.text}
              {line.flag ? <strong class={styles.flag}> ({line.flag})</strong> : null}
            </li>
          ))}
          {extra > 0 ? <li class={styles.muted}>{msg('and {0} more wrong keys here', extra + 1)}</li> : null}
          {trailing.map((line, i) => (
            <li key={`t-${i}`}>{line.text}</li>
          ))}
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
        onDrill={drillGroup !== null ? () => onDrill(drillGroup) : undefined}
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

/** Dots for the place's recent passes, oldest first: wrong or clean. */
function PlaceHistory({ history }: { history: readonly ('wrong' | 'clean')[] }) {
  const words = history.map((v) => (v === 'wrong' ? msg('wrong') : msg('clean'))).join(', ')
  return (
    <span
      class={styles.historyDots}
      role="img"
      data-testid="place-history"
      aria-label={msg('Last {0} passes here: {1}', history.length, words)}
    >
      {history.map((v, i) => (
        <span key={i} class={v === 'wrong' ? styles.dotWrong : styles.dotClean} data-visit={v} aria-hidden="true" />
      ))}
    </span>
  )
}

function markDetailLine(kind: string, fallback: string, lateHand?: Hand | null): string {
  if (kind === 'spread') {
    if (lateHand === 'L') return msg('Not together: the left hand came after the right.')
    if (lateHand === 'R') return msg('Not together: the right hand came after the left.')
    return msg('Not together: the chord was spread out')
  }
  const words = MARK_WORDS[kind]
  return words ? msg(words) : fallback
}

/** A place's lines besides its wrong keys: its mark without one, hunting, and its other problems. */
function extraItemLines(m: RankedMistake): { text: string; flag: string }[] {
  const out: { text: string; flag: string }[] = []
  if (m.presses.length === 0) {
    out.push({ text: markDetailLine(m.mark?.kind ?? '', m.mark?.text ?? m.reason, m.lateHand), flag: '' })
  }
  if (m.hunting) {
    out.push({ text: msg('You tried several keys here: read the note first, then play.'), flag: '' })
  }
  for (const more of m.also ?? []) {
    out.push({ text: markDetailLine(more.kind, more.text, m.lateHand), flag: '' })
  }
  return out
}

function itemLines(m: RankedMistake, model: ScoreModel, naming: NamingSettings): { text: string; flag: string }[] {
  return [
    ...m.presses.map((press) => ({ text: wrongPressLine(press, model, naming), flag: passesText(press.passes) })),
    ...extraItemLines(m),
  ]
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
 * Folded: all the numbers of this pass (the scorecard) and the earlier passes of this
 * loop (the history of its comparison context). A history row shows that pass's numbers
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
        <ScorecardPanel attempt={attempt} scorecard={model.scorecard} isLatest={isThis} />
      </details>
      {model.history && model.historyCount > 1 ? (
        <details class={styles.fold} data-testid="result-history">
          <summary>{msg('Earlier passes of this loop ({0})', model.historyCount - 1)}</summary>
          <HistoryPanel history={model.history} contextText={context} selectedId={attempt.id} onSelect={setSelected} />
        </details>
      ) : null}
    </>
  )
}
