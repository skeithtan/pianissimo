/**
 * The speed ladder (Repeat mode): the metronome-ladder technique, automated. Pure rules; the
 * session applies the speeds they return. A met consecutive-pass target climbs one step toward
 * the goal, two failures in a row drop one step (never below the speed the ladder started at),
 * and passing the target at the goal ends the climb.
 */
import type { LadderSettings } from '../../core/storage/records'
import { offsetOnGrid } from '../../ui/speed'
import type { LadderUi } from './types'

/** Consecutive passes per rung when Repeat has no target of its own. */
export const LADDER_DEFAULT_TARGET = 3
/** The ladder's step as the practice screen sets it: one press of the speed stepper (5%). */
export const LADDER_STEP = 0.05
/** Consecutive failures that drop the speed one step. */
export const LADDER_DROP_AFTER = 2

const EPS = 1e-9

/** The ladder switched on (or opened) at `speed`. */
export function startLadder(settings: LadderSettings, speed: number): LadderUi {
  return { goal: settings.goal, step: settings.step, start: speed, failures: 0, done: speed >= settings.goal - EPS }
}

/** New settings for a ladder already on: its start and failures stay, `done` follows the new goal. */
export function retargetLadder(ladder: LadderUi, settings: LadderSettings, speed: number): LadderUi {
  return { ...ladder, goal: settings.goal, step: settings.step, done: speed >= settings.goal - EPS }
}

export interface LadderStep {
  readonly ladder: LadderUi
  /** The speed of the next attempt, when the ladder changes it. */
  readonly next?: number
  /** What happened, for the result card. */
  readonly note?: { readonly climbedTo?: number; readonly droppedTo?: number; readonly done?: boolean }
}

/**
 * One completed scored attempt at `speed`. `streak` is the consecutive-pass count including this
 * attempt, `target` the passes a rung needs. A finished ladder (`done`) does nothing more.
 */
export function ladderAfterAttempt(
  ladder: LadderUi,
  speed: number,
  passed: boolean,
  streak: number,
  target: number,
): LadderStep {
  if (ladder.done) return { ladder }
  if (passed) {
    const cleared = ladder.failures === 0 ? ladder : { ...ladder, failures: 0 }
    if (streak < target) return { ladder: cleared }
    if (speed >= ladder.goal - EPS) return { ladder: { ...cleared, done: true }, note: { done: true } }
    const next = Math.min(ladder.goal, offsetOnGrid(speed, ladder.step))
    if (next <= speed + EPS) return { ladder: cleared }
    return { ladder: cleared, next, note: { climbedTo: next } }
  }
  const failures = ladder.failures + 1
  if (failures < LADDER_DROP_AFTER) return { ladder: { ...ladder, failures } }
  const reset = { ...ladder, failures: 0 }
  const next = Math.max(ladder.start, offsetOnGrid(speed, -ladder.step))
  // At the floor a drop changes nothing.
  if (next >= speed - EPS) return { ladder: reset }
  return { ladder: reset, next, note: { droppedTo: next } }
}

/**
 * The learner set the speed: failures start over, a speed below the start becomes the new floor,
 * and the climb counts as done exactly when the new speed is at or above the goal.
 */
export function ladderAfterManualSpeed(ladder: LadderUi, speed: number): LadderUi {
  return {
    ...ladder,
    failures: 0,
    start: Math.min(ladder.start, speed),
    done: speed >= ladder.goal - EPS,
  }
}

export function sameLadder(a: LadderSettings | null, b: LadderSettings | null): boolean {
  return a === b || (a !== null && b !== null && a.goal === b.goal && a.step === b.step)
}
