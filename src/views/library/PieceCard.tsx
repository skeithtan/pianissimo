/**
 * One library entry: title, composer, last opened, last speed; Practice; and a disclosure with
 * the piece's Suggested practice and its management actions (review hands and tempo, replace
 * score, clear practice history, delete), each destructive one behind a confirmation.
 */
import { useState } from 'preact/hooks'
import { pushNotice } from '../../app/state'
import type { PieceRecord } from '../../core/storage/records'
import { formatBpm } from '../../ui/speed'
import { beatUnitName } from '../../core/music/tempo'
import { Button, Notice, Sheet } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { useLibraryDeps } from './deps'
import { FileButton, SCORE_ACCEPT } from './FileButton'
import { formatLastSpeed, formatRelativeTime } from './format'
import type { LibraryModel } from './libraryModel'
import { PieceSuggestions } from './PieceSuggestions'
import { ReviewSheet } from './ReviewSheet'
import styles from './library.module.css'

export function PieceCard({
  piece,
  model,
  expanded,
  onToggle,
  onReplace,
  index,
}: {
  piece: PieceRecord
  model: LibraryModel
  expanded: boolean
  onToggle: () => void
  onReplace: (piece: PieceRecord, file: File) => void
  index: number
}) {
  const deps = useLibraryDeps()
  const [confirm, setConfirm] = useState<'delete' | 'clear' | 'review' | null>(null)
  // Bumped after clearing the history so the suggestions reload.
  const [historyRev, setHistoryRev] = useState(0)
  const now = deps.now()
  const bodyId = `piece-${piece.id}-details`
  return (
    <li class={styles.card} style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}>
      <div class={styles.cardMain}>
        <div class={styles.cardText}>
          <h2 class={styles.cardTitle}>{piece.title}</h2>
          {piece.composer ? <p class={styles.composer}>{piece.composer}</p> : null}
          <ul class={styles.meta}>
            <li>
              <Icon name="restart" size={14} /> Opened {formatRelativeTime(piece.lastOpenedAt, now)}
            </li>
            <li>
              <Icon name="forward" size={14} /> {formatLastSpeed(piece.lastMultiplier)}
            </li>
            {piece.userTempo ? (
              <li>
                Your tempo: {beatUnitName(piece.userTempo.beatUnit)} = {formatBpm(piece.userTempo.beatBpm)}
              </li>
            ) : null}
          </ul>
        </div>
        <div class={styles.cardActions}>
          <Button
            variant="primary"
            icon="play"
            onClick={() => void model.open(piece.id)}
            aria-label={`Practice ${piece.title}`}
          >
            Practice
          </Button>
        </div>
      </div>
      <div class={styles.disclosure}>
        <button
          type="button"
          class={styles.disclosureButton}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span class={styles.chevron} aria-hidden="true">
            ›
          </span>
          Suggested practice and options
        </button>
        {expanded ? (
          <div class={styles.disclosureBody} id={bodyId}>
            <PieceSuggestions
              key={historyRev}
              pieceId={piece.id}
              deps={{ getStorage: deps.getStorage, beforePractice: (id) => model.markOpened(id) }}
            />
            <div class={styles.manage} aria-label={`Manage ${piece.title}`} role="group">
              <Button variant="ghost" icon="hand" onClick={() => setConfirm('review')}>
                Review hands and tempo…
              </Button>
              <FileButton
                icon="upload"
                variant="ghost"
                accept={deps.isAppleMobile() ? undefined : SCORE_ACCEPT}
                onFile={(file) => onReplace(piece, file)}
              >
                Replace score…
              </FileButton>
              <Button variant="ghost" icon="restart" onClick={() => setConfirm('clear')}>
                Clear practice history…
              </Button>
              <Button variant="ghost" icon="trash" onClick={() => setConfirm('delete')}>
                Delete…
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <ReviewSheet piece={piece} model={model} open={confirm === 'review'} onClose={() => setConfirm(null)} />
      <DeleteSheet piece={piece} model={model} open={confirm === 'delete'} onClose={() => setConfirm(null)} />
      <ClearSheet
        piece={piece}
        model={model}
        open={confirm === 'clear'}
        onClose={() => setConfirm(null)}
        onCleared={() => setHistoryRev((n) => n + 1)}
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
          undone; export a backup first if you might want it back.
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
