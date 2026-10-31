/**
 * "Review hands and tempo" for a stored piece (DECISIONS L5): the import summary again, with the
 * hand of every voice editable and, when the user entered the tempo at import, that practice
 * tempo. Same gate as at import (L1); saving keeps the score version, so resume, passages and
 * results stay, while the new assignment or tempo starts a separate practice history.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { pushNotice } from '../../app/state'
import type { PieceRecord } from '../../core/storage/records'
import { Button, Notice, Sheet } from '../../ui/controls'
import { ImportSummaryView } from './ImportSummary'
import type { LibraryModel, StoredReview } from './libraryModel'
import { finalizeStoredReview, reviewGate, storedDraft, storedReviewChanges, type ReviewDraft } from './review'
import styles from './library.module.css'

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly review: StoredReview }
  | { readonly kind: 'failed'; readonly message: string }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ReviewSheet({
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
  return (
    <Sheet title={`Hands and tempo of “${piece.title}”`} open={open} onClose={onClose} wide>
      {/* The sheet mounts its body only while shown (and fading out), so the package loads on open. */}
      <ReviewBody piece={piece} model={model} onClose={onClose} />
    </Sheet>
  )
}

function ReviewBody({ piece, model, onClose }: { piece: PieceRecord; model: LibraryModel; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    model.loadReview(piece).then(
      (review) => live && setLoad({ kind: 'ready', review }),
      (error: unknown) => live && setLoad({ kind: 'failed', message: message(error) }),
    )
    return () => {
      live = false
    }
  }, [model, piece.id, piece.scoreVersionId])

  if (load.kind === 'loading') {
    return (
      <div class={styles.flow} aria-busy="true">
        <p class={styles.stage} role="status">
          Opening the score…
        </p>
      </div>
    )
  }
  if (load.kind === 'failed') {
    return (
      <div class={styles.flow}>
        <Notice tone="danger">{load.message}</Notice>
        <div class={styles.flowActions}>
          <span />
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    )
  }
  return <ReviewForm piece={piece} model={model} review={load.review} onClose={onClose} />
}

function ReviewForm({
  piece,
  model,
  review,
  onClose,
}: {
  piece: PieceRecord
  model: LibraryModel
  review: StoredReview
  onClose: () => void
}) {
  const { pkg, summary } = review
  const tempoEntry = piece.userTempo !== undefined
  const [draft, setDraft] = useState<ReviewDraft>(() => storedDraft(summary, pkg.model, piece.userTempo))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gate = useMemo(() => reviewGate(summary, draft, true, tempoEntry), [summary, draft, tempoEntry])
  const changes = useMemo(() => storedReviewChanges(summary, draft, piece.userTempo), [summary, draft, piece.userTempo])
  const changed = changes.hands || changes.tempo

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const fin = finalizeStoredReview(pkg.model, summary, draft, piece.userTempo)
      await model.saveReview(piece, pkg, fin)
      const what =
        changes.hands && changes.tempo ? 'hands and practice tempo' : changes.hands ? 'hands' : 'practice tempo'
      pushNotice({ kind: 'success', text: `Saved the ${what} of “${piece.title}”.` })
      onClose()
    } catch (e) {
      setError(`The changes could not be saved: ${message(e)} Your piece is unchanged.`)
      setSaving(false)
    }
  }

  return (
    <div class={styles.flow}>
      <Notice tone="info">
        Changing which hand plays a voice{tempoEntry ? ', or your practice tempo,' : ''} starts a separate practice
        history and separate results for the new setting. Earlier results stay as they are and are never mixed with the
        new ones; your resume position is kept.
      </Notice>
      <ImportSummaryView
        summary={summary}
        draft={draft}
        gate={gate}
        onDraft={setDraft}
        tempoEntry={tempoEntry}
        editHands
      />
      <div class={styles.footer}>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {!gate.canSave ? (
          <div role="status">
            <strong>Before saving:</strong>
            <ul class={styles.blockers}>
              {gate.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div class={styles.flowActions}>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="check"
            disabled={!gate.canSave || !changed || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
