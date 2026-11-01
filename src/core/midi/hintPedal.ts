/**
 * "Set hint pedal" learning and the once-per-press trigger (spec "MIDI input, output, and
 * pedal controls"): the user presses the desired pedal, the app observes its message, and a
 * test press confirms the mapping. Prefer the middle pedal (CC 66) when it sends a usable
 * message. Trigger once per press, requiring release before another trigger. Inversion and
 * threshold are configurable. Pure logic: feed decoded events, read results.
 */
import type { HintPedalMapping } from '../model/settings'
import { CC_SOSTENUTO, type MidiInputEvent } from './types'

export const NO_MIDDLE_PEDAL_EXPLANATION =
  'Your piano did not send a message for its middle pedal. You can assign another pedal, ' +
  'or keep using the on-screen Hint button, which always remains available.'

export const PEDAL_SOUND_CAVEAT = 'Using a pedal for hints may not stop it from changing the piano’s own sound.'

/** Smallest value swing treated as a deliberate pedal press. */
export const DEFAULT_MIN_SWING = 32
/** Two-valued controllers spanning at least this much are treated as on/off switches. */
const SWITCH_MIN_SWING = 64
const MAX_HISTORY = 512

export type PedalThresholds = Pick<HintPedalMapping, 'threshold' | 'inverted' | 'observedMin' | 'observedMax'>

/**
 * Hysteresis band derived from the observed range (0 when the range is unknown), clamped to the
 * room around the threshold so the observed extremes still count as pressed and released (a
 * manual threshold near either end would otherwise never fire or never re-arm).
 */
export function hysteresisFor(m: Pick<HintPedalMapping, 'threshold' | 'observedMin' | 'observedMax'>): number {
  const swing = m.observedMax - m.observedMin
  if (swing <= 0) return 0
  const band = Math.min(8, Math.floor(swing / 8))
  // Released/pressed-low needs `value < threshold - h` for observedMin; pressed/released-high
  // needs `value >= threshold + h` for observedMax (the same bounds hold when inverted).
  return Math.max(0, Math.min(band, m.threshold - m.observedMin - 1, m.observedMax - m.threshold))
}

/** True when `value` is clearly pressed under the mapping (beyond the hysteresis band). */
export function isPressedValue(value: number, m: PedalThresholds, h = hysteresisFor(m)): boolean {
  return m.inverted ? value < m.threshold - h : value >= m.threshold + h
}

/** True when `value` is clearly released under the mapping. */
export function isReleasedValue(value: number, m: PedalThresholds, h = hysteresisFor(m)): boolean {
  return m.inverted ? value >= m.threshold + h : value < m.threshold - h
}

/**
 * Fires exactly once per press of the mapped pedal and re-arms only after a release
 * (spec acceptance "Pedal hints": one press reveals one hint; holding does not retrigger;
 * the next press works after release). Continuous values inside the hysteresis band neither
 * fire nor re-arm.
 */
export class HintPedalTrigger {
  private readonly m: HintPedalMapping
  private readonly h: number
  private isDown = false

  /** `currentValue`: the pedal's value right now if known, so a held pedal does not fire. */
  constructor(mapping: HintPedalMapping, currentValue?: number) {
    this.m = mapping
    this.h = hysteresisFor(mapping)
    this.reset(currentValue)
  }

  get mapping(): HintPedalMapping {
    return this.m
  }

  get down(): boolean {
    return this.isDown
  }

  matches(ev: MidiInputEvent): ev is Extract<MidiInputEvent, { kind: 'cc' }> {
    return (
      ev.kind === 'cc' &&
      ev.controller === this.m.controller &&
      (this.m.channel === null || ev.channel === this.m.channel)
    )
  }

  /** Feed any input event. Returns true exactly when this event is a new press. */
  feed(ev: MidiInputEvent): boolean {
    if (!this.matches(ev)) return false
    if (!this.isDown) {
      if (isPressedValue(ev.value, this.m, this.h)) {
        this.isDown = true
        return true
      }
    } else if (isReleasedValue(ev.value, this.m, this.h)) {
      this.isDown = false
    }
    return false
  }

  reset(currentValue?: number): void {
    this.isDown = currentValue !== undefined && isPressedValue(currentValue, this.m, this.h)
  }
}

export interface LearnerOptions {
  readonly minSwing?: number
  /** Value of a controller before learning began, if known (e.g. `PhysicalState.observedValue`). */
  readonly baseline?: (controller: number, channel: number) => number | undefined
}

export type LearnerStatus = 'listening' | 'pressed' | 'complete'

export interface LearnedHintPedal {
  /** Proposed mapping; `verified` stays false until a confirmation press succeeds. */
  readonly mapping: HintPedalMapping
  /** A full press and release was observed. */
  readonly complete: boolean
  /** Pedal is currently pressed according to the proposed mapping. */
  readonly pressed: boolean
  /** Chosen because the middle pedal sent usable messages, even if another swung further. */
  readonly preferredMiddle: boolean
}

interface Track {
  readonly channel: number
  readonly controller: number
  readonly values: number[]
  min: number
  max: number
  lastSeq: number
}

/** Channel-mode messages and bank select are never pedals. */
function isCandidateController(cc: number): boolean {
  return cc !== 0 && cc !== 32 && cc < 120
}

/**
 * Listens to controller messages while the user presses and releases the pedal they want.
 * Picks the controller with the largest value swing, preferring CC 66 when it is usable;
 * learns threshold (midpoint of observed min/max) and inversion (which end is rest).
 */
