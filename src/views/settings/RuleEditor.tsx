/**
 * One clef's conditional label rule (spec "Persistent score labels"): independent Show below and
 * Show above conditions with strict comparisons, validation, a plain-language summary and a live
 * sample of which pitches would be labeled. Editing stages the rule; nothing applies until the
 * Labels section's Apply button.
 */
import type { ClefKey } from '../../core/model/score'
import { TREBLE_PRESET, type ClefLabelRule, type LabelCondition } from '../../core/model/settings'
import { clefDisplayName, describeRule, formatSpelling, sampleRule, validateRule } from '../../core/naming'
import { deepEqual } from '../../app/settingsMerge'
import { Button, Toggle } from '../../ui/controls'
import { PitchInput, type PitchEdit } from './PitchInput'
import styles from './settings.module.css'

type ConditionKey = 'below' | 'above'

export type TextErrors = Partial<Record<ConditionKey, string>>

const CONDITION_COPY: Readonly<Record<ConditionKey, { title: string; wording: string }>> = {
  below: { title: 'Show below', wording: 'lower than' },
  above: { title: 'Show above', wording: 'higher than' },
}

function Condition({
  clef,
  which,
  condition,
  error,
  onChange,
  onTextError,
}: {
  clef: ClefKey
  which: ConditionKey
  condition: LabelCondition
  error: string | null
  onChange: (next: LabelCondition) => void
  onTextError: (message: string | null) => void
}) {
  const copy = CONDITION_COPY[which]
  const pitch = condition.threshold ? formatSpelling(condition.threshold) : null
  return (
    <div class={styles.condition}>
      <Toggle
        label={copy.title}
        description={`Label notes ${copy.wording} a pitch you choose.`}
        checked={condition.enabled}
        onChange={(enabled) => onChange({ ...condition, enabled })}
      />
      <div class={styles.conditionPitch}>
        <PitchInput
          label={`${clefDisplayName(clef)} ${copy.title.toLowerCase()} pitch`}
          value={condition.threshold}
          disabled={!condition.enabled}
          error={condition.enabled ? error : null}
          onEdit={(edit: PitchEdit) => {
            onTextError(edit.error)
            if (!deepEqual(edit.spelling, condition.threshold)) onChange({ ...condition, threshold: edit.spelling })
          }}
        />
        {condition.enabled && pitch && !error ? (
          <span class={styles.strict}>
            Notes {copy.wording} {pitch} are labeled. {pitch} itself is not.
          </span>
        ) : null}
      </div>
      {condition.enabled && error ? (
        <p class={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function RuleEditor({
  clef,
  rule,
  textErrors,
  onRuleChange,
  onTextErrors,
}: {
  clef: ClefKey
  rule: ClefLabelRule
  textErrors: TextErrors
  onRuleChange: (rule: ClefLabelRule) => void
  onTextErrors: (errors: TextErrors) => void
}) {
  const validation = validateRule(rule)
  const issueFor = (field: ConditionKey): string | null =>
    validation.issues.find((i) => i.field === field)?.message ?? null
  const rangeIssue = validation.issues.find((i) => i.field === 'range')?.message ?? null
  const setTextError = (which: ConditionKey, message: string | null) => {
    const next: TextErrors = { ...textErrors }
    if (message === null) delete next[which]
    else next[which] = message
    if (!deepEqual(next, textErrors)) onTextErrors(next)
  }
  const isTreble = clef === 'G2'
  return (
    <div class={styles.rule} role="group" aria-label={`${clefDisplayName(clef)} label rule`}>
      <h4 class={styles.groupTitle}>{clefDisplayName(clef)}</h4>
      <Condition
        clef={clef}
        which="below"
        condition={rule.below}
        error={textErrors.below ?? issueFor('below')}
        onChange={(below) => onRuleChange({ ...rule, below })}
        onTextError={(m) => setTextError('below', m)}
      />
      <Condition
        clef={clef}
        which="above"
        condition={rule.above}
        error={textErrors.above ?? issueFor('above')}
        onChange={(above) => onRuleChange({ ...rule, above })}
        onTextError={(m) => setTextError('above', m)}
      />
      {rangeIssue ? (
        <p class={styles.error} role="alert">
          {rangeIssue}
        </p>
      ) : null}
      {isTreble && !deepEqual(rule, TREBLE_PRESET) ? (
        <div>
          <Button variant="ghost" onClick={() => onRuleChange(TREBLE_PRESET)}>
            Use preset: below C4 or above C5
          </Button>
        </div>
      ) : null}
      {clef === 'F4' && !rule.below.enabled && !rule.above.enabled ? (
        <p class={styles.help}>
          Bass thresholds stay unset until you choose them. Treble settings are never copied here.
        </p>
      ) : null}
      <p class={styles.summary} data-testid={`summary-${clef}`}>
        {describeRule(rule, clef)}
      </p>
      <Sample clef={clef} rule={rule} />
    </div>
  )
}

function Sample({ clef, rule }: { clef: ClefKey; rule: ClefLabelRule }) {
  const pitches = sampleRule(rule, clef)
  return (
    <div>
      <ol class={styles.sample} aria-label={`Sample notes for ${clefDisplayName(clef)}`}>
        {pitches.map((p) => (
          <li
            key={p.midi}
            class={styles.samplePitch}
            data-labeled={p.labeled}
            data-threshold={p.isThreshold || undefined}
            title={p.isThreshold ? 'Boundary pitch' : undefined}
          >
            <span aria-hidden="true">{p.labeled ? '●' : '○'}</span>
            <span>{p.text}</span>
            <span class="visually-hidden">{p.labeled ? ' labeled' : ' not labeled'}</span>
          </li>
        ))}
      </ol>
      <p class={styles.legend}>
        <span aria-hidden="true">{'●'}</span> labeled · <span aria-hidden="true">{'○'}</span> not labeled
      </p>
    </div>
  )
}
