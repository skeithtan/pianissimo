import { msg, messageLanguage } from '../../i18n/messages'
/**
 * An ordinary library entry: the whole row opens Practice, with an Options menu as a separate
 * control. Saved practice context can be featured for continuing, with the piece's first suggestion
 * beside it; every piece keeps the same management actions.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { openPractice, openSettings } from '../../app/navigation'
import { pushNotice } from '../../app/state'
import type { Suggestion } from '../../core/history/selection'
import type { PieceRecord } from '../../core/storage/records'
import type { ScoreModel } from '../../core/model/score'
import { Button, Notice, Sheet } from '../../ui/controls'
import { notePaths, openingNotes, type Opening } from '../../ui/noteDrawing'
import { ProgressSheet } from '../progress/ProgressSheet'
import { RecordingsSheet } from '../recordings/RecordingsSheet'
import { PieceSuggestionsModel, practiceRequestFor } from '../shared/suggestions/pieceSuggestions'
import { useLibraryDeps } from './deps'
import type { LibraryModel } from './libraryModel'
import { continuationContext, openedStatus } from './continuation'
import type { Tile } from './openings'
import { RenameSheet } from './RenameSheet'
import { ReviewSheet } from './ReviewSheet'
import styles from './library.module.css'
import cardStyles from './PieceCard.module.css'

/** Every row's Options button (`data-piece-options`): a tap there is never swallowed (`swallowNextClick`). */
const OPTIONS_TOGGLE = 'data-piece-options'
/** How long a press that closed a menu may last before its click is no longer expected. */
const PRESS_LIMIT_MS = 1500
/** How long after the press ends its click may still arrive (a delayed touch click included). */
const CLICK_AFTER_UP_MS = 500

/**
 * A tap outside an open Options menu only closes it, as iPadOS menus do: the rows' stretched
 * targets cover nearly the whole list, so the dismissing tap must not also open a piece (or
 * Add score, Settings). The click that ends the closing press is stopped in the capture
 * phase, before any handler or default action. The mark ends with that click, the next
 * pointerdown, a pointercancel (the press became a scroll) or a short timeout, so it never eats
 * a later, unrelated click (a keyboard click has no pointerdown to clear it).
 */
function swallowNextClick(): void {
  let timer = 0
  const end = () => {
    clearTimeout(timer)
    document.removeEventListener('click', swallow, true)
    document.removeEventListener('pointerdown', end, true)
    document.removeEventListener('pointercancel', end, true)
    document.removeEventListener('pointerup', released, true)
  }
  const swallow = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    end()
  }
  const released = () => {
    clearTimeout(timer)
    timer = window.setTimeout(end, CLICK_AFTER_UP_MS)
  }
  // Added while this pointerdown is dispatched, so none of them sees it.
  document.addEventListener('click', swallow, true)
  document.addEventListener('pointerdown', end, true)
  document.addEventListener('pointercancel', end, true)
  document.addEventListener('pointerup', released, true)
  timer = window.setTimeout(end, PRESS_LIMIT_MS)
}

/** The sizes a row's drawing has (PieceCard.module.css; a narrower box cuts off its end), and how many
    notes read well in each. */
const DRAWINGS = {
  row: { width: 380, height: 46, thickness: 5, shortest: 4.6, notes: 64 },
  card: { width: 300, height: 46, thickness: 5, shortest: 4.6, notes: 64 },
  narrowRow: { width: 84, height: 28, thickness: 3.6, shortest: 3.2, notes: 26 },
  narrowCard: { width: 112, height: 28, thickness: 3.6, shortest: 3.2, notes: 26 },
} as const

/** The opening bars, drawn from their notes: a picture to know the piece by (U157). */
function OpeningDrawing({ opening, size }: { opening: Opening; size: keyof typeof DRAWINGS }) {
  const d = DRAWINGS[size]
  const paths = useMemo(() => notePaths(openingNotes(opening, d.notes), d), [opening, d])
  return (
    <svg
      class={cardStyles.drawing}
      viewBox={`0 0 ${d.width} ${d.height}`}
      preserveAspectRatio="xMinYMid slice"
      aria-hidden="true"
    >
      <path class={cardStyles.leftHand} d={paths.left} />
      <path class={cardStyles.rightHand} d={paths.right} />
    </svg>
  )
}

type PieceSheet = 'rename' | 'progress' | 'recordings' | 'delete' | 'clear' | 'review'

/** What to work on next, for the Continue card: the first suggestion's bars. */
function WorkOn({ suggestion: s, onPractice }: { suggestion: Suggestion; onPractice: () => void }) {
  const [first, last] = [s.bars[0], s.bars.at(-1)]
  if (!first || !last) return null
  return (
    <Button class={cardStyles.workOn} onClick={onPractice}>
      {first === last ? msg('Work on bar {0}', first.label) : msg('Work on bars {0}–{1}', first.label, last.label)}
    </Button>
  )
}

