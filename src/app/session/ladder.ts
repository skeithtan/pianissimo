/**
 * The speed ladder (Repeat mode): the metronome-ladder technique, automated. Pure rules; the
 * session applies the speeds they return. A met consecutive-pass target climbs one step toward
 * the goal, and passing the target at the goal ends the climb.
 */
import type { LadderSettings } from '../../core/storage/records'
import { offsetOnGrid } from '../../ui/speed'
import type { LadderUi } from './types'

/** Consecutive passes per rung when Repeat has no target of its own. */
export const LADDER_DEFAULT_TARGET = 3
export const LADDER_FULL_SPEED_GOAL = 1
/** The ladder's step as the practice screen sets it: one press of the speed stepper (5%). */
export const LADDER_STEP = 0.05
const EPS = 1e-9

/** Give the 100% preset room to climb when practice is already at or above the written tempo. */
export function fullSpeedLadderStart(speed: number): number {
  return speed >= LADDER_FULL_SPEED_GOAL - EPS ? 0.75 : speed
}

/** Initialize or update the ladder for the selected practice speed. */
export function startLadder(settings: LadderSettings, speed: number): LadderUi {
  return { goal: settings.goal, step: settings.step, done: speed >= settings.goal - EPS }
}

export interface LadderStep {
  readonly ladder: LadderUi
  /** The speed of the next attempt, when the ladder changes it. */
  readonly next?: number
  /** What happened, for the result card. */
  readonly note?: { readonly climbedTo?: number; readonly done?: boolean }
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
  if (ladder.done || !passed || streak < target) return { ladder }
  if (speed >= ladder.goal - EPS) return { ladder: { ...ladder, done: true }, note: { done: true } }
  const next = Math.min(ladder.goal, offsetOnGrid(speed, ladder.step))
  if (next <= speed + EPS) return { ladder }
  return { ladder, next, note: { climbedTo: next } }
}

export function sameLadder(a: LadderSettings | null, b: LadderSettings | null): boolean {
  return a === b || (a !== null && b !== null && a.goal === b.goal && a.step === b.step)
}
