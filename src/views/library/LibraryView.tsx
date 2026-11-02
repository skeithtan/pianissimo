/**
 * Library and Import (spec "Main user journey" 1–2, "MusicXML score import", "Storage and
 * recovery", "Suggested practice" in the Library). The first screen, bundled with the shell:
 * it imports neither the notation engine nor the piano samples (spec "Deferred assets"); the
 * importer runs in its worker. Backup and restore live in Settings (`views/settings/BackupSection`).
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { openPractice, settingsOpen } from '../../app/navigation'
import { pushNotice } from '../../app/state'
import { Notice } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { LibraryDepsContext, defaultLibraryDeps, useLibraryDeps, type LibraryDeps } from './deps'
import { FileButton, SCORE_ACCEPT } from './FileButton'
import { plural } from './format'
import { ImportFlow } from './importFlow'
import { ImportSheet } from './ImportSheet'
import { LibraryModel } from './libraryModel'
import { PieceCard } from './PieceCard'
import styles from './library.module.css'

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
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined)

  // A restore in Settings (Backup) can add pieces: the list refreshes whenever Settings close.
  const settingsShown = settingsOpen.value
  useEffect(() => {
    if (settingsShown) return
    void model.refresh()
  }, [model, settingsShown])

  // Release the import worker if the view goes away mid-import.
  useEffect(() => () => flow?.close(), [flow])

  const state = model.state.value
  const pieces = state.status === 'ready' ? state.pieces : []
  // The most recently opened piece starts expanded, so its suggestions are in view.
  const open = expanded === undefined ? (pieces[0]?.id ?? null) : expanded

  const startImport = (file: File) => {
    flow?.close()
    const next = new ImportFlow(deps, (piece) => {
      void model.refresh()
      pushNotice({ kind: 'success', text: `“${piece.title}” is in your library.` })
      openPractice({ pieceId: piece.id, autoStart: true })
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
      <header class={styles.hero}>
        <div>
          <h1>Library</h1>
          <p class={styles.lede}>
            {state.status === 'ready' && pieces.length > 0
              ? `${plural(pieces.length, 'piece')}.`
              : 'Import a MusicXML score, confirm its hands and tempo, and start reading.'}
          </p>
        </div>
        {pieces.length > 0 ? (
          <div class={styles.heroActions}>
            <FileButton
              variant="primary"
              icon="upload"
              accept={accept}
              disabled={unavailable}
              onFile={(f) => startImport(f)}
            >
              Import MusicXML
            </FileButton>
          </div>
        ) : null}
      </header>

      {state.status === 'loading' ? <p class={styles.loading}>Opening your library…</p> : null}
      {state.status === 'unavailable' ? <Notice tone="warning">{state.message}</Notice> : null}

      {state.status !== 'loading' && pieces.length === 0 ? (
        <EmptyState accept={accept} disabled={unavailable} onFile={(f) => startImport(f)} />
      ) : null}

      {pieces.length > 0 ? (
        <ul class={styles.list} aria-label="Pieces">
          {pieces.map((piece, i) => (
            <PieceCard
              key={piece.id}
              index={i}
              piece={piece}
              model={model}
              expanded={open === piece.id}
              onToggle={() => setExpanded(open === piece.id ? null : piece.id)}
            />
          ))}
        </ul>
      ) : null}

      <ImportSheet flow={flow} pieces={pieces} onClose={closeFlow} />
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
      <span class={styles.emptyIcon} aria-hidden="true">
        <Icon name="music" size={32} />
      </span>
      <h2 id="library-empty">Your library is empty</h2>
      <p>
        Import a piano score as MusicXML — a .musicxml, compressed .mxl or MusicXML .xml file. Most notation programs
        export it (File → Export → MusicXML). The file stays on this device.
      </p>
      <div class={styles.emptyActions}>
        <FileButton variant="primary" icon="upload" accept={accept} disabled={disabled} onFile={onFile}>
          Import MusicXML
        </FileButton>
      </div>
      <p>Moving from another device? Restore a backup from Settings → Backup.</p>
    </section>
  )
}
