/**
 * The import sheet: one modal over the Library showing the `ImportFlow` phase — progress with
 * Cancel, score/part choice, the import summary with hands and tempo, or a readable failure.
 * Saving closes the sheet (L6); the library shows the notice.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { connectionStatus, settings } from '../../app/state'
import { isWebAudioSupported, sharedAudioContext } from '../../core/playback/webaudio/context'
import type { PieceRecord } from '../../core/storage/records'
import { Button, Notice, Sheet } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { useLibraryDeps } from './deps'
import { FileButton, SCORE_ACCEPT } from './FileButton'
import { formatBytes } from './format'
import { ImportSummaryView } from './ImportSummary'
import { STAGE_TEXT, type FlowPhase, type ImportFlow, type StorageStatus } from './importFlow'
import { initialDraft, reviewGate, type ReviewDraft } from './review'
import { candidateTitle, describePart, playableParts } from './selection'
import styles from './library.module.css'

export function ImportSheet({
  flow,
  pieces,
  onClose,
}: {
  flow: ImportFlow | null
  /** The library, to point out a score that is already in it. */
  pieces: readonly PieceRecord[]
  onClose: () => void
}) {
  const phase = flow?.phase.value ?? { kind: 'idle' as const }
  const open = flow !== null && phase.kind !== 'idle'
  const title = flow?.mode.kind === 'replace' ? `Replace the score of “${flow.mode.piece.title}”` : 'Import MusicXML'
  return (
    <Sheet title={title} open={open} onClose={onClose} wide>
      {flow ? <FlowBody flow={flow} phase={phase} pieces={pieces} onClose={onClose} /> : null}
    </Sheet>
  )
}

function FlowBody({
  flow,
  phase,
  pieces,
  onClose,
}: {
  flow: ImportFlow
  phase: FlowPhase
  pieces: readonly PieceRecord[]
  onClose: () => void
}) {
  switch (phase.kind) {
    case 'idle':
      return null
    case 'working':
      return <Working phase={phase} onCancel={() => flow.cancel()} />
    case 'choose':
      return <Choose flow={flow} phase={phase} />
    case 'review':
      return <Review flow={flow} phase={phase} pieces={pieces} />
    case 'failed':
      return <Failed flow={flow} phase={phase} onClose={onClose} />
  }
}

const STEP_TEXT = {
  reading: 'Opening the file',
  inspecting: 'Looking inside the file',
  building: 'Building the score',
} as const

function Working({ phase, onCancel }: { phase: Extract<FlowPhase, { kind: 'working' }>; onCancel: () => void }) {
  const fraction = Math.max(0, Math.min(1, phase.fraction))
  const label = phase.stage && phase.step === 'building' ? STAGE_TEXT[phase.stage] : STEP_TEXT[phase.step]
  return (
    <div class={styles.flow} aria-busy="true">
      <p class={styles.fileName}>{phase.fileName}</p>
      <p class={styles.stage} aria-live="polite">
        {label}…
      </p>
      <div
        class={styles.progressTrack}
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <div class={styles.progressFill} style={{ transform: `scaleX(${Math.max(0.04, fraction)})` }} />
      </div>
      <p class={styles.muted}>Everything stays on this device; nothing is uploaded.</p>
      <div class={styles.flowActions}>
        <span />
        <Button onClick={onCancel}>Cancel import</Button>
      </div>
    </div>
  )
}

