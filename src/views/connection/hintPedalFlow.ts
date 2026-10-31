/**
 * "Set hint pedal" flow (spec "MIDI input, output, and pedal controls"): the user presses the
 * desired pedal, the app observes its message, and a test confirms the mapping. Prefer the
 * middle pedal when it sends a usable message. Trigger once per press, requiring release before
 * another trigger; inversion and threshold are adjustable. Framework-free over the core/midi
 * learner, confirmation and trigger.
 *
 * Phases: idle → listening → (pedal pressed and released) confirming → pressed → confirmed.
 * Until confirmed, a middle pedal pressed and released after another pedal replaces the
 * proposal. Adjusting inversion or threshold returns to confirming (a changed mapping is untested).
 */
import {
  HintPedalConfirmation,
  HintPedalLearner,
  HintPedalTrigger,
  withInversion,
  withThreshold,
  type LearnedHintPedal,
} from '../../core/midi/hintPedal'
import { CC_SOSTENUTO, type MidiInputEvent } from '../../core/midi/types'
import type { HintPedalMapping } from '../../core/model/settings'

export type HintPedalPhase = 'idle' | 'listening' | 'confirming' | 'pressed' | 'confirmed'

/** Current controller value if known (`PhysicalState.observedValue`). */
export type ValueLookup = (controller: number, channel: number) => number | undefined

export class HintPedalSetup {
  private phaseValue: HintPedalPhase = 'idle'
  private learner: HintPedalLearner | null = null
  private learned: LearnedHintPedal | null = null
  private mappingValue: HintPedalMapping | null = null
  private confirmation: HintPedalConfirmation | null = null
  private counter: HintPedalTrigger | null = null
  private presses = 0
  private middleSeen = false
  private readonly lookup: ValueLookup

  constructor(lookup: ValueLookup = () => undefined) {
    this.lookup = lookup
  }

  get phase(): HintPedalPhase {
    return this.phaseValue
  }

  /** The proposed (or adjusted) mapping; `verified` once the test press succeeded. */
  get mapping(): HintPedalMapping | null {
    return this.mappingValue
  }

  /** What the learner chose and why (null until a pedal was pressed and released). */
  get detected(): LearnedHintPedal | null {
    return this.learned
  }

  /** Hint triggers counted since the test began (one per press, never while held). */
  get triggerCount(): number {
    return this.presses
  }

  /** A CC 66 message arrived at any point (false → the middle pedal may not be transmitted). */
  get middlePedalSeen(): boolean {
    return this.middleSeen
  }

  /** Start listening for the pedal the user presses. */
  start(): void {
    this.learner = new HintPedalLearner({ baseline: this.lookup })
    this.learned = null
    this.mappingValue = null
    this.confirmation = null
    this.counter = null
    this.presses = 0
    this.middleSeen = false
    this.phaseValue = 'listening'
  }

  /** Test an existing mapping (e.g. the saved one) without learning again. */
  test(mapping: HintPedalMapping): void {
    this.learner = null
    this.learned = null
    this.beginConfirmation({ ...mapping, verified: false })
  }

  /** Change inversion and/or threshold; the mapping must be tested again. */
  adjust(change: { inverted?: boolean; threshold?: number }): void {
    let m = this.mappingValue
    if (!m) return
    if (change.inverted !== undefined) m = withInversion(m, change.inverted)
    if (change.threshold !== undefined) m = withThreshold(m, change.threshold)
    this.beginConfirmation(m)
  }

  cancel(): void {
    this.learner = null
    this.confirmation = null
    this.counter = null
    this.phaseValue = this.mappingValue?.verified ? 'confirmed' : 'idle'
  }

  /** Feed every input event while the flow is active. Returns true when something visible changed. */
  feed(ev: MidiInputEvent): boolean {
    if (ev.kind !== 'cc') return false
    let changed = false
    if (ev.controller === CC_SOSTENUTO && !this.middleSeen) {
      this.middleSeen = true
      changed = true
    }
    if (this.phaseValue === 'listening' && this.learner) {
      this.learner.feed(ev)
      const candidate = this.learner.candidate()
      if (candidate?.complete) {
        this.learned = candidate
        this.beginConfirmation(candidate.mapping)
        return true
      }
      return changed || candidate !== null
    }
    // Still learning in the background: a middle pedal pressed after another one wins.
    if (this.learner && this.phaseValue !== 'confirmed' && this.mappingValue?.controller !== CC_SOSTENUTO) {
      this.learner.feed(ev)
      const candidate = this.learner.candidate()
      if (candidate?.complete && candidate.mapping.controller === CC_SOSTENUTO) {
        this.learned = candidate
        this.beginConfirmation(candidate.mapping)
        return true
      }
    }
    if (this.counter?.feed(ev)) {
      this.presses++
      changed = true
    }
    if (this.confirmation && (this.phaseValue === 'confirming' || this.phaseValue === 'pressed')) {
      const status = this.confirmation.feed(ev)
      const next: HintPedalPhase = status === 'waiting' ? 'confirming' : status
      if (next !== this.phaseValue) {
        this.phaseValue = next
        changed = true
        const result = this.confirmation.result()
        if (result) this.mappingValue = result
      }
    }
    return changed
  }

  private beginConfirmation(mapping: HintPedalMapping): void {
    this.mappingValue = mapping
    const current = mapping.channel === null ? undefined : this.lookup(mapping.controller, mapping.channel)
    this.confirmation = new HintPedalConfirmation(mapping, current)
    this.counter = new HintPedalTrigger(mapping, current)
    this.presses = 0
    this.phaseValue = 'confirming'
  }
}
