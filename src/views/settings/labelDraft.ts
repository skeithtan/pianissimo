/**
 * Staged edits to the persistent-label settings (spec "Persistent score labels": the mode and the
 * per-clef rules take effect only when applied, because applying during a scored attempt
 * interrupts it). Naming-only preferences bypass this and apply immediately.
 */
import { signal } from '@preact/signals'
import type { ClefKey } from '../../core/model/score'
import {
  DISABLED_RULE,
  type ClefLabelRule,
  type PersistentLabelMode,
  type PersistentLabelSettings,
} from '../../core/model/settings'
import { clefDisplayName, validateRule } from '../../core/naming'
import { applyLabelSettings, settings } from '../../app/state'
import { deepEqual } from '../../app/settingsMerge'

/** The staged copy, or null while the settings screen simply shows what is applied. */
export const labelDraft = signal<PersistentLabelSettings | null>(null)

/** What the label controls show: the staged edits if any, otherwise the applied settings. */
export function currentLabels(): PersistentLabelSettings {
  return labelDraft.value ?? settings.value.labels
}

export function isLabelDraftDirty(): boolean {
  const draft = labelDraft.peek()
  return draft !== null && !deepEqual(draft, settings.peek().labels)
}

export function discardLabelDraft(): void {
  labelDraft.value = null
}

function stage(update: (current: PersistentLabelSettings) => PersistentLabelSettings): void {
  const base = labelDraft.peek() ?? settings.peek().labels
  const next = update(base)
  labelDraft.value = deepEqual(next, settings.peek().labels) ? null : next
}

export function setDraftMode(mode: PersistentLabelMode): void {
  stage((current) => ({ ...current, mode }))
}

export function setDraftTiedContinuations(tiedContinuations: boolean): void {
  stage((current) => ({ ...current, tiedContinuations }))
}

export function setDraftRule(clef: ClefKey, rule: ClefLabelRule): void {
  stage((current) => ({ ...current, rules: { ...current.rules, [clef]: rule } }))
}

/** Clef keys to show rule editors for: treble and bass first, then any others in key order. */
export function clefKeysOf(labels: PersistentLabelSettings): ClefKey[] {
  const preferred = ['G2', 'F4']
  const others = Object.keys(labels.rules)
    .filter((k) => !preferred.includes(k))
    .sort()
  return [...preferred, ...others]
}

export interface DraftProblem {
  readonly clef: ClefKey
  readonly message: string
}

/** Problems that block applying. Rules only matter in Conditional mode (spec: reject invalid pitches and reversed bounds). */
export function draftProblems(labels: PersistentLabelSettings): DraftProblem[] {
  if (labels.mode !== 'conditional') return []
  return clefKeysOf(labels).flatMap((clef) =>
    validateRule(labels.rules[clef] ?? DISABLED_RULE).issues.map((issue) => ({
      clef,
      message: `${clefDisplayName(clef)}: ${issue.message}`,
    })),
  )
}

/**
 * Apply the staged labels through `applyLabelSettings`, which runs the `onBeforeApplyLabels` hook
 * (interrupting a scored attempt) first. Returns false, leaving the draft in place, when it has
 * blocking problems or nothing changed.
 */
export function applyLabelDraft(): boolean {
  const draft = labelDraft.peek()
  if (!draft || draftProblems(draft).length > 0) return false
  const changed = applyLabelSettings(draft)
  labelDraft.value = null
  return changed
}
