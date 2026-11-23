import { useEffect, useRef, useState } from 'preact/hooks'
import { msg, percentage } from '../../i18n/messages'
import { Button, Sheet } from '../../ui/controls'
import type { PassageWords } from '../../core/model/passage'
import { noteAccuracy } from '../../core/recording/performance'
import type { RecordingInfo, RecordingFiles } from '../../core/recording/records'
import type { PianissimoStorage } from '../../core/storage'
import { downloadPair, recordingName, saveBlob } from './downloads'
import { takePassageLabel, takeScoreVersion } from './passageLabel'
import { deletedTake, unsaved } from './unsaved'
import styles from './recordings.module.css'

export type RecordingStorage = () => Promise<PianissimoStorage>

/**
 * Listen to a take and download it. The player plays the take's own WAV Blob; the ZIP is built
 * only when Download is pressed, from the same Blobs without copying them, and its URL is
 * released once the browser has the file.
 */
export function RecordingLinks({ files, info }: { files: RecordingFiles; info: RecordingInfo }) {
  const [audioUrl, setAudioUrl] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState(false)
  const building = useRef<AbortController | null>(null)
  const name = recordingName(info)
  useEffect(() => {
    const audio = URL.createObjectURL(files.audio)
    setAudioUrl(audio)
    return () => {
      URL.revokeObjectURL(audio)
    }
  }, [files])
  useEffect(
    () => () => {
      building.current?.abort()
      building.current = null
    },
    [files],
  )
  async function download() {
    if (building.current) return
    const abort = new AbortController()
    building.current = abort
    setError(false)
    setPreparing(true)
    try {
      const localStart = info.createdAt + (info.startUtcOffsetMinutes ?? 0) * 60_000
      const zip = await downloadPair(files, name, abort.signal, localStart)
      if (!abort.signal.aborted) saveBlob(zip, name + '.zip')
    } catch {
      if (!abort.signal.aborted) setError(true)
    } finally {
      if (building.current === abort) {
        building.current = null
        setPreparing(false)
      }
    }
  }
  if (!audioUrl) return null
  return (
    <div class={styles.detail}>
      <audio
        controls
        preload="metadata"
        src={audioUrl}
        ref={(el) => el?.setAttribute('controlslist', 'nodownload')}
        aria-label={msg('Listen to recording')}
      />
      <div class={styles.actions}>
        <Button icon="download" disabled={preparing} onClick={() => void download()}>
          {preparing ? msg('Preparing…') : msg('Download MIDI and WAV (.zip)')}
        </Button>
      </div>
      {error && <p role="alert">{msg('Could not prepare the download. Try again.')}</p>}
    </div>
  )
}

