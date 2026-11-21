import { useRecordingDialog } from '../recordings/useRecordingDialog'
import { msg } from '../../i18n/messages'
/**
 * Library and Import (spec "Main user journey" 1–2, "MusicXML score import", "Storage and
 * recovery", "Suggested practice" in the Library). The first screen, bundled with the shell:
 * it imports neither the notation engine nor the piano samples (spec "Deferred assets"); the
 * importer runs in its worker. Backup and restore live in Settings (`views/settings/BackupSection`).
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { openPractice, settingsOpen } from '../../app/navigation'
import { pushNotice } from '../../app/state'
import { Button, Notice } from '../../ui/controls'
import { LibraryDepsContext, defaultLibraryDeps, useLibraryDeps, type LibraryDeps } from './deps'
import { FileButton, SCORE_ACCEPT } from './FileButton'
import { ImportFlow } from './importFlow'
import { ImportSheet } from './ImportSheet'
import { LibraryModel } from './libraryModel'
import { PieceCard } from './PieceCard'
import { continuingPiece } from './continuation'
import styles from './LibraryPage.module.css'

/** The registered view (no props). */
export function LibraryView() {
  return <Library />
}

/** The Library with injectable dependencies (tests). */
export function Library({ deps = defaultLibraryDeps }: { deps?: LibraryDeps }) {
  return (
    <LibraryDepsContext.Provider value={deps}>
      <LibraryPage />
    </LibraryDepsContext.Provider>
  )
}

function LibraryPage() {
  const deps = useLibraryDeps()
  const model = useMemo(() => new LibraryModel(deps), [deps])
  const [flow, setFlow] = useState<ImportFlow | null>(null)

  // A restore in Settings (Backup) can add pieces: the list refreshes whenever Settings close.
  const settingsShown = settingsOpen.value
  useEffect(() => {
    if (settingsShown) return
    void model.refresh()
  }, [model, settingsShown])

  // Release the import worker if the view goes away mid-import.
  useEffect(() => () => flow?.close(), [flow])

  const recorder = useRecordingDialog()
  const state = model.state.value
  const pieces = state.status === 'ready' ? state.pieces : []
  const continuing = continuingPiece(pieces)
  const ordered = continuing ? [continuing, ...pieces.filter((piece) => piece.id !== continuing.id)] : pieces

  const startImport = (file: File) => {
    flow?.close()
    const next = new ImportFlow(deps, (piece) => {
      pushNotice({ kind: 'success', text: msg('“{0}” is in your library.', piece.title) })
      // Add and open opens the piece: its row says "Opened", like every other way of opening it.
      void model.markOpened(piece.id, piece.createdAt + 1).then(() => {
        void model.refresh()
        openPractice({ pieceId: piece.id })
      })
    })
    setFlow(next)
    void next.openFile(file)
  }

  const closeFlow = () => {
    setFlow((current) => {
      current?.close()
      return null
    })
  }

  const accept = deps.isAppleMobile() ? undefined : SCORE_ACCEPT
  const unavailable = state.status === 'unavailable'

  return (
    <div class={styles.page}>
      <header class={styles.header}>
        <h1>{msg('Library')}</h1>
        <div class={styles.libraryActions}>
          <Button onClick={() => void recorder.open(deps.getStorage)}>{msg('Recordings')}</Button>
          {pieces.length > 0 ? (
            <FileButton
              variant="secondary"
              icon="plus"
              accept={accept}
              disabled={unavailable}
              onFile={(f) => startImport(f)}
            >
              {msg('Add score')}
            </FileButton>
          ) : null}
        </div>
      </header>

      {state.status === 'loading' ? <p class={styles.loading}>{msg('Opening your library…')}</p> : null}
      {state.status === 'unavailable' ? <Notice tone="warning">{msg(state.message)}</Notice> : null}

      {state.status !== 'loading' && pieces.length === 0 ? (
        <EmptyState accept={accept} disabled={unavailable} onFile={(f) => startImport(f)} />
      ) : null}

      {pieces.length > 0 ? (
        <ul class={styles.list} aria-label={msg('Pieces')}>
          {ordered.map((piece) => (
            <PieceCard key={piece.id} piece={piece} model={model} featured={continuing?.id === piece.id} />
          ))}
        </ul>
      ) : null}

      {recorder.dialog}
      <ImportSheet
        flow={flow}
        pieces={pieces}
        onClose={closeFlow}
        onOpenExisting={(pieceId) => {
          void model.open(pieceId)
        }}
      />
    </div>
  )
}

function EmptyState({
  accept,
  disabled,
  onFile,
}: {
  accept: string | undefined
  disabled: boolean
  onFile: (file: File) => void
}) {
  return (
    <section class={styles.empty} aria-labelledby="library-empty">
      <h2 id="library-empty">{msg('Your library is empty')}</h2>
      <div>
        <FileButton variant="primary" icon="plus" accept={accept} disabled={disabled} onFile={onFile}>
          {msg('Add score')}
        </FileButton>
      </div>
      <p>{msg('Choose a MusicXML file: .musicxml, .mxl, or .xml.')}</p>
      <details class={styles.help}>
        <summary>{msg('Help adding a score')}</summary>
        <p>{msg('Most notation programs export MusicXML from File → Export. A PDF or photo cannot be imported.')}</p>
        <p>{msg('Moving from another device? Restore a backup from Settings → Backup.')}</p>
      </details>
    </section>
  )
}