function Choose({ flow, phase }: { flow: ImportFlow; phase: Extract<FlowPhase, { kind: 'choose' }> }) {
  const candidates = phase.inspect.candidates
  const candidate = candidates.find((c) => c.id === phase.candidateId) ?? candidates[0]!
  const parts = candidate.parts
  const problem = phase.error
  return (
    <form
      class={styles.flow}
      onSubmit={(e) => {
        e.preventDefault()
        void flow.confirmChoice()
      }}
    >
      <p class={styles.fileName}>{phase.fileName}</p>
      {candidates.length > 1 ? (
        <fieldset class={styles.choices}>
          <legend>This file contains {candidates.length} scores. Which one?</legend>
          {candidates.map((c) => (
            <label key={c.id} class={styles.choice}>
              <input
                type="radio"
                name="import-candidate"
                checked={c.id === candidate.id}
                onChange={() => flow.chooseCandidate(c.id)}
              />
              <span>
                <strong>{candidateTitle(c)}</strong>
                <small>
                  {[c.composer, `${c.measures} bars`, `${playableParts(c).length} parts with notes`]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p class={styles.stage}>{candidateTitle(candidate)}</p>
      )}
      <fieldset class={styles.choices}>
        <legend>Which part is the piano?</legend>
        <p class={styles.muted}>
          Choose one two-staff piano part, or two one-staff parts (right hand above, left hand below).
        </p>
        {parts.map((p) => (
          <label key={p.id} class={styles.choice}>
            <input
              type="checkbox"
              checked={phase.partIds.includes(p.id)}
              disabled={p.notes === 0}
              onChange={() => flow.togglePart(p.id)}
            />
            <span>
              <strong>
                {p.name}{' '}
                {p.pianoLike ? (
                  <span class={styles.tag} data-tone="success">
                    Piano
                  </span>
                ) : null}
              </strong>
              <small>{p.notes === 0 ? 'No notes' : describePart(p)}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <div class={styles.flowActions}>
        <Button onClick={() => flow.cancel()}>Cancel</Button>
        <Button variant="primary" type="submit" icon="forward">
          Continue
        </Button>
      </div>
    </form>
  )
}

function Review({
  flow,
  phase,
  pieces,
}: {
  flow: ImportFlow
  phase: Extract<FlowPhase, { kind: 'review' }>
  pieces: readonly PieceRecord[]
}) {
  const { summary, package: pkg } = phase.result
  const [draft, setDraft] = useState<ReviewDraft>(() => initialDraft(summary, pkg.model))
  const [triedSave, setTriedSave] = useState(false)
  // A new build (other parts) starts a new draft.
  useEffect(() => setDraft(initialDraft(summary, pkg.model)), [phase.result])
  const gate = useMemo(() => reviewGate(summary, draft, triedSave), [summary, draft, triedSave])
  const replacing = flow.mode.kind === 'replace'
  const duplicate = pieces.find(
    (p) =>
      p.scoreVersionId === pkg.model.scoreVersionId &&
      !(replacing && flow.mode.kind === 'replace' && flow.mode.piece.id === p.id),
  )
  const save = () => {
    setTriedSave(true)
    if (!gate.canSave) return
    // Unlock browser sound in this click, before storage and score preparation outlive the
    // user gesture. This creates only the shared context; samples still load in Practice.
    const appSettings = settings.peek()
    const browserSound =
      appSettings.sound.destination === 'browser' ||
      (appSettings.sound.destination === 'auto' && !connectionStatus.peek().outputName)
    if (!replacing && (browserSound || appSettings.metronome.enabled) && isWebAudioSupported()) {
      try {
        sharedAudioContext()
      } catch {
        // Practice reports unavailable sound without preventing the score from being saved.
      }
    }
    void flow.save(draft)
  }
  return (
    <div class={styles.flow}>
      <p class={styles.fileName}>{phase.fileName}</p>
      {duplicate ? (
        <Notice tone="info">
          This score is already in your library as “{duplicate.title}”. Adding it again creates a second copy.
        </Notice>
      ) : null}
      {replacing ? (
        <Notice tone="info">
          The piece keeps its place in the library. Results and practice history from the old score stay separate and
          are never mixed with the new one; the resume position is reset.
        </Notice>
      ) : null}
      <ImportSummaryView summary={summary} draft={draft} gate={gate} onDraft={setDraft} />
      <div class={styles.footer}>
        {phase.saveError ? <Notice tone="danger">{phase.saveError}</Notice> : null}
        {!gate.canSave ? (
          <div role="status">
            <strong>Before scored practice:</strong>
            <ul class={styles.blockers}>
              {gate.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div class={styles.flowActions}>
          {phase.choiceOffered ? (
            <Button onClick={() => flow.backToChoice()} disabled={phase.saving}>
              Change parts
            </Button>
          ) : (
            <Button onClick={() => flow.cancel()} disabled={phase.saving}>
              Cancel
            </Button>
          )}
          <Button variant="primary" icon="check" disabled={!gate.canSave || phase.saving} onClick={save}>
            {phase.saving ? 'Saving…' : replacing ? 'Replace score' : 'Add to library'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function StorageStatusLine({ status }: { status: StorageStatus | null }) {
  if (!status) return null
  const e = status.estimate
  const usage =
    e?.usageBytes !== undefined
      ? e.quotaBytes !== undefined
        ? `${formatBytes(e.usageBytes)} of about ${formatBytes(e.quotaBytes)} used.`
        : `${formatBytes(e.usageBytes)} used.`
      : ''
  const persistence =
    status.persistence === 'granted'
      ? 'This browser keeps your library even when space runs low.'
      : status.persistence === 'denied'
        ? 'This browser may clear stored data when space runs low; export a backup now and then.'
        : 'Export a backup now and then: browser storage is not the only copy you should keep.'
  return (
    <p class={styles.storageLine}>
      <Icon name={status.persistence === 'granted' ? 'check' : 'alert'} size={16} />
      <span>
        {persistence} {usage}
      </span>
    </p>
  )
}

function Failed({
  flow,
  phase,
  onClose,
}: {
  flow: ImportFlow
  phase: Extract<FlowPhase, { kind: 'failed' }>
  onClose: () => void
}) {
  const deps = useLibraryDeps()
  const details = phase.diagnostics.filter((d) => d.severity !== 'info')
  return (
    <div class={styles.flow}>
      {phase.fileName ? <p class={styles.fileName}>{phase.fileName}</p> : null}
      <Notice tone="danger">
        <strong>This file could not be imported.</strong> {phase.message}
        {details.length ? (
          <ul class={styles.diagList}>
            {details.slice(0, 8).map((d, i) => (
              <li key={i}>{(d.measure ? `Bar ${d.measure}: ` : '') + d.message}</li>
            ))}
          </ul>
        ) : null}
      </Notice>
      <p class={styles.muted}>
        Pianissimo imports MusicXML: .musicxml, compressed .mxl, or .xml files that contain a MusicXML score. Most
        notation programs can export it (File → Export → MusicXML).
      </p>
      <div class={styles.flowActions}>
        <Button onClick={onClose}>Close</Button>
        <FileButton
          variant="primary"
          icon="upload"
          accept={deps.isAppleMobile() ? undefined : SCORE_ACCEPT}
          onFile={(file) => void flow.openFile(file)}
        >
          Choose another file
        </FileButton>
      </div>
    </div>
  )
}
