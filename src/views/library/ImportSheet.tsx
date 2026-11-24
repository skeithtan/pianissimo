import { importMessage } from '../../i18n/importMessage'
import { msg, messageLanguage } from '../../i18n/messages'
/**
 * The import sheet: one modal over the Library showing the `ImportFlow` phase — progress with
 * Cancel (all a score that needs no answer shows, L12), score/part choice, the import summary with
 * hands and tempo, or a readable failure.
 * Saving closes the sheet (L6); the library shows the notice.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { openPractice } from '../../app/navigation'
import type { PieceRecord } from '../../core/storage/records'
import { Button, Notice, Sheet } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { useLibraryDeps } from './deps'
import { FileButton, SCORE_ACCEPT } from './FileButton'
import { formatBytes } from './format'
import { ImportSummaryView } from './ImportSummary'
import { STAGE_TEXT, isSaving, type FlowPhase, type ImportFlow, type StorageStatus } from './importFlow'
import { initialDraft, reviewGate, type ReviewDraft } from './review'
import { candidateTitle, describePart, playableParts } from './selection'
import styles from './library.module.css'
import importStyles from './import.module.css'

export function ImportSheet({
  flow,
  pieces,
  onClose,
  onOpenExisting,
  onFindScores,
}: {
  flow: ImportFlow | null
  /** The library, to point out a score that is already in it. */
  pieces: readonly PieceRecord[]
  onClose: () => void
  onOpenExisting?: (pieceId: string) => void
  /** Offered when a file could not be imported. Closes this sheet and opens the guide. */
  onFindScores?: () => void
}) {
  const phase = flow?.phase.value ?? { kind: 'idle' as const }
  const open = flow !== null && phase.kind !== 'idle'
  // While "Saving…" the sheet stays open (X and Escape do nothing); it closes itself when saved.
  const closeUnlessSaving = () => {
    if (flow && isSaving(flow.phase.peek())) return
    onClose()
  }
  return (
    <Sheet title={msg('Add score')} open={open} onClose={closeUnlessSaving} wide>
      {flow ? (
        <FlowBody
          flow={flow}
          phase={phase}
          pieces={pieces}
          onClose={onClose}
          onOpenExisting={(pieceId) => {
            onClose()
            if (onOpenExisting) onOpenExisting(pieceId)
            else openPractice({ pieceId })
          }}
          onFindScores={onFindScores}
        />
      ) : null}
    </Sheet>
  )
}

function FlowBody({
  flow,
  phase,
  pieces,
  onClose,
  onOpenExisting,
  onFindScores,
}: {
  flow: ImportFlow
  phase: FlowPhase
  pieces: readonly PieceRecord[]
  onClose: () => void
  onOpenExisting: (pieceId: string) => void
  onFindScores: (() => void) | undefined
}) {
  switch (phase.kind) {
    case 'idle':
      return null
    case 'working':
      return <Working phase={phase} onCancel={() => flow.cancel()} />
    case 'choose':
      return <Choose flow={flow} phase={phase} />
    case 'review':
      return <Review flow={flow} phase={phase} pieces={pieces} onOpenExisting={onOpenExisting} />
    case 'failed':
      return <Failed flow={flow} phase={phase} onClose={onClose} onFindScores={onFindScores} />
  }
}

const STEP_TEXT = {
  reading: 'Opening the file',
  inspecting: 'Looking inside the file',
  building: 'Building the score',
} as const

