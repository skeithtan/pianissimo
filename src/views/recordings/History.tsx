import { useEffect, useRef, useState } from 'preact/hooks'
import { timeOfDay } from '../../i18n/dates'
import { msg, percentage } from '../../i18n/messages'
import { pushNotice } from '../../app/state'
import { Button, Sheet } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import type { ScoreModel } from '../../core/model/score'
import type { PassageWords } from '../../core/model/passage'
import { noteAccuracy } from '../../core/recording/performance'
import type { RecordingInfo, RecordingFiles } from '../../core/recording/records'
import type { PianissimoStorage } from '../../core/storage'
import { isIncomplete, takePlayedThrough } from './completeness'
import { discarded, discardTakes, restored } from './discard'
import { downloadPair, recordingName, saveBlob } from './downloads'
import { IncompleteSheet } from './IncompleteSheet'
import { takePassageLabel, takeScoreVersion } from './passageLabel'
import { dayText, handName, lengthText } from './takeText'
import { unsaved } from './unsaved'
import styles from './recordings.module.css'

export type RecordingStorage = () => Promise<PianissimoStorage>

/**
 * Listen to a take, download it and, when it is stored, delete it. The player plays the take's own WAV
 * Blob; the ZIP is built only when Download is pressed, from the same Blobs without copying them, and
 * its URL is released once the browser has the file.
 */
