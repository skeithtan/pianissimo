import { useEffect, useState } from 'preact/hooks'
import { msg, percentage } from '../../i18n/messages'
import { Button, Sheet } from '../../ui/controls'
import { noteAccuracy } from '../../core/recording/performance'
import type { RecordingInfo, RecordingFiles } from '../../core/recording/records'
import type { PianissimoStorage } from '../../core/storage'
import { downloadPair, recordingName } from './downloads'
import { unsaved } from './unsaved'
import styles from './recordings.module.css'

export type RecordingStorage = () => Promise<PianissimoStorage>

export function RecordingLinks({ files, info }: { files: RecordingFiles; info: RecordingInfo }) {
  const [audioUrl, setAudioUrl] = useState('')
  const [zip, setZip] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState(false)
  const name = recordingName(info)
  useEffect(() => {
    const audio = URL.createObjectURL(files.audio)
    setAudioUrl(audio)
    return () => {
      URL.revokeObjectURL(audio)
    }
  }, [files])
  useEffect(() => {
    setError(false)
    const abort = new AbortController()
    let live = true
    let url = ''
    void downloadPair(files, name, abort.signal).then(
      (b) => {
        if (live) {
          url = URL.createObjectURL(b)
          setZip(url)
        }
      },
      () => {
        if (live) {
          setError(true)
        }
      },
    )
    return () => {
      live = false
      abort.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [attempt, files, name])
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
        {zip ? (
          <a download={name + '.zip'} href={zip}>
            {msg('Download MIDI and WAV (.zip)')}
          </a>
        ) : (
          <Button disabled={!error} onClick={() => setAttempt((n) => n + 1)}>
            {error ? msg('Retry') : msg('Preparing…')}
          </Button>
        )}
      </div>
      {error && <p role="alert">{msg('Could not prepare the download. Try again.')}</p>}
    </div>
  )
}

function RecordingRow({
  info,
  best,
  storage,
  onDeleted,
  open,
  onToggle,
}: {
  info: RecordingInfo
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
            {msg(info.passage)} · {handName(info.hands)}
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

export function RecordingHistory({
  storage,
  onClose,
  pieceId,
  initialId,
}: {
  storage: RecordingStorage
  onClose: () => void
  initialId?: string | undefined
  pieceId?: string
}) {
  const [selected, setSelected] = useState(initialId)
  const [rows, setRows] = useState<RecordingInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
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
  const best = new Map<string, number>()
  for (const r of rows ?? [])
    if (!r.interrupted) best.set(r.context, Math.max(best.get(r.context) ?? -1, noteAccuracy(r.score)))
  return (
    <Sheet open title={msg('Recordings')} onClose={onClose}>
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
                  storage={storage}
                  best={noteAccuracy(r.score) === best.get(r.context)}
                  onDeleted={() => setRows((old) => old?.filter((t) => t.id !== r.id) ?? [])}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </Sheet>
  )
}