function Working({ phase, onCancel }: { phase: Extract<FlowPhase, { kind: 'working' }>; onCancel: () => void }) {
  const fraction = Math.max(0, Math.min(1, phase.fraction))
  const label =
    phase.step === 'saving'
      ? msg('Saving…')
      : `${msg(phase.stage && phase.step === 'building' ? STAGE_TEXT[phase.stage] : STEP_TEXT[phase.step])}…`
  return (
    <div class={styles.flow} aria-busy="true">
      <p class={styles.fileName}>{phase.fileName}</p>
      <p class={styles.stage} aria-live="polite">
        {label}
      </p>
      <div
        class={styles.progressTrack}
        role="progressbar"
        aria-label={msg('Import progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <div class={styles.progressFill} style={{ transform: `scaleX(${Math.max(0.04, fraction)})` }} />
      </div>
      <p class={styles.muted}>{msg('Everything stays on this device. Nothing is uploaded.')}</p>
      <div class={styles.flowActions}>
        <span />
        <Button disabled={phase.step === 'saving'} onClick={onCancel}>
          {msg('Cancel import')}
        </Button>
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
          <legend>
            {msg('This file contains')} {candidates.length} {msg('scores. Which one?')}
          </legend>
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
                  {[c.composer, msg('{0} bars', c.measures), msg('{0} parts with notes', playableParts(c).length)]
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
        <legend>{msg('Which part is the piano?')}</legend>
        <p class={styles.muted}>
          {msg('Choose one two-staff piano part, or two one-staff parts (right hand above, left hand below).')}
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
                    {msg('Piano')}
                  </span>
                ) : null}
              </strong>
              <small>{p.notes === 0 ? msg('No notes') : describePart(p)}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <div class={styles.flowActions}>
        <Button onClick={() => flow.cancel()}>{msg('Cancel')}</Button>
        <Button variant="primary" type="submit" icon="forward">
          {msg('Continue')}
        </Button>
      </div>
    </form>
  )
}

function Review({
  flow,
  phase,
  pieces,
  onOpenExisting,
}: {
  flow: ImportFlow
  phase: Extract<FlowPhase, { kind: 'review' }>
  pieces: readonly PieceRecord[]
  onOpenExisting: (pieceId: string) => void
}) {
  const { summary, package: pkg } = phase.result
  const [draft, setDraft] = useState<ReviewDraft>(() => initialDraft(summary, pkg.model))
  const [triedSave, setTriedSave] = useState(false)
  // A new build (other parts) starts a new draft.
  useEffect(() => setDraft(initialDraft(summary, pkg.model)), [phase.result])
  const gate = useMemo(() => reviewGate(summary, draft, triedSave), [summary, draft, triedSave, messageLanguage()])
  const duplicate = pieces.find((p) => p.scoreVersionId === pkg.model.scoreVersionId)
  const save = () => {
    setTriedSave(true)
    if (!gate.canSave) return
    void flow.save(draft)
  }
  if (duplicate) {
    return (
      <div class={styles.flow}>
        <div class={importStyles.duplicate}>
          <p class={styles.muted}>{msg('Already in your library')}</p>
          <h3>{duplicate.title}</h3>
          {duplicate.composer ? <p class={styles.composer}>{duplicate.composer}</p> : null}
          <p>{msg('Open the piece you already have to keep your place and practice history.')}</p>
        </div>
        {phase.saveError ? <Notice tone="danger">{importMessage(phase.saveError)}</Notice> : null}
        <details class={importStyles.details}>
          <summary>{msg('Add a separate library entry')}</summary>
          <div class={importStyles.detailsBody}>
            <p class={styles.muted}>
              {msg('Another copy starts with fresh practice history and shares this score’s hands and tempo.')}
            </p>
            <div>
              <Button disabled={phase.saving} onClick={() => void flow.saveCopy(duplicate.id)}>
                {phase.saving ? msg('Saving…') : msg('Add another copy')}
              </Button>
            </div>
          </div>
        </details>
        <div class={styles.flowActions}>
          <Button disabled={phase.saving} onClick={() => flow.cancel()}>
            {msg('Cancel')}
          </Button>
          <Button variant="primary" icon="forward" disabled={phase.saving} onClick={() => onOpenExisting(duplicate.id)}>
            {msg('Open existing piece')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div class={styles.flow}>
      <ImportSummaryView summary={summary} draft={draft} gate={gate} onDraft={setDraft} compact />
      <div class={styles.footer}>
        {phase.saveError ? <Notice tone="danger">{importMessage(phase.saveError)}</Notice> : null}
        <div class={styles.flowActions}>
          {phase.choiceOffered ? (
            <Button onClick={() => flow.backToChoice()} disabled={phase.saving}>
              {msg('Change parts')}
            </Button>
          ) : (
            <Button onClick={() => flow.cancel()} disabled={phase.saving}>
              {msg('Cancel')}
            </Button>
          )}
          <Button variant="primary" icon="check" disabled={!gate.canSave || phase.saving} onClick={save}>
            {phase.saving ? msg('Saving…') : msg('Add and open')}
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
        ? msg('{0} of about {1} used.', formatBytes(e.usageBytes), formatBytes(e.quotaBytes))
        : msg('{0} used.', formatBytes(e.usageBytes))
      : ''
  const persistence =
    status.persistence === 'granted'
      ? msg('This browser keeps your library even when space runs low.')
      : status.persistence === 'denied'
        ? msg('This browser may clear stored data when space runs low. Export a backup now and then.')
        : msg('Export a backup now and then: browser storage is not the only copy you should keep.')
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
  onFindScores,
}: {
  flow: ImportFlow
  phase: Extract<FlowPhase, { kind: 'failed' }>
  onClose: () => void
  onFindScores: (() => void) | undefined
}) {
  const deps = useLibraryDeps()
  const details = phase.diagnostics.filter((d) => d.severity !== 'info')
  return (
    <div class={styles.flow}>
      {phase.fileName ? <p class={styles.fileName}>{phase.fileName}</p> : null}
      <Notice tone="danger">
        <strong>{msg('This file could not be imported.')}</strong> {importMessage(phase.message)}
        {details.length ? (
          <ul class={styles.diagList}>
            {details.slice(0, 8).map((d, i) => (
              <li key={i}>{(d.measure ? msg('Bar {0}: ', d.measure) : '') + importMessage(d.message)}</li>
            ))}
          </ul>
        ) : null}
      </Notice>
      <p class={styles.muted}>
        {msg(
          'Pianissimo imports MusicXML: .musicxml, compressed .mxl, or .xml files that contain a MusicXML score. Most notation programs can export it (File → Export → MusicXML).',
        )}
      </p>
      <div class={styles.flowActions}>
        <Button onClick={onClose}>{msg('Close')}</Button>
        {onFindScores ? (
          <Button icon="music" onClick={onFindScores}>
            {msg('Find scores')}
          </Button>
        ) : null}
        <FileButton
          variant="primary"
          icon="upload"
          accept={deps.isAppleMobile() ? undefined : SCORE_ACCEPT}
          onFile={(file) => void flow.openFile(file)}
        >
          {msg('Choose another file')}
        </FileButton>
      </div>
    </div>
  )
}