export function RecordingLinks({
  files,
  info,
  onDelete,
}: {
  files: RecordingFiles | null
  info: RecordingInfo
  onDelete?: () => void
}) {
  const [audioUrl, setAudioUrl] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState(false)
  const building = useRef<AbortController | null>(null)
  const name = recordingName(info)
  useEffect(() => {
    if (!files) return
    const audio = URL.createObjectURL(files.audio)
    setAudioUrl(audio)
    return () => {
      URL.revokeObjectURL(audio)
      setAudioUrl('')
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
    if (building.current || !files) return
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
  return (
    <>
      <div class={styles.player}>
        {audioUrl ? (
          <audio
            controls
            preload="metadata"
            src={audioUrl}
            ref={(el) => el?.setAttribute('controlslist', 'nodownload')}
            aria-label={msg('Listen to recording')}
          />
        ) : null}
      </div>
      <div class={styles.actions}>
        <Button
          icon="download"
          class={styles.tool}
          disabled={preparing || !files}
          aria-label={preparing ? undefined : msg('Download MIDI and WAV (.zip)')}
          title={msg('Download MIDI and WAV (.zip)')}
          onClick={() => void download()}
        >
          {preparing ? msg('Preparing…') : msg('Download')}
        </Button>
        {onDelete ? (
          <Button
            icon="trash"
            class={`${styles.tool} ${styles.delete}`}
            aria-label={msg('Delete recording')}
            title={msg('Delete recording')}
            onClick={onDelete}
          >
            {msg('Delete')}
          </Button>
        ) : null}
      </div>
      {error && <p role="alert">{msg('Could not prepare the download. Try again.')}</p>}
    </>
  )
}

type Standing = 'interrupted' | 'incomplete' | 'best' | 'scored'
const STANDING: Readonly<Record<Standing, () => string>> = {
  interrupted: () => msg('Interrupted'),
  incomplete: () => msg('Incomplete'),
  best: () => msg('Best take'),
  scored: () => msg('Note score'),
}

function RecordingRow({
  info,
  words,
  titled,
  standing,
  storage,
  onDelete,
  open,
  onToggle,
}: {
  info: RecordingInfo
  /** The score of the take's version, when it is on this device (for its passage label). */
  words: PassageWords | undefined
  /** Takes of several pieces are listed: each says which. */
  titled: boolean
  standing: Standing
  storage: RecordingStorage
  open: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  const [error, setError] = useState('')
  const [files, setFiles] = useState<RecordingFiles | null>(null)
  useEffect(() => {
    if (!open) {
      setFiles(null)
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
  const { matched, expected, played } = info.score
  const when = (
    <>
      {timeOfDay(info.createdAt)} <span class={styles.length}>{lengthText(info.durationMs)}</span>
    </>
  )
  return (
    <li class={styles.take} data-open={open || undefined} data-take={info.id}>
      <button
        type="button"
        class={styles.summary}
        aria-expanded={open}
        onClick={() => {
          setError('')
          onToggle()
        }}
      >
        <span class={styles.words}>
          <strong>{titled ? info.title : when}</strong>
          <small>
            {takePassageLabel(info, words)} · {handName(info.hands)}
          </small>
          {titled ? <small>{when}</small> : null}
        </span>
        <span class={styles.result}>
          <strong>{percentage(noteAccuracy(info.score))}</strong>
          <small class={styles.standing} data-standing={standing}>
            {STANDING[standing]()}
          </small>
        </span>
      </button>
      {open && (
        <div class={styles.open}>
          {error ? <p role="alert">{error}</p> : null}
          <RecordingLinks files={files} info={info} onDelete={onDelete} />
          <p class={styles.facts}>
            {msg('{0} matched · {1} missed · {2} extra', matched, expected - matched, played - matched)}
            <br />
            {msg('Audio input')} · {info.input}
          </p>
        </div>
      )}
    </li>
  )
}

export { handName }

export interface RecordingListProps {
  readonly storage: RecordingStorage
  readonly initialId?: string | undefined
  /** This piece's takes; without it every take, of pieces since deleted included. */
  readonly pieceId?: string | undefined
  /** The score already open (Practice): its takes need not load it again. */
  readonly model?: ScoreModel | undefined
}

/** The Recordings sheet over whatever opened it, once this module is loaded (`RecordingsSheet` loads it). */
export function RecordingHistory({ onClose, ...list }: RecordingListProps & { onClose: () => void }) {
  return (
    <Sheet open title={msg('Recordings')} onClose={onClose} side>
      <RecordingList {...list} />
    </Sheet>
  )
}

/** The scores of the takes' versions, read once each: for their passage labels, and to tell incomplete ones. */
function useScores(storage: RecordingStorage, model: ScoreModel | undefined) {
  const [scores, setScores] = useState<ReadonlyMap<string, ScoreModel>>(
    () => new Map(model ? [[model.scoreVersionId, model]] : []),
  )
  const asked = useRef(new Map<string, Promise<ScoreModel | undefined>>())
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  function scoreOf(info: RecordingInfo): Promise<ScoreModel | undefined> {
    const version = takeScoreVersion(info)
    if (version === undefined) return Promise.resolve(undefined)
    if (model?.scoreVersionId === version) return Promise.resolve(model)
    const known = asked.current.get(version)
    if (known) return known
    const read = storage()
      .then((s) => s.getPackage(version))
      .then((pkg) => pkg?.model)
      // Labels fall back to the text stored with each take.
      .catch(() => undefined)
    asked.current.set(version, read)
    void read.then((found) => {
      if (found && mounted.current) setScores((old) => new Map(old).set(version, found))
    })
    return read
  }
  return { scores, scoreOf }
}

export function RecordingList({ storage, pieceId, initialId, model }: RecordingListProps) {
  const [selected, setSelected] = useState(initialId)
  const [all, setAll] = useState<readonly RecordingInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [through, setThrough] = useState<ReadonlyMap<string, boolean | null>>(new Map())
  const { scores, scoreOf } = useScores(storage, model)
  const root = useRef<HTMLDivElement>(null)
  const broughtBack = restored.value
  /** The incomplete takes that are about to go, as they were when asked for. */
  const [doomed, setDoomed] = useState<readonly RecordingInfo[]>([])
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    let live = true
    setFailed(false)
    void storage()
      .then((s) => s.listRecordings())
      .then(
        (infos) => {
          if (live)
            setAll(infos.filter((r) => !pieceId || r.pieceId === pieceId).sort((a, b) => b.createdAt - a.createdAt))
        },
        () => {
          if (live) setFailed(true)
        },
      )
    return () => {
      live = false
    }
  }, [storage, pieceId, reload, broughtBack])
  useEffect(() => {
    let live = true
    void (async () => {
      for (const info of all ?? []) {
        // A label is rebuilt from its score.
        if (info.passageRange) void scoreOf(info)
      }
      for (const info of all ?? []) {
        if (!live) return
        if (info.playedThrough !== undefined) continue
        const result = await takePlayedThrough(info, scoreOf, await storage()).catch(() => null)
        if (live) setThrough((old) => new Map(old).set(info.id, result))
      }
    })()
    return () => {
      live = false
    }
  }, [all, storage])

  const rows = all?.filter((r) => !discarded.value.has(r.id)) ?? null
  const incomplete = new Set((rows ?? []).filter((r) => isIncomplete(r, through.get(r.id))).map((r) => r.id))
  const best = new Map<string, number>()
  for (const r of rows ?? [])
    if (!r.interrupted && !incomplete.has(r.id))
      best.set(r.context, Math.max(best.get(r.context) ?? -1, noteAccuracy(r.score)))
  const standing = (r: RecordingInfo): Standing =>
    r.interrupted
      ? 'interrupted'
      : incomplete.has(r.id)
        ? 'incomplete'
        : noteAccuracy(r.score) === best.get(r.context)
          ? 'best'
          : 'scored'
  const days: { day: string; takes: RecordingInfo[] }[] = []
  for (const r of rows ?? []) {
    const on = dayText(r.createdAt)
    if (days.at(-1)?.day === on) days.at(-1)!.takes.push(r)
    else days.push({ day: on, takes: [r] })
  }

  async function remove(ids: readonly string[]) {
    // What had the focus goes with them.
    root.current?.focus()
    try {
      await discardTakes(storage, ids)
    } catch {
      pushNotice({
        kind: 'warning',
        text: ids.length === 1 ? msg('Could not delete this recording.') : msg('Could not delete these recordings.'),
      })
    }
  }

  const inMemory = [...unsaved.values()].filter((t) => !pieceId || pieceId === t.info.pieceId)
  return (
    <div class={styles.recordings} ref={root} tabIndex={-1}>
      {inMemory.map((t) => (
        <section key={t.info.id} class={styles.unsaved}>
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
        <div>
          <Button onClick={() => setReload((n) => n + 1)}>{msg('Retry')}</Button>
        </div>
      ) : rows === null ? (
        <p>{msg('Loading…')}</p>
      ) : rows.length === 0 ? (
        <div class={styles.empty}>
          <Icon name="recordings" size={40} />
          <p>{msg('No recordings yet.')}</p>
        </div>
      ) : (
        <>
          <div class={styles.bar}>
            <span>{rows.length === 1 ? msg('1 recording') : msg('{0} recordings', rows.length)}</span>
            <div class={styles.clear}>
              {incomplete.size > 0 ? (
                <Button
                  class={styles.tool}
                  onClick={() => {
                    setDoomed(rows.filter((r) => incomplete.has(r.id)))
                    setAsking(true)
                  }}
                >
                  {msg('Delete incomplete ({0})', incomplete.size)}
                </Button>
              ) : null}
              <Button class={`${styles.tool} ${styles.delete}`} onClick={() => void remove(rows.map((r) => r.id))}>
                {msg('Clear all')}
              </Button>
            </div>
          </div>
          {days.map((group) => (
            <section key={group.day} class={styles.day}>
              <h3>{group.day}</h3>
              <ul class={styles.list}>
                {group.takes.map((r) => (
                  <RecordingRow
                    key={r.id}
                    open={selected === r.id}
                    onToggle={() => setSelected((old) => (old === r.id ? undefined : r.id))}
                    info={r}
                    words={scores.get(takeScoreVersion(r) ?? '')}
                    titled={!pieceId}
                    storage={storage}
                    standing={standing(r)}
                    onDelete={() => void remove([r.id])}
                  />
                ))}
              </ul>
            </section>
          ))}
          <p class={styles.about}>
            {msg(
              'The note score compares the notes you played with the score. Missing and extra notes lower it. Best takes share the same piece, passage, and hands.',
            )}{' '}
            {msg('An incomplete take was not played from the start of its passage to the end.')}
          </p>
        </>
      )}
      <IncompleteSheet
        open={asking}
        takes={doomed}
        passageOf={(r) => takePassageLabel(r, scores.get(takeScoreVersion(r) ?? ''))}
        titled={!pieceId}
        onCancel={() => setAsking(false)}
        onDelete={(ids) => {
          setAsking(false)
          void remove(ids)
        }}
      />
    </div>
  )
}
