import { msg } from '../../i18n/messages'
/**
 * Note names (spec "Persistent score labels"): Off, All or Conditional with per-clef rules, and
 * whether tie continuations are labeled (U69). Everything here is staged in `labelDraft` and applies only on Apply, which calls the
 * `onBeforeApplyLabels` hook first so a scored attempt is interrupted before new labels appear.
 */
import { useEffect, useState } from 'preact/hooks'
import { DISABLED_RULE, type PersistentLabelMode } from '../../core/model/settings'
import { Button, Segmented, Toggle } from '../../ui/controls'
import {
  applyLabelDraft,
  clefKeysOf,
  currentLabels,
  discardLabelDraft,
  draftProblems,
  isLabelDraftDirty,
  setDraftMode,
  setDraftRule,
  setDraftTiedContinuations,
} from './labelDraft'
import { Group, Help, Setting } from './parts'
import { RuleEditor, type TextErrors } from './RuleEditor'
import styles from './settings.module.css'

/** The Conditional rules, which the score's menu opens Settings at (`openNoteRules`). */
export const NOTE_RULES_ID = 'settings-note-rules'

const MODE_HELP: Readonly<Record<PersistentLabelMode, string>> = {
  off: 'No names are shown on the score. Hints still appear after mistakes or when you ask.',
  all: 'Every note on both staves is labeled, including chords and notes ahead of the cursor.',
  conditional: 'Only notes that meet the rules below for their clef are labeled.',
}

export function LabelsSection() {
  const labels = currentLabels()
  const dirty = isLabelDraftDirty()
  const problems = draftProblems(labels)
  const [textErrors, setTextErrors] = useState<Readonly<Record<string, TextErrors>>>({})
  const [applied, setApplied] = useState(false)

  useEffect(() => {
    if (dirty) setApplied(false)
  }, [dirty])

  // Rule editors unmount outside Conditional mode, taking their typed text with them.
  useEffect(() => {
    if (labels.mode !== 'conditional') setTextErrors({})
  }, [labels.mode])

  const clefs = clefKeysOf(labels)
  const typingProblem =
    labels.mode === 'conditional' &&
    clefs.some((clef) => {
      const rule = labels.rules[clef] ?? DISABLED_RULE
      const errors = textErrors[clef] ?? {}
      return (rule.below.enabled && errors.below !== undefined) || (rule.above.enabled && errors.above !== undefined)
    })
  const blocked = problems.length > 0 || typingProblem
  const canApply = dirty && !blocked

  return (
    <>
      <Group>
        <Setting label={msg('Note names on the score')} description={msg(MODE_HELP[labels.mode])}>
          <Segmented
            label={msg('Note names on the score')}
            value={labels.mode}
            options={[
              { value: 'off', label: msg('Off') },
              { value: 'conditional', label: msg('Conditional') },
              { value: 'all', label: msg('All') },
            ]}
            onChange={setDraftMode}
          />
        </Setting>
        {labels.mode !== 'off' ? (
          <Toggle
            label={msg('Label tied notes')}
            description={msg('Also name the later notes of a tie, which are held rather than played.')}
            checked={labels.tiedContinuations}
            onChange={setDraftTiedContinuations}
          />
        ) : null}
        <Help>
          {msg(
            'Visible note names count as assistance in your practice results. Applying a change during a scored attempt interrupts that attempt.',
          )}
        </Help>
      </Group>

      {labels.mode === 'conditional' ? (
        <div id={NOTE_RULES_ID} class={styles.rules} role="group" aria-label={msg('Choose which notes')} tabIndex={-1}>
          {clefs.map((clef) => (
            <RuleEditor
              key={clef}
              clef={clef}
              rule={labels.rules[clef] ?? DISABLED_RULE}
              textErrors={textErrors[clef] ?? {}}
              onRuleChange={(rule) => setDraftRule(clef, rule)}
              onTextErrors={(errors) => setTextErrors((all) => ({ ...all, [clef]: errors }))}
            />
          ))}
        </div>
      ) : null}

      <div class={styles.applyBar}>
        <div class={styles.applyStatus} role="status" aria-live="polite">
          {dirty
            ? blocked
              ? msg('Fix the highlighted problems to apply these changes.')
              : msg('These changes are not applied yet.')
            : applied
              ? msg('Note names applied.')
              : ''}
        </div>
        <div class={styles.applyButtons}>
          {dirty ? (
            <Button
              variant="ghost"
              aria-label={msg('Discard changes')}
              onClick={() => {
                discardLabelDraft()
                setTextErrors({})
              }}
            >
              {msg('Discard')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            aria-label={msg('Apply note name changes')}
            disabled={!canApply}
            onClick={() => {
              if (applyLabelDraft()) setApplied(true)
              setTextErrors({})
            }}
          >
            {msg('Apply')}
          </Button>
        </div>
      </div>
    </>
  )
}
