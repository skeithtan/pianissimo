import { importMessage } from '../../i18n/importMessage'
import { msg } from '../../i18n/messages'
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
import { Button, Notice, Segmented } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { formatBpm } from '../../ui/speed'
import {
  BEAT_UNIT_CHOICES,
  describeCrossStaff,
  describeStaffUse,
  handLines,
  importIssues,
  parsePracticeBpm,
  type BeatUnitChoice,
  type ReviewDraft,
  type ReviewGate,
} from './review'
import styles from './library.module.css'
import importStyles from './import.module.css'

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
  compact = false,
}: {
  summary: Summary
  draft: ReviewDraft
  gate: ReviewGate
  onDraft: (next: ReviewDraft) => void
  /** The practice tempo is typed here (no tempo in the score; also when reviewing a stored piece). */
  tempoEntry?: boolean
  /** Show every voice's hand control from the start (reviewing a stored piece, L5). */
  editHands?: boolean
  /** Import starts with the useful facts; the full report remains available on demand. */
  compact?: boolean
}) {
  const c = summary.counts
  const bars = c.occurrences === c.measures ? `${c.measures}` : msg('{0} ({1} played)', c.measures, c.occurrences)
  const needsHands = !summary.handsConfirmed
  const assignedHands = handLines(summary.voices, draft.hands).filter((line) => line.notes > 0)
  const facts = (
    <dl class={styles.facts} aria-label={msg('Score contents')}>
      <Fact label={msg('Bars')} value={bars} />
      <Fact label={msg('Notes')} value={String(c.performedNotes)} />
      <Fact label={msg('Chords')} value={String(c.chords)} />
      <Fact label={msg('Voices')} value={String(c.voices)} />
      <Fact label={msg('Ties')} value={String(c.tiedContinuations)} />
      <Fact label={msg('Tuplet notes')} value={String(c.tupletNotes)} />
    </dl>
  )
  const hands = <HandsSection summary={summary} draft={draft} onDraft={onDraft} editHands={editHands} />
  const tempo = <TempoSection summary={summary} draft={draft} gate={gate} onDraft={onDraft} tempoEntry={tempoEntry} />
  return (
    <div class={styles.summary}>
      <header class={styles.summaryHead}>
        <h3>{summary.title}</h3>
        {summary.composer ? <p class={styles.composer}>{summary.composer}</p> : null}
        <p class={styles.muted}>
          {summary.parts
            .map((p) => `${p.name} (${p.staffCount} ${p.staffCount === 1 ? msg('staff') : msg('staves')})`)
            .join(' + ')}
        </p>
      </header>

      {compact ? (
        <>
          {summary.diagnostics.errors > 0 ? (
            <Notice tone="danger">
              <strong>{msg('This score needs a correction before it can be added.')}</strong>
              <ul class={importStyles.issues}>
                {summary.diagnostics.list
                  .filter((d) => d.severity === 'error')
                  .map((d, i) => (
                    <li key={i}>
                      {d.measure ? msg('Bar {0}: ', d.measure) : ''}
                      {importMessage(d.message)}
                    </li>
                  ))}
              </ul>
            </Notice>
          ) : null}
          {needsHands ? hands : null}
          {tempoEntry ? tempo : null}
          {gate.canSave ? (
            <p class={importStyles.ready}>
              <Icon name="check" size={18} />
              {msg('Ready to open')}
            </p>
          ) : null}
          <dl class={importStyles.overview}>
            {!needsHands ? (
              <div>
                <dt>{msg('Hands')}</dt>
                <dd>
                  {assignedHands.length === 2
                    ? msg('Both hands assigned')
                    : assignedHands[0]?.hand === 'R'
                      ? msg('Right hand assigned')
                      : msg('Left hand assigned')}
                </dd>
              </div>
            ) : null}
            {!tempoEntry && summary.tempo.initial ? (
              <div>
                <dt>{msg('Tempo from the score')}</dt>
                <dd
                  class={importStyles.tempo}
                  aria-label={`${msg(summary.tempo.initial.beatUnitName)} = ${formatBpm(summary.tempo.initial.beatBpm)}`}
                >
                  <BeatUnitIcon unit={summary.tempo.initial.beatUnit} />
                  <span>= {formatBpm(summary.tempo.initial.beatBpm)}</span>
                </dd>
              </div>
            ) : null}
          </dl>
          <ImportIssues summary={summary} />
          <details class={importStyles.details}>
            <summary>{msg('Import details')}</summary>
            <div class={importStyles.detailsBody}>
              {!needsHands ? hands : null}
              {!tempoEntry ? tempo : null}
              {facts}
              <ScoreChecks summary={summary} />
            </div>
          </details>
        </>
      ) : (
        <>
          {facts}
          {hands}
          {tempo}
          <ScoreChecks summary={summary} />
        </>
      )}
    </div>
  )
}

