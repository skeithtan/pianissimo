/**
 * An ordinary library entry: the whole row opens Practice, with Sheet music, an Options menu and
 * useful suggestions as separate controls. Saved practice context can be featured for
 * continuing; every piece keeps the same management actions.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { pushNotice } from '../../app/state'
import type { PieceRecord } from '../../core/storage/records'
import type { ScoreModel } from '../../core/model/score'
import { Button, Notice, Sheet } from '../../ui/controls'
import { useLibraryDeps } from './deps'
import type { LibraryModel } from './libraryModel'
import { PieceSuggestions, SuggestionOptions } from './PieceSuggestions'
import { PieceSuggestionsModel } from './suggestionsData'
import { continuationContext, openedStatus } from './continuation'
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
 * Study, Add score, Settings). The click that ends the closing press is stopped in the capture
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

export function PieceCard({ piece, model, featured }: { piece: PieceRecord; model: LibraryModel; featured: boolean }) {
  const deps = useLibraryDeps()
  const [confirm, setConfirm] = useState<'rename' | 'delete' | 'clear' | 'review' | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const options = useRef<HTMLDivElement>(null)
  const [score, setScore] = useState<ScoreModel | null>(null)
  const suggestions = useMemo(
    () =>
      new PieceSuggestionsModel(
        { getStorage: deps.getStorage, beforePractice: (id) => model.markOpened(id) },
        piece.id,
      ),
    [piece.id, deps, model],
  )
  const previousSuggestions = useRef({ model: suggestions, piece })
  useEffect(() => {
    void suggestions.start()
    return () => suggestions.dispose()
  }, [suggestions])
  useEffect(() => {
    // Library refreshes records when Settings close (including after restoring a backup).
    // A new model already loads in start(); only an existing model needs this refresh.
    const previous = previousSuggestions.current
    previousSuggestions.current = { model: suggestions, piece }
    if (previous.model === suggestions && previous.piece !== piece) void suggestions.load()
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
  const show = (next: 'rename' | 'delete' | 'clear' | 'review') => {
    closeOptions()
    setConfirm(next)
  }
  const menuId = `piece-${piece.id}-options`
  // The whole row opens Practice: this one button's ::after covers the card (stretched target),
  // and every other control in the card sits above it (PieceCard.module.css).
  const practice = () => void model.open(piece.id)
  return (
    <li class={cardStyles.card} data-featured={featured ? '' : undefined}>
      <article aria-labelledby={`piece-${piece.id}-title`}>
        <div class={cardStyles.main}>
          <div class={cardStyles.text}>
            <h2 class={cardStyles.title} id={`piece-${piece.id}-title`}>
              {piece.title}
            </h2>
            {piece.composer ? <p class={cardStyles.composer}>{piece.composer}</p> : null}
            {featured ? (
              <p class={cardStyles.context}>{continuationContext(piece, score)}</p>
            ) : (
              <p class={cardStyles.status}>{openedStatus(piece, deps.now())}</p>
            )}
          </div>
          <div class={cardStyles.actions}>
            {featured ? (
              <Button
                variant="primary"
                icon="play"
                class={cardStyles.stretched}
                onClick={practice}
                aria-label={`Continue practice ${piece.title}`}
              >
                Continue practice
              </Button>
            ) : null}
            <Button
              variant="ghost"
              icon="music"
              class={cardStyles.above}
              onClick={() => void model.study(piece.id)}
              aria-label={`Open sheet music for ${piece.title}`}
            >
              Sheet music
            </Button>
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
                aria-label={`Options for ${piece.title}`}
                aria-expanded={optionsOpen}
                aria-controls={menuId}
                onClick={() => setOptionsOpen((open) => !open)}
              />
              {optionsOpen ? (
                <div class={cardStyles.menu} id={menuId} role="group" aria-label={`Manage ${piece.title}`}>
                  <Button variant="ghost" icon="pencil" onClick={() => show('rename')}>
                    Rename…
                  </Button>
                  <Button variant="ghost" icon="hand" onClick={() => show('review')}>
                    Review hands and tempo…
                  </Button>
                  <SuggestionOptions model={suggestions} onClose={closeOptions} />
                  <Button variant="ghost" icon="restart" onClick={() => show('clear')}>
                    Clear practice history…
                  </Button>
                  <Button variant="ghost" icon="trash" onClick={() => show('delete')}>
                    Delete…
                  </Button>
                </div>
              ) : null}
            </div>
            {featured ? null : (
              <Button
                variant="ghost"
                icon="forward"
                class={`${cardStyles.stretched} ${cardStyles.chevron}`}
                onClick={practice}
                aria-label={`Practice ${piece.title}`}
              />
            )}
          </div>
        </div>
        <PieceSuggestions model={suggestions} />
      </article>
      <RenameSheet piece={piece} model={model} open={confirm === 'rename'} onClose={() => setConfirm(null)} />
      <ReviewSheet piece={piece} model={model} open={confirm === 'review'} onClose={() => setConfirm(null)} />
      <DeleteSheet piece={piece} model={model} open={confirm === 'delete'} onClose={() => setConfirm(null)} />
      <ClearSheet
        piece={piece}
        model={model}
        open={confirm === 'clear'}
        onClose={() => setConfirm(null)}
        onCleared={() => void suggestions.load()}
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
      pushNotice({ kind: 'success', text: `Deleted “${piece.title}”.` })
      onClose()
    } catch (e) {
      setError(`It could not be deleted: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title="Delete this piece?" open={open} onClose={onClose}>
      <div class={styles.flow}>
        <p>
          “{piece.title}” will be removed from this device with its score, results and practice history. This cannot be
          undone. Export a backup first if you might want it back.
        </p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div class={styles.flowActions}>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" icon="trash" disabled={busy} onClick={() => void run()}>
            Delete piece
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
          ? `Cleared the practice history and results of “${piece.title}”.`
          : `Cleared the practice history of “${piece.title}”.`,
      })
      setAlsoResults(false)
      onCleared()
      onClose()
    } catch (e) {
      setError(`It could not be cleared: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title="Clear practice history?" open={open} onClose={onClose}>
      <div class={styles.flow}>
        <p>
          This forgets which bars of “{piece.title}” gave you trouble: bar histories, suggestions (including Improved)
          and restart records. The score itself stays.
        </p>
        <label class={styles.choice}>
          <input
            type="checkbox"
            checked={alsoResults}
            onChange={(e) => setAlsoResults((e.currentTarget as HTMLInputElement).checked)}
          />
          <span>
            <strong>Also delete results</strong>
            <small>Scorecards, best times and streaks for this piece.</small>
          </span>
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div class={styles.flowActions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => void run()}>
            {alsoResults ? 'Clear history and results' : 'Clear history'}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
