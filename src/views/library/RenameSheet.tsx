/**
 * "Rename piece": the title and composer of a library entry (the piece record). The score
 * package and its source file keep the score's own metadata. Every screen reads the name from
 * the piece record, so the row (and Practice, Study and Results) follow once the Library has
 * refreshed; the updated row is the feedback, so there is no success notice.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { PieceRecord } from '../../core/storage/records'
import { Button, Field, Notice, Sheet } from '../../ui/controls'
import { COMPOSER_MAX_LENGTH, normalizePieceName, TITLE_MAX_LENGTH, type LibraryModel } from './libraryModel'
import styles from './library.module.css'

export function RenameSheet({
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
    <Sheet title="Rename piece" open={open} onClose={onClose}>
      {/* The sheet mounts its body only while shown, so the fields start from the piece on every open. */}
      <RenameForm piece={piece} model={model} onClose={onClose} />
    </Sheet>
  )
}

function RenameForm({ piece, model, onClose }: { piece: PieceRecord; model: LibraryModel; onClose: () => void }) {
  const [title, setTitle] = useState(piece.title)
  const [composer, setComposer] = useState(piece.composer ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // The sheet opens its dialog right after this first render (showModal focuses the autofocus
    // title). Then select the title so typing replaces it: a selection made inside the focus
    // event does not stick in WebKit, which places the caret after dispatching it.
    const timer = setTimeout(() => {
      const input = titleInput.current
      if (!input?.closest('dialog')?.open) return
      input.focus()
      input.select()
    }, 0)
    return () => clearTimeout(timer)
  }, [])
  const next = normalizePieceName({ title, composer })
  const current = normalizePieceName({ title: piece.title, composer: piece.composer ?? '' })
  const changed = next.title !== current.title || next.composer !== current.composer
  const canSave = !busy && next.title !== '' && changed

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await model.rename(piece.id, { title, composer })
      onClose()
    } catch (e) {
      setError(`It could not be renamed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      class={styles.flow}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <Field label="Title">
        <input
          ref={titleInput}
          type="text"
          value={title}
          required
          maxLength={TITLE_MAX_LENGTH}
          autoComplete="off"
          autoFocus
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </Field>
      <Field label="Composer" hint="Optional">
        <input
          type="text"
          value={composer}
          maxLength={COMPOSER_MAX_LENGTH}
          autoComplete="off"
          onInput={(e) => setComposer(e.currentTarget.value)}
        />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div class={styles.flowActions}>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" icon="check" disabled={!canSave}>
          Save
        </Button>
      </div>
    </form>
  )
}