function RecordingRow({
  info,
  words,
  best,
  storage,
  onDeleted,
  open,
  onToggle,
}: {
  info: RecordingInfo
  /** The score of the take's version, when it is on this device (for its passage label). */
  words: PassageWords | undefined
  best: boolean
  storage: RecordingStorage
  open: boolean
  onToggle: () => void
  onDeleted: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<RecordingFiles | null>(null)
  useEffect(() => {
    if (!open) {
      setFiles(null)
      setConfirm(false)
      return
    }
    let live = true
    void storage()
      .then((s) => s.getRecordingFiles(info.id))
      .then((f) => {
        if (!f) throw new Error()
        if (live) setFiles(f)
      })
      .catch(() => {
        if (live) setError(msg('Could not open this recording.'))
      })
    return () => {
      live = false
    }
  }, [open, storage, info.id])
  async function remove() {
    setDeleting(true)
    try {
      await (await storage()).deleteRecording(info.id)
      deletedTake.value = info.id
      onDeleted()
    } catch {
      setError(msg('Could not delete this recording.'))
      setDeleting(false)
    }
  }
  const { matched, expected, played } = info.score
  return (
    <li class={styles.take}>
      <button
        class={styles.summary}
        aria-expanded={open}
        onClick={() => {
          setError('')
          onToggle()
        }}
      >
        <span>
          <strong>{info.title}</strong>
          <small>
            {takePassageLabel(info, words)} · {handName(info.hands)}
          </small>
          <small>
            {new Date(info.createdAt).toLocaleString(undefined)} · {Math.round(info.durationMs / 1000)} s
          </small>
        </span>
        <span>
          <strong>{percentage(noteAccuracy(info.score))}</strong>
          <small>{info.interrupted ? msg('Interrupted') : best ? msg('Best take') : msg('Note score')}</small>
        </span>
      </button>
      {open && (
        <div class={styles.detail}>
          <p>
            {msg('Audio input')} · {info.input}
          </p>
          <p>{msg('{0} matched · {1} missed · {2} extra', matched, expected - matched, played - matched)}</p>
          {files && <RecordingLinks files={files} info={info} />}
          {error && <p role="alert">{error}</p>}
          {confirm ? (
            <div>
              <p>{msg('Delete this take and both files from this device?')}</p>
              <div class={styles.actions}>
                <Button onClick={() => setConfirm(false)} disabled={deleting}>
                  {msg('Cancel')}
                </Button>
                <Button variant="danger" onClick={() => void remove()} disabled={deleting}>
                  {msg('Delete recording')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              {msg('Delete recording')}
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

export function handName(hands: RecordingInfo['hands']) {
  return hands === 'both' ? msg('Both hands') : hands === 'left' ? msg('Left hand') : msg('Right hand')
}

export interface RecordingListProps {
  readonly storage: RecordingStorage
  readonly onDeleted?: ((id: string) => void) | undefined
  readonly initialId?: string | undefined
  /** This piece's takes; without it every take, of pieces since deleted included. */
  readonly pieceId?: string | undefined
  /** The score already open (Practice): its takes need not load it again. */
  readonly model?: (PassageWords & { readonly scoreVersionId: string }) | undefined
}

/** The Recordings sheet. Progress shows the same list in its own (U148). */
export function RecordingHistory({ onClose, ...list }: RecordingListProps & { onClose: () => void }) {
  return (
    <Sheet open title={msg('Recordings')} onClose={onClose}>
      <RecordingList {...list} />
    </Sheet>
  )
}

export function RecordingList({ storage, onDeleted, pieceId, initialId, model }: RecordingListProps) {
  const [selected, setSelected] = useState(initialId)
  const [rows, setRows] = useState<RecordingInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [scores, setScores] = useState<ReadonlyMap<string, PassageWords>>(
    () => new Map(model ? [[model.scoreVersionId, model]] : []),
  )
  useEffect(() => {
    let live = true
    setFailed(false)
    void storage()
      .then((s) => s.listRecordings())
      .then(
        (all) => {
          if (live)
            setRows(all.filter((r) => !pieceId || r.pieceId === pieceId).sort((a, b) => b.createdAt - a.createdAt))
        },
        () => {
          if (live) setFailed(true)
        },
      )
    return () => {
      live = false
    }
  }, [storage, pieceId, reload])
  // Passage labels are built from each take's score, looked up once per score version.
  const looked = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  useEffect(() => {
    const missing = new Set<string>()
    for (const r of rows ?? []) {
      const version = r.passageRange ? takeScoreVersion(r) : undefined
      if (version !== undefined && !scores.has(version) && !looked.current.has(version)) missing.add(version)
    }
    if (missing.size === 0) return
    for (const version of missing) looked.current.add(version)
    void (async () => {
      const found = new Map<string, PassageWords>()
      try {
        const s = await storage()
        for (const version of missing) {
          const pkg = await s.getPackage(version)
          if (pkg) found.set(version, pkg.model)
        }
      } catch {
        // Labels fall back to the text stored with each take.
      }
      if (mounted.current && found.size) setScores((old) => new Map([...old, ...found]))
    })()
  }, [rows, storage, scores])
  const best = new Map<string, number>()
  for (const r of rows ?? [])
    if (!r.interrupted) best.set(r.context, Math.max(best.get(r.context) ?? -1, noteAccuracy(r.score)))
  return (
    <div class={styles.detail}>
      {[...unsaved.values()]
        .filter((t) => !pieceId || pieceId === t.info.pieceId)
        .map((t) => (
          <section key={t.info.id} class={styles.take}>
            <strong>{t.info.title}</strong>
            <p>{msg('This take is in memory. Download it or retry saving before closing the page.')}</p>
            <RecordingLinks info={t.info} files={t.files} />
            <Button
              onClick={async () => {
                try {
                  await (await storage()).saveRecording(t.info, t.files)
                  unsaved.delete(t.info.id)
                  setReload((n) => n + 1)
                } catch {
                  setFailed(true)
                }
              }}
            >
              {msg('Retry saving')}
            </Button>
          </section>
        ))}
      {failed ? (
        <Button onClick={() => setReload((n) => n + 1)}>{msg('Retry')}</Button>
      ) : rows === null ? (
        <p>{msg('Loading…')}</p>
      ) : rows.length === 0 ? (
        <p>{msg('No recordings yet.')}</p>
      ) : (
        <>
          <p>
            {msg(
              'The note score compares the notes you played with the score. Missing and extra notes lower it. Best takes share the same piece, passage, and hands.',
            )}
          </p>
          <ul class={styles.list}>
            {rows.map((r) => (
              <RecordingRow
                key={r.id}
                open={selected === r.id}
                onToggle={() => setSelected((old) => (old === r.id ? undefined : r.id))}
                info={r}
                words={scores.get(takeScoreVersion(r) ?? '')}
                storage={storage}
                best={noteAccuracy(r.score) === best.get(r.context)}
                onDeleted={() => {
                  setRows((old) => old?.filter((t) => t.id !== r.id) ?? [])
                  onDeleted?.(r.id)
                }}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