export function PieceCard({
  piece,
  model,
  featured,
  tile,
  opening,
  narrow = false,
  searching = false,
  hidden = false,
}: {
  piece: PieceRecord
  model: LibraryModel
  featured: boolean
  /** The row's quiet ground. */
  tile?: Tile | undefined
  /** What the row draws, once it is known. */
  opening?: Opening | undefined
  narrow?: boolean
  /** A search shows every piece as an ordinary row (L13). */
  searching?: boolean
  /** Not found: hidden rather than removed, so a search never loads a row's data again. */
  hidden?: boolean
}) {
  const card = featured && !searching
  const deps = useLibraryDeps()
  const [confirm, setConfirm] = useState<PieceSheet | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const options = useRef<HTMLDivElement>(null)
  const [score, setScore] = useState<ScoreModel | null>(null)
  // Only the Continue card shows a suggestion (a search keeps it read): the other rows read none.
  const suggestions = useMemo(
    () => (featured ? new PieceSuggestionsModel({ getStorage: deps.getStorage }, piece.id) : null),
    [featured, piece.id, deps, messageLanguage()],
  )
  const previousSuggestions = useRef({ model: suggestions, piece })
  useEffect(() => {
    void suggestions?.start()
    return () => suggestions?.dispose()
  }, [suggestions])
  useEffect(() => {
    // Library refreshes records when Settings close (including after restoring a backup).
    // A new model already loads in start(); only an existing model needs this refresh.
    const previous = previousSuggestions.current
    previousSuggestions.current = { model: suggestions, piece }
    if (previous.model === suggestions && previous.piece !== piece) void suggestions?.load()
  }, [piece, suggestions])
  useEffect(() => {
    if (!featured) return
    let active = true
    void deps
      .getStorage()
      .then((storage) => storage.getPackage(piece.scoreVersionId))
      .then((pkg) => {
        if (active) setScore(pkg?.model ?? null)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [featured, piece.scoreVersionId, deps])
  useEffect(() => {
    if (!optionsOpen) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || options.current?.contains(target)) return
      setOptionsOpen(false)
      // The tap only closes the menu, except on another row's Options button, which opens that
      // row's menu in the same tap.
      if (!(target instanceof Element && target.closest(`[${OPTIONS_TOGGLE}]`))) swallowNextClick()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOptionsOpen(false)
      options.current?.querySelector('button')?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [optionsOpen])
  const closeOptions = () => {
    options.current?.querySelector('button')?.focus()
    setOptionsOpen(false)
  }
  const show = (next: PieceSheet) => {
    closeOptions()
    setConfirm(next)
  }
  const menuId = `piece-${piece.id}-options`
  // The whole row opens Practice: this one button's ::after covers the card (stretched target),
  // and every other control in the card sits above it (PieceCard.module.css).
  const practice = () => void model.open(piece.id)
  const practiceSuggestion = async (s: Suggestion) => {
    await model.markOpened(piece.id)
    openPractice(practiceRequestFor(piece.id, s))
  }
  const suggested = suggestions?.state.value
  const next =
    suggested?.status === 'ready' && !suggested.globallyDisabled && !suggested.selection.disabled
      ? suggested.selection.active[0]
      : undefined
  return (
    <li class={cardStyles.card} data-featured={card ? '' : undefined} data-tile={tile} hidden={hidden}>
      <article aria-labelledby={`piece-${piece.id}-title`}>
        <div class={cardStyles.main}>
          <div class={cardStyles.text}>
            <h2 class={cardStyles.title} id={`piece-${piece.id}-title`}>
              {piece.title}
            </h2>
            {piece.composer ? <p class={cardStyles.composer}>{piece.composer}</p> : null}
            {card ? (
              <p class={cardStyles.context}>{continuationContext(piece, score)}</p>
            ) : (
              <p class={cardStyles.status}>{openedStatus(piece, deps.now())}</p>
            )}
          </div>
          {opening && opening.notes.length > 0 ? (
            <OpeningDrawing
              opening={opening}
              size={card ? (narrow ? 'narrowCard' : 'card') : narrow ? 'narrowRow' : 'row'}
            />
          ) : null}
          <div class={cardStyles.actions}>
            {card ? (
              <Button
                variant="primary"
                icon="play"
                class={cardStyles.stretched}
                onClick={practice}
                aria-label={msg('Continue practice {0}', piece.title)}
              >
                {msg('Continue practice')}
              </Button>
            ) : null}
            {card && next ? <WorkOn suggestion={next} onPractice={() => void practiceSuggestion(next)} /> : null}
            <div
              class={cardStyles.options}
              data-open={optionsOpen ? '' : undefined}
              ref={options}
              onFocusOut={(event) => {
                if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget))
                  setOptionsOpen(false)
              }}
            >
              <Button
                variant="ghost"
                icon="more"
                class={cardStyles.iconButton}
                data-piece-options=""
                aria-label={msg('Options for {0}', piece.title)}
                aria-expanded={optionsOpen}
                aria-controls={menuId}
                onClick={() => setOptionsOpen((open) => !open)}
              />
              {optionsOpen ? (
                <div class={cardStyles.menu} id={menuId} role="group" aria-label={msg('Manage {0}', piece.title)}>
                  <Button variant="ghost" icon="pencil" onClick={() => show('rename')}>
                    {msg('Rename…')}
                  </Button>
                  <Button variant="ghost" icon="chart" onClick={() => show('progress')}>
                    {msg('Progress…')}
                  </Button>
                  <Button variant="ghost" icon="recordings" onClick={() => show('recordings')}>
                    {msg('Recordings…')}
                  </Button>
                  <Button variant="ghost" icon="hand" onClick={() => show('review')}>
                    {msg('Review hands and tempo…')}
                  </Button>
                  <Button variant="ghost" icon="restart" onClick={() => show('clear')}>
                    {msg('Clear practice history…')}
                  </Button>
                  <Button variant="ghost" icon="trash" onClick={() => show('delete')}>
                    {msg('Delete…')}
                  </Button>
                </div>
              ) : null}
            </div>
            {card ? null : (
              <Button
                variant="ghost"
                icon="forward"
                class={`${cardStyles.stretched} ${cardStyles.chevron}`}
                onClick={practice}
                aria-label={msg('Practice {0}', piece.title)}
              />
            )}
          </div>
        </div>
      </article>
      <RenameSheet piece={piece} model={model} open={confirm === 'rename'} onClose={() => setConfirm(null)} />
      <ProgressSheet
        open={confirm === 'progress'}
        onClose={() => {
          setConfirm(null)
          // Not now, or the switch, may have changed the Continue card's suggestion.
          void suggestions?.load()
        }}
        pieceId={piece.id}
        storage={deps.getStorage}
        onPractice={(s) => void practiceSuggestion(s)}
        onOpenSettings={() => {
          setConfirm(null)
          openSettings()
        }}
      />
      <RecordingsSheet
        open={confirm === 'recordings'}
        onClose={() => setConfirm(null)}
        pieceId={piece.id}
        storage={deps.getStorage}
      />
      <ReviewSheet piece={piece} model={model} open={confirm === 'review'} onClose={() => setConfirm(null)} />
      <DeleteSheet piece={piece} model={model} open={confirm === 'delete'} onClose={() => setConfirm(null)} />
      <ClearSheet
        piece={piece}
        model={model}
        open={confirm === 'clear'}
        onClose={() => setConfirm(null)}
        onCleared={() => void suggestions?.load()}
      />
    </li>
  )
}

function DeleteSheet({
  piece,
  model,
  open,
  onClose,
}: {
  piece: PieceRecord
  model: LibraryModel
  open: boolean
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await model.remove(piece.id)
      pushNotice({ kind: 'success', text: msg('Deleted “{0}”.', piece.title) })
      onClose()
    } catch (e) {
      setError(msg('It could not be deleted: {0}', e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title={msg('Delete this piece?')} open={open} onClose={onClose}>
      <div class={styles.flow}>
        <p>
          {msg(
            '“{0}” will be removed from this device with its score, results and practice history. This cannot be undone. Export a backup first if you might want it back.',
            piece.title,
          )}
        </p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div class={styles.flowActions}>
          <Button onClick={onClose}>{msg('Keep it')}</Button>
          <Button variant="danger" icon="trash" disabled={busy} onClick={() => void run()}>
            {msg('Delete piece')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

function ClearSheet({
  piece,
  model,
  open,
  onClose,
  onCleared,
}: {
  piece: PieceRecord
  model: LibraryModel
  open: boolean
  onClose: () => void
  onCleared: () => void
}) {
  const [alsoResults, setAlsoResults] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await model.clearHistory(piece.id, alsoResults)
      pushNotice({
        kind: 'success',
        text: alsoResults
          ? msg('Cleared the practice history and results of “{0}”.', piece.title)
          : msg('Cleared the practice history of “{0}”.', piece.title),
      })
      setAlsoResults(false)
      onCleared()
      onClose()
    } catch (e) {
      setError(msg('It could not be cleared: {0}', e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title={msg('Clear practice history?')} open={open} onClose={onClose}>
      <div class={styles.flow}>
        <p>
          {msg(
            'This forgets which bars of “{0}” gave you trouble: bar histories, suggestions (including Improved) and restart records. The score itself stays.',
            piece.title,
          )}
        </p>
        <label class={styles.choice}>
          <input
            type="checkbox"
            checked={alsoResults}
            onChange={(e) => setAlsoResults((e.currentTarget as HTMLInputElement).checked)}
          />
          <span>
            <strong>{msg('Also delete results')}</strong>
            <small>{msg('Scorecards, best times and streaks for this piece.')}</small>
          </span>
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div class={styles.flowActions}>
          <Button onClick={onClose}>{msg('Cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void run()}>
            {alsoResults ? msg('Clear history and results') : msg('Clear history')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