/** Report anything that changes what the player can practice before the optional technical report. */
function ImportIssues({ summary }: { summary: Summary }) {
  const { warnings, unsupported, timingIssues, tempoConflicts, any } = importIssues(summary)
  if (!any) return null
  return (
    <Notice tone="warning">
      <strong>{msg('Before you play')}</strong>
      <ul class={importStyles.issues}>
        {unsupported.map((passage, i) => (
          <li key={`unsupported-${i}`}>
            {passage.bars.includes('–') ? msg('Bars') : msg('Bar')} {passage.bars}: {importMessage(passage.message)}{' '}
            {msg('You can view this passage, but it cannot be scored.')}
          </li>
        ))}
        {timingIssues.length ? (
          <li>
            {msg(
              timingIssues.length === 1
                ? 'Timing is not scored across the timing mark in bar {0}.'
                : 'Timing is not scored across the timing marks in bars {0}.',
              timingIssues.map((issue) => issue.bar).join(', '),
            )}
          </li>
        ) : null}
        {tempoConflicts ? (
          <li>{msg('Some playback tempos differ from the printed marks. The printed tempos are used.')}</li>
        ) : null}
        {warnings.map((warning, i) => (
          <li key={`warning-${i}`}>
            {warning.measure ? msg('Bar {0}: ', warning.measure) : ''}
            {importMessage(warning.message)}
          </li>
        ))}
      </ul>
    </Notice>
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
  return multiPart ? msg('Voice {0} · {1}', v.voice, v.partName) : msg('Voice {0}', v.voice)
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
        <h4 id="import-hands">{msg('Hands')}</h4>
        <StateTag ok={draft.handsConfirmed} okText={msg('From the score')} needsText={msg('Needs your confirmation')} />
      </div>
      {!draft.handsConfirmed ? (
        <p class={styles.muted}>
          {ambiguous.length === 1
            ? msg(
                'One voice has notes on both staves in similar numbers, so the file does not say which hand plays it. Choose a hand, then confirm.',
              )
            : msg(
                'Some voices have notes on both staves in similar numbers, so the file does not say which hand plays them. Choose a hand, then confirm.',
              )}
        </p>
      ) : (
        <ul class={styles.handLines} aria-label={msg('Hands')}>
          {handLines(summary.voices, draft.hands).map((line) => (
            <li key={line.hand} data-hand={line.hand}>
              <strong>{line.hand === 'R' ? msg('Right hand') : msg('Left hand')}</strong>
              <span>
                {line.voices ? `${line.voices[0]!.toUpperCase()}${line.voices.slice(1)}` : msg('No voices')}
                {line.notes ? msg(' · {0} notes', line.notes) : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {draft.handsConfirmed && !editing && crossStaff.length > 0 ? (
        <p class={styles.muted}>
          {crossStaff
            .map((v) => msg('{0} stays one hand: {1}.', voiceTitle(v, multiPart), describeCrossStaff(v, staffCount)))
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
                      {msg('Split between staves')}
                    </span>
                  ) : null}
                </span>
                <small>
                  {msg('Notes:')} {describeStaffUse(v.notesPerStaff, staffCount) || msg('none')}
                  {v.crossStaffBars.length > 0 && !v.ambiguous ? ` (${describeCrossStaff(v, staffCount)})` : ''}
                </small>
              </div>
              <Segmented
                compact
                label={msg('Hand for {0}', voiceTitle(v, multiPart))}
                value={draft.hands[v.key] ?? v.hand}
                options={HAND_OPTIONS.map((o) => ({ ...o, label: msg(o.label) }))}
                onChange={(hand) => setHand(v.key, hand)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        {!draft.handsConfirmed ? (
          <Button variant="primary" icon="check" onClick={() => onDraft({ ...draft, handsConfirmed: true })}>
            {msg('Confirm hands')}
          </Button>
        ) : editHands ? null : opened ? (
          <Button icon="check" onClick={() => setOpened(false)}>
            {msg('Done')}
          </Button>
        ) : (
          <Button icon="hand" onClick={() => setOpened(true)}>
            {msg('Change hands')}
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
          <h4 id="import-tempo">{msg('Tempo')}</h4>
          <StateTag ok okText={msg('From the score')} needsText="" />
        </div>
        <p class={styles.tempoLine} aria-label={`${msg(t.initial.beatUnitName)} = ${formatBpm(t.initial.beatBpm)}`}>
          <BeatUnitIcon unit={t.initial.beatUnit} class={styles.tempoIcon} />
          <span>= {formatBpm(t.initial.beatBpm)}</span>
        </p>
        <p class={styles.muted}>
          {changes > 0
            ? msg(
                '{0} tempo change{1} (quarter note {2}–{3} per minute).',
                changes,
                changes === 1 ? '' : 's',
                formatBpm(t.minQuarterBpm ?? 0),
                formatBpm(t.maxQuarterBpm ?? 0),
              )
            : msg('One tempo throughout.')}{' '}
          {msg('You can practice at any speed. This is the reference tempo.')}
        </p>
        {t.conflicts > 0 ? (
          <p class={styles.muted}>
            <span class={styles.tag} data-tone="warning">
              {msg('Review')}
            </span>{' '}
            {t.conflicts === 1 ? msg('One place states') : msg('{0} places state', t.conflicts)}{' '}
            {msg(
              'a playback tempo that disagrees with the printed metronome mark. The printed mark is used (see the warnings below).',
            )}
          </p>
        ) : null}
      </section>
    )
  }
  const error = gate.tempoError
  return (
    <section
      class={styles.section}
      data-state={typeof parsePracticeBpm(draft.bpmText) === 'string' ? 'needs' : 'ok'}
      aria-labelledby="import-tempo"
    >
      <div class={styles.sectionHead}>
        <h4 id="import-tempo">{msg('Practice tempo')}</h4>
        <StateTag
          ok={typeof parsePracticeBpm(draft.bpmText) !== 'string'}
          okText={msg('Tempo set')}
          needsText={msg('Required')}
        />
      </div>
      <p class={styles.muted}>
        {msg(
          'This score has no numerical tempo. Choose a tempo and beat unit to begin. You can adjust the speed in Practice.',
        )}
      </p>
      <div class={styles.tempoEntry}>
        <Segmented<BeatUnitChoice>
          compact
          label={msg('Beat unit')}
          value={draft.beatUnit}
          options={BEAT_UNIT_CHOICES.map((c) => ({ value: c.value, label: msg(c.label) }))}
          onChange={(beatUnit) => onDraft({ ...draft, beatUnit })}
        />
        <label class={styles.bpmRow}>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="80"
            value={draft.bpmText}
            aria-label={msg('Beats per minute')}
            aria-invalid={error ? 'true' : undefined}
            onInput={(e) => onDraft({ ...draft, bpmText: (e.currentTarget as HTMLInputElement).value })}
          />
          <span>{msg('beats per minute')}</span>
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
  const where = (m: { measure?: string }) => (m.measure ? msg('Bar {0}: ', m.measure) : '')
  const r = summary.repeats
  const ch = summary.changes
  return (
    <section class={styles.checks} aria-labelledby="import-checks">
      <h4 id="import-checks" class={styles.sectionHead}>
        {msg('Score check')}
      </h4>
      {errors.length > 0 ? (
        <Check title={msg('Errors')} count={String(errors.length)} tone="danger">
          <ul>
            {errors.map((x, i) => (
              <li key={i}>{where(x) + importMessage(x.message)}</li>
            ))}
          </ul>
        </Check>
      ) : null}
      <Check
        title={msg('Unsupported passages')}
        count={summary.unsupported.length ? String(summary.unsupported.length) : msg('None found')}
        {...(summary.unsupported.length ? { tone: 'warning' as const } : {})}
      >
        {summary.unsupported.length ? (
          <>
            <p class={styles.muted}>
              {msg('You can view these bars, but they are left out of scored practice. No notes are dropped.')}
            </p>
            <ul>
              {summary.unsupported.map((u, i) => (
                <li key={i}>
                  {u.bars.includes('–') ? msg('Bars') : msg('Bar')} {u.bars}: {importMessage(u.message)}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p class={styles.muted}>{msg('Everything in the selected parts can be scored.')}</p>
        )}
      </Check>
      <Check
        title={msg('Timing issues')}
        count={summary.timingIssues.length ? String(summary.timingIssues.length) : msg('None found')}
        {...(summary.timingIssues.length ? { tone: 'warning' as const } : {})}
      >
        {summary.timingIssues.length ? (
          <>
            <p class={styles.muted}>
              {msg('Fermatas, rit. and similar marks have no exact duration, so timing is not scored across them.')}
            </p>
            <ul>
              {summary.timingIssues.map((t, i) => (
                <li key={i}>
                  {msg('Bar')} {t.bar}: {importMessage(t.text)}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p class={styles.muted}>{msg('No fermatas or verbal tempo changes.')}</p>
        )}
      </Check>
      <Check
        title={msg('Ottava lines')}
        count={summary.ottavas.length ? String(summary.ottavas.length) : msg('None found')}
      >
        {summary.ottavas.length ? (
          <ul>
            {summary.ottavas.map((o) => (
              <li key={o.index}>
                {msg(
                  o.staff === 0 ? '{0} on the upper staff, {1} ({2})' : '{0} on the lower staff, {1} ({2})',
                  o.label,
                  o.fromBar === o.toBar ? msg('bar {0}', o.fromBar) : msg('bars {0}–{1}', o.fromBar, o.toBar),
                  msg(o.notes === 1 ? '{0} note' : '{0} notes', o.notes),
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p class={styles.muted}>{msg('No 8va, 8vb or 15ma lines.')}</p>
        )}
      </Check>
      <Check
        title={msg('Rolled chords')}
        count={summary.rolls.length ? String(summary.rolls.length) : msg('None found')}
      >
        {summary.rolls.length ? (
          <ul>
            {summary.rolls.map((g) => (
              <li key={g.index}>
                {msg('Bar')} {g.bar}: {g.pitches} {msg('notes, rolled')} {msg(g.direction)}
                {g.directionDefaulted ? msg(' (direction not marked)') : ''}
                {g.crossStaff ? msg(', across both staves') : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p class={styles.muted}>{msg('No arpeggiated chords.')}</p>
        )}
      </Check>
      <Check
        title={msg('Repeats')}
        count={r.unfolded ? msg('{0} bars repeat', r.repeatedBars.length) : msg('None found')}
      >
        {r.unfolded ? (
          <>
            <p class={styles.muted}>
              {msg('Repeats are played out in order. A repeated bar shows as, for example, “12 (pass 2)”.')}
            </p>
            <ul>
              {r.repeatedBars.slice(0, 12).map((b) => (
                <li key={b.bar}>
                  {msg('Bar')} {b.bar}: {b.passes} {msg('passes')}
                </li>
              ))}
              {r.repeatedBars.length > 12 ? <li>{msg('…and {0} more', r.repeatedBars.length - 12)}</li> : null}
            </ul>
            {r.endings.length ? (
              <p class={styles.muted}>
                {msg('Endings:')} {r.endings.join(', ')}
              </p>
            ) : null}
          </>
        ) : (
          <p class={styles.muted}>{msg('The score plays straight through.')}</p>
        )}
      </Check>
      <Check title={msg('Key, meter and clef changes')} count={String(ch.keys + ch.meters + ch.clefs)}>
        <ul>
          <li>
            {msg('Key changes:')} {ch.keys}
          </li>
          <li>
            {msg('Meter changes:')} {ch.meters}
          </li>
          <li>
            {msg('Clef changes:')} {ch.clefs}
          </li>
          <li>
            {msg('Pedal marks:')} {summary.counts.pedalMarks}
          </li>
          <li>
            {msg('Dynamics:')} {summary.counts.dynamicMarks}
          </li>
          {summary.counts.graceNotes ? (
            <li>
              {msg('Grace notes:')} {summary.counts.graceNotes}
            </li>
          ) : null}
          {summary.counts.cueNotes ? (
            <li>
              {msg('Cue notes (not played):')} {summary.counts.cueNotes}
            </li>
          ) : null}
        </ul>
      </Check>
      <Check
        title={msg('Warnings')}
        count={warnings.length ? String(warnings.length) : msg('None found')}
        {...(warnings.length ? { tone: 'warning' as const } : {})}
      >
        {warnings.length ? (
          <ul>
            {warnings.map((x, i) => (
              <li key={i}>{where(x) + importMessage(x.message)}</li>
            ))}
          </ul>
        ) : (
          <p class={styles.muted}>{msg('No warnings.')}</p>
        )}
      </Check>
      {infos.length ? (
        <Check title={msg('Notes from the importer')} count={String(infos.length)}>
          <ul>
            {infos.map((x, i) => (
              <li key={i}>{where(x) + importMessage(x.message)}</li>
            ))}
          </ul>
        </Check>
      ) : null}
    </section>
  )
}