export class HintPedalLearner {
  private readonly tracks = new Map<number, Track>()
  private readonly minSwing: number
  private readonly baseline: LearnerOptions['baseline']
  private readonly seen = new Set<number>()

  constructor(opts: LearnerOptions = {}) {
    this.minSwing = opts.minSwing ?? DEFAULT_MIN_SWING
    this.baseline = opts.baseline
  }

  feed(ev: MidiInputEvent): LearnerStatus {
    if (ev.kind === 'cc') {
      this.seen.add(ev.controller)
      if (isCandidateController(ev.controller)) {
        const k = ev.channel * 128 + ev.controller
        let t = this.tracks.get(k)
        if (!t) {
          t = { channel: ev.channel, controller: ev.controller, values: [], min: 127, max: 0, lastSeq: 0 }
          this.tracks.set(k, t)
        }
        if (t.values.length < MAX_HISTORY) t.values.push(ev.value)
        else t.values[MAX_HISTORY - 1] = ev.value
        t.min = Math.min(t.min, ev.value)
        t.max = Math.max(t.max, ev.value)
        t.lastSeq = ev.seq
      }
    }
    return this.status
  }

  get status(): LearnerStatus {
    const c = this.candidate()
    if (!c) return 'listening'
    if (c.complete) return 'complete'
    return c.pressed ? 'pressed' : 'listening'
  }

  /** Controllers observed so far (for `PedalSettings.observedControllers`). */
  observedControllers(): number[] {
    return [...this.seen].sort((a, b) => a - b)
  }

  /** Any CC 66 message was seen. When false after setup, explain that the Hint button remains. */
  middlePedalObserved(): boolean {
    return this.seen.has(CC_SOSTENUTO)
  }

  middlePedalUsable(): boolean {
    for (const t of this.tracks.values()) {
      if (t.controller === CC_SOSTENUTO && t.max - t.min >= this.minSwing) return true
    }
    return false
  }

  /** Best candidate so far, or null when no controller swung far enough. */
  candidate(): LearnedHintPedal | null {
    let best: Track | null = null
    let middle: Track | null = null
    for (const t of this.tracks.values()) {
      const swing = t.max - t.min
      if (swing < this.minSwing) continue
      if (t.controller === CC_SOSTENUTO && (!middle || swing > middle.max - middle.min)) middle = t
      if (!best || swing > best.max - best.min || (swing === best.max - best.min && t.lastSeq > best.lastSeq)) {
        best = t
      }
    }
    const chosen = middle ?? best
    if (!chosen) return null
    return this.analyze(chosen, middle !== null && best !== middle)
  }

  private analyze(t: Track, preferredMiddle: boolean): LearnedHintPedal {
    const threshold = Math.round((t.min + t.max) / 2)
    const base = { threshold, observedMin: t.min, observedMax: t.max }
    const h = hysteresisFor(base)
    const v = t.values
    const first = v[0]!
    const last = v[v.length - 1]!
    const known = this.baseline?.(t.controller, t.channel)
    let restHigh: boolean
    if (known !== undefined) {
      restHigh = known >= threshold
    } else if (new Set(v).size === 2 && t.max - t.min >= SWITCH_MIN_SWING) {
      // On/off switch: it only reports changes, so the first message is the pressed state.
      restHigh = first < threshold
    } else {
      // Continuous: the first movement leads away from rest.
      const moved = v.find((x) => x !== first)
      restHigh = moved !== undefined ? moved < first : first >= threshold
    }
    const mapping: HintPedalMapping = {
      channel: t.channel,
      controller: t.controller,
      ...base,
      inverted: restHigh,
      verified: false,
    }
    let pressedAt = -1
    for (let i = 0; i < v.length; i++) {
      if (isPressedValue(v[i]!, mapping, h)) {
        pressedAt = i
        break
      }
    }
    const complete = pressedAt >= 0 && pressedAt < v.length - 1 && isReleasedValue(last, mapping, h)
    return { mapping, complete, pressed: isPressedValue(last, mapping, h), preferredMiddle }
  }
}

export type ConfirmationStatus = 'waiting' | 'pressed' | 'confirmed'

/**
 * Confirmation test press for a learned mapping: one trigger followed by a release confirms
 * it. If the press never registers, offer inversion/threshold adjustment and retry.
 */
export class HintPedalConfirmation {
  private readonly trigger: HintPedalTrigger
  private state: ConfirmationStatus = 'waiting'

  constructor(mapping: HintPedalMapping, currentValue?: number) {
    this.trigger = new HintPedalTrigger(mapping, currentValue)
  }

  feed(ev: MidiInputEvent): ConfirmationStatus {
    if (this.state === 'confirmed') return this.state
    const fired = this.trigger.feed(ev)
    if (fired) this.state = 'pressed'
    else if (this.state === 'pressed' && !this.trigger.down) this.state = 'confirmed'
    return this.state
  }

  get status(): ConfirmationStatus {
    return this.state
  }

  /** The mapping marked verified, once confirmed. */
  result(): HintPedalMapping | null {
    return this.state === 'confirmed' ? { ...this.trigger.mapping, verified: true } : null
  }
}

/** Manual adjustment helpers for the setup screen. Adjusting clears verification. */
export function withInversion(m: HintPedalMapping, inverted: boolean): HintPedalMapping {
  return { ...m, inverted, verified: false }
}

export function withThreshold(m: HintPedalMapping, threshold: number): HintPedalMapping {
  return { ...m, threshold: Math.max(1, Math.min(127, Math.round(threshold))), verified: false }
}
