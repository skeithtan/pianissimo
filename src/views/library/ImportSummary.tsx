/**
 * Import summary (spec "MusicXML score import": selected piano parts, hand assignments,
 * numerical tempo, and any missing or unsupported information; the checks before scored
 * practice). The two things the user must settle — hands and tempo — come first; the score
 * check follows as expandable rows with counts so nothing is silently dropped.
 *
 * No score preview here: it would need the notation engine (spec "Deferred assets"); the
 * piece's notation appears in Practice (DECISIONS L4).
 */
import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import type { ImportSummary as Summary, SummaryVoice } from '../../core/import/summary'
import type { Hand } from '../../core/model/score'
import { BeatUnitIcon } from '../../ui/BeatUnitIcon'
import { Button, Segmented } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { formatBpm } from '../../ui/speed'
import {
  BEAT_UNIT_CHOICES,
  describeCrossStaff,
  describeStaffUse,
  handLines,
  type BeatUnitChoice,
  type ReviewDraft,
  type ReviewGate,
} from './review'
import styles from './library.module.css'

const HAND_OPTIONS = [
  { value: 'L', label: 'Left hand' },
  { value: 'R', label: 'Right hand' },
] as const

export function ImportSummaryView({
  summary,
  draft,
  gate,
  onDraft,
  tempoEntry = !summary.tempo.present,
  editHands = false,
}: {
  summary: Summary
  draft: ReviewDraft
  gate: ReviewGate
  onDraft: (next: ReviewDraft) => void
  /** The practice tempo is typed here (no tempo in the score; also when reviewing a stored piece). */
  tempoEntry?: boolean
  /** Show every voice's hand control from the start (reviewing a stored piece, L5). */
  editHands?: boolean
}) {
  const c = summary.counts
  const bars = c.occurrences === c.measures ? `${c.measures}` : `${c.measures} (${c.occurrences} played)`
  return (
    <div class={styles.summary}>
      <header class={styles.summaryHead}>
        <h3>{summary.title}</h3>
        {summary.composer ? <p class={styles.composer}>{summary.composer}</p> : null}
        <p class={styles.muted}>
          {summary.parts
            .map((p) => `${p.name} (${p.staffCount} ${p.staffCount === 1 ? 'staff' : 'staves'})`)
            .join(' + ')}
        </p>
      </header>

      <dl class={styles.facts} aria-label="Score contents">
        <Fact label="Bars" value={bars} />
        <Fact label="Notes" value={String(c.performedNotes)} />
        <Fact label="Chords" value={String(c.chords)} />
        <Fact label="Voices" value={String(c.voices)} />
        <Fact label="Ties" value={String(c.tiedContinuations)} />
        <Fact label="Tuplet notes" value={String(c.tupletNotes)} />
      </dl>

      <HandsSection summary={summary} draft={draft} onDraft={onDraft} editHands={editHands} />
      <TempoSection summary={summary} draft={draft} gate={gate} onDraft={onDraft} tempoEntry={tempoEntry} />
      <ScoreChecks summary={summary} />
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div class={styles.fact}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function StateTag({ ok, okText, needsText }: { ok: boolean; okText: string; needsText: string }) {
  return (
    <span class={styles.tag} data-tone={ok ? 'success' : 'warning'}>
      <Icon name={ok ? 'check' : 'alert'} size={14} />
      {ok ? okText : needsText}
    </span>
  )
}

function voiceTitle(v: SummaryVoice, multiPart: boolean): string {
  return multiPart ? `Voice ${v.voice} · ${v.partName}` : `Voice ${v.voice}`
}

function HandsSection({
  summary,
  draft,
  onDraft,
  editHands,
}: {
  summary: Summary
  draft: ReviewDraft
  onDraft: (d: ReviewDraft) => void
  editHands: boolean
}) {
  const ambiguous = summary.voices.filter((v) => v.ambiguous)
  const multiPart = summary.parts.length > 1
  const staffCount = summary.counts.staves
  const crossStaff = summary.voices.filter((v) => v.crossStaffBars.length > 0 && !v.ambiguous)
  const [opened, setOpened] = useState(false)
  const editing = editHands || opened
  const expanded = !draft.handsConfirmed || editing
  const setHand = (key: string, hand: Hand) => onDraft({ ...draft, hands: { ...draft.hands, [key]: hand } })
  return (
    <section class={styles.section} data-state={draft.handsConfirmed ? 'ok' : 'needs'} aria-labelledby="import-hands">
      <div class={styles.sectionHead}>
        <h4 id="import-hands">Hands</h4>
        <StateTag ok={draft.handsConfirmed} okText="From the score" needsText="Needs your confirmation" />
      </div>
      {!draft.handsConfirmed ? (
        <p class={styles.muted}>
          {ambiguous.length === 1 ? 'One voice has' : 'Some voices have'} notes on both staves in similar numbers, so
          the file does not say which hand plays {ambiguous.length === 1 ? 'it' : 'them'}. Choose a hand, then confirm.
        </p>
      ) : (
        <ul class={styles.handLines} aria-label="Hands">
          {handLines(summary.voices, draft.hands).map((line) => (
            <li key={line.hand} data-hand={line.hand}>
              <strong>{line.hand === 'R' ? 'Right hand' : 'Left hand'}</strong>
              <span>
                {line.voices ? `${line.voices[0]!.toUpperCase()}${line.voices.slice(1)}` : 'No voices'}
                {line.notes ? ` · ${line.notes} notes` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {draft.handsConfirmed && !editing && crossStaff.length > 0 ? (
        <p class={styles.muted}>
          {crossStaff
            .map((v) => `${voiceTitle(v, multiPart)} stays one hand: ${describeCrossStaff(v, staffCount)}.`)
            .join(' ')}
        </p>
      ) : null}
      {expanded ? (
        <ul class={styles.voices}>
          {summary.voices.map((v) => (
            <li key={v.key} class={styles.voice}>
              <div>
                <span>
                  <strong>{voiceTitle(v, multiPart)}</strong>{' '}
                  {v.ambiguous ? (
                    <span class={styles.tag} data-tone="warning">
                      Split between staves
                    </span>
                  ) : null}
                </span>
                <small>
                  Notes: {describeStaffUse(v.notesPerStaff, staffCount) || 'none'}
                  {v.crossStaffBars.length > 0 && !v.ambiguous ? ` (${describeCrossStaff(v, staffCount)})` : ''}
                </small>
              </div>
              <Segmented
                compact
                label={`Hand for ${voiceTitle(v, multiPart)}`}
                value={draft.hands[v.key] ?? v.hand}
                options={HAND_OPTIONS}
                onChange={(hand) => setHand(v.key, hand)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        {!draft.handsConfirmed ? (
          <Button variant="primary" icon="check" onClick={() => onDraft({ ...draft, handsConfirmed: true })}>
            Confirm hands
          </Button>
        ) : editHands ? null : opened ? (
          <Button icon="check" onClick={() => setOpened(false)}>
            Done
          </Button>
        ) : (
          <Button icon="hand" onClick={() => setOpened(true)}>
            Change hands
          </Button>
        )}
      </div>
    </section>
  )
}

function TempoSection({
  summary,
  draft,
  gate,
  onDraft,
  tempoEntry,
}: {
  summary: Summary
  draft: ReviewDraft
  gate: ReviewGate
  onDraft: (d: ReviewDraft) => void
  tempoEntry: boolean
}) {
  const t = summary.tempo
  if (!tempoEntry && t.present && t.initial) {
    const changes = t.segments - 1
    return (
      <section class={styles.section} data-state="ok" aria-labelledby="import-tempo">
        <div class={styles.sectionHead}>
          <h4 id="import-tempo">Tempo</h4>
          <StateTag ok okText="From the score" needsText="" />
        </div>
        <p class={styles.tempoLine} aria-label={`${t.initial.beatUnitName} = ${formatBpm(t.initial.beatBpm)}`}>
          <BeatUnitIcon unit={t.initial.beatUnit} class={styles.tempoIcon} />
          <span>= {formatBpm(t.initial.beatBpm)}</span>
        </p>
        <p class={styles.muted}>
          {changes > 0
            ? `${changes} tempo change${changes === 1 ? '' : 's'} (quarter note ${formatBpm(t.minQuarterBpm ?? 0)}–${formatBpm(t.maxQuarterBpm ?? 0)} per minute).`
            : 'One tempo throughout.'}{' '}
          You can practice at any speed. This is the reference tempo.
        </p>
        {t.conflicts > 0 ? (
          <p class={styles.muted}>
            <span class={styles.tag} data-tone="warning">
              Review
            </span>{' '}
            {t.conflicts === 1 ? 'One place states' : `${t.conflicts} places state`} a playback tempo that disagrees
            with the printed metronome mark. The printed mark is used (see the warnings below).
          </p>
        ) : null}
      </section>
    )
  }
  const error = gate.tempoError
  return (
    <section
      class={styles.section}
      data-state={gate.blockers.some((b) => b.startsWith('Enter a practice tempo')) ? 'needs' : 'ok'}
      aria-labelledby="import-tempo"
    >
      <div class={styles.sectionHead}>
        <h4 id="import-tempo">Practice tempo</h4>
        <StateTag
          ok={!gate.blockers.some((b) => b.startsWith('Enter a practice tempo'))}
          okText="Set"
          needsText="Required"
        />
      </div>
      <p class={styles.muted}>
        The score has no numerical tempo (a word such as “Andante” is not enough to time your playing). Enter the tempo
        to practice at. You can still change the speed in Practice.
      </p>
      <div class={styles.tempoEntry}>
        <Segmented<BeatUnitChoice>
          compact
          label="Beat unit"
          value={draft.beatUnit}
          options={BEAT_UNIT_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
          onChange={(beatUnit) => onDraft({ ...draft, beatUnit })}
        />
        <label class={styles.bpmRow}>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="80"
            value={draft.bpmText}
            aria-label="Beats per minute"
            aria-invalid={error ? 'true' : undefined}
            onInput={(e) => onDraft({ ...draft, bpmText: (e.currentTarget as HTMLInputElement).value })}
          />
          <span>beats per minute</span>
        </label>
        {error ? (
          <p class={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function Check({
  title,
  count,
  tone,
  children,
}: {
  title: string
  count: string
  tone?: 'warning' | 'danger'
  children: ComponentChildren
}) {
  return (
    <details class={styles.check}>
      <summary>
        <span class={styles.chevron} aria-hidden="true">
          ›
        </span>
        <span>{title}</span>
        <span class={styles.tag} data-tone={tone}>
          {count}
        </span>
      </summary>
      <div class={styles.checkBody}>{children}</div>
    </details>
  )
}

function ScoreChecks({ summary }: { summary: Summary }) {
  const d = summary.diagnostics
  const errors = d.list.filter((x) => x.severity === 'error')
  const warnings = d.list.filter((x) => x.severity === 'warning')
  const infos = d.list.filter((x) => x.severity === 'info')
  const where = (m: { measure?: string }) => (m.measure ? `Bar ${m.measure}: ` : '')
  const r = summary.repeats
  const ch = summary.changes
  return (
    <section class={styles.checks} aria-labelledby="import-checks">
      <h4 id="import-checks" class={styles.sectionHead}>
        Score check
      </h4>
      {errors.length > 0 ? (
        <Check title="Errors" count={String(errors.length)} tone="danger">
          <ul>
            {errors.map((x, i) => (
              <li key={i}>{where(x) + x.message}</li>
            ))}
          </ul>
        </Check>
      ) : null}
      <Check
        title="Unsupported passages"
        count={summary.unsupported.length ? String(summary.unsupported.length) : 'None'}
        {...(summary.unsupported.length ? { tone: 'warning' as const } : {})}
      >
        {summary.unsupported.length ? (
          <>
            <p class={styles.muted}>
              You can view these bars, but they are left out of scored practice. No notes are dropped.
            </p>
            <ul>
              {summary.unsupported.map((u, i) => (
                <li key={i}>
                  {u.bars.includes('–') ? 'Bars' : 'Bar'} {u.bars}: {u.message}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p class={styles.muted}>Everything in the selected parts can be scored.</p>
        )}
      </Check>
      <Check
        title="Timing issues"
        count={summary.timingIssues.length ? String(summary.timingIssues.length) : 'None'}
        {...(summary.timingIssues.length ? { tone: 'warning' as const } : {})}
      >
        {summary.timingIssues.length ? (
          <>
            <p class={styles.muted}>
              Fermatas, rit. and similar marks have no exact duration, so timing is not scored across them.
            </p>
            <ul>
              {summary.timingIssues.map((t, i) => (
                <li key={i}>
                  Bar {t.bar}: {t.text}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p class={styles.muted}>No fermatas or verbal tempo changes.</p>
        )}
      </Check>
      <Check title="Ottava lines" count={summary.ottavas.length ? String(summary.ottavas.length) : 'None'}>
        {summary.ottavas.length ? (
          <ul>
            {summary.ottavas.map((o) => (
              <li key={o.index}>
                {o.label} on the {o.staff === 0 ? 'upper' : 'lower'} staff,{' '}
                {o.fromBar === o.toBar ? `bar ${o.fromBar}` : `bars ${o.fromBar}–${o.toBar}`} ({o.notes} notes)
              </li>
            ))}
          </ul>
        ) : (
          <p class={styles.muted}>No 8va, 8vb or 15ma lines.</p>
        )}
      </Check>
      <Check title="Rolled chords" count={summary.rolls.length ? String(summary.rolls.length) : 'None'}>
        {summary.rolls.length ? (
          <ul>
            {summary.rolls.map((g) => (
              <li key={g.index}>
                Bar {g.bar}: {g.pitches} notes, rolled {g.direction}
                {g.directionDefaulted ? ' (direction not marked)' : ''}
                {g.crossStaff ? ', across both staves' : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p class={styles.muted}>No arpeggiated chords.</p>
        )}
      </Check>
      <Check title="Repeats" count={r.unfolded ? `${r.repeatedBars.length} bars repeat` : 'None'}>
        {r.unfolded ? (
          <>
            <p class={styles.muted}>
              Repeats are played out in order. A repeated bar shows as, for example, “12 (pass 2)”.
            </p>
            <ul>
              {r.repeatedBars.slice(0, 12).map((b) => (
                <li key={b.bar}>
                  Bar {b.bar}: {b.passes} passes
                </li>
              ))}
              {r.repeatedBars.length > 12 ? <li>…and {r.repeatedBars.length - 12} more</li> : null}
            </ul>
            {r.endings.length ? <p class={styles.muted}>Endings: {r.endings.join(', ')}</p> : null}
          </>
        ) : (
          <p class={styles.muted}>The score plays straight through.</p>
        )}
      </Check>
      <Check title="Key, meter and clef changes" count={String(ch.keys + ch.meters + ch.clefs)}>
        <ul>
          <li>Key changes: {ch.keys}</li>
          <li>Meter changes: {ch.meters}</li>
          <li>Clef changes: {ch.clefs}</li>
          <li>Pedal marks: {summary.counts.pedalMarks}</li>
          <li>Dynamics: {summary.counts.dynamicMarks}</li>
          {summary.counts.graceNotes ? <li>Grace notes: {summary.counts.graceNotes}</li> : null}
          {summary.counts.cueNotes ? <li>Cue notes (not played): {summary.counts.cueNotes}</li> : null}
        </ul>
      </Check>
      <Check
        title="Warnings"
        count={warnings.length ? String(warnings.length) : 'None'}
        {...(warnings.length ? { tone: 'warning' as const } : {})}
      >
        {warnings.length ? (
          <ul>
            {warnings.map((x, i) => (
              <li key={i}>{where(x) + x.message}</li>
            ))}
          </ul>
        ) : (
          <p class={styles.muted}>No warnings.</p>
        )}
      </Check>
      {infos.length ? (
        <Check title="Notes from the importer" count={String(infos.length)}>
          <ul>
            {infos.map((x, i) => (
              <li key={i}>{where(x) + x.message}</li>
            ))}
          </ul>
        </Check>
      ) : null}
    </section>
  )
}
