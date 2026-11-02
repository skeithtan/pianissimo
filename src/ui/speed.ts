/**
 * Practice speed as a multiplier of the source tempo (spec "Results and timing": presets and a
 * custom multiplier or BPM; 0.5x of quarter = 120 plays at 60). Pure helpers for the tempo
 * control: stepping on a 5-percentage-point grid, parsing custom entry, and formatting.
 */

/** Smallest practice speed (5%). */
export const MIN_MULTIPLIER = 0.05
/** Largest speed the stepper reaches (400%). */
export const MAX_STEP_MULTIPLIER = 4
/** Largest speed custom entry accepts; beyond this a value is almost certainly a typo. */
export const MAX_CUSTOM_MULTIPLIER = 10
/** Speed presets in percent (spec: presets plus a custom multiplier or BPM). */
export const SPEED_PRESETS_PERCENT: readonly number[] = [50, 75, 100, 125, 150, 200]

const STEP_PERCENT = 5
const GRID_TOLERANCE = 1e-6

/**
 * One press of the stepper: the next 5% grid value in `dir`. A value already on the grid moves
 * by 5 points; one between grid values lands on the next grid value. Clamped to 5%..400%, and
 * pressing "+" never lowers a custom value above the cap.
 */
export function stepMultiplier(multiplier: number, dir: -1 | 1): number {
  const minSteps = Math.round((MIN_MULTIPLIER * 100) / STEP_PERCENT)
  const maxSteps = Math.round((MAX_STEP_MULTIPLIER * 100) / STEP_PERCENT)
  const steps = (multiplier * 100) / STEP_PERCENT
  const nearest = Math.round(steps)
  const onGrid = Math.abs(steps - nearest) < GRID_TOLERANCE
  let target: number
  if (dir > 0) target = onGrid ? nearest + 1 : Math.ceil(steps)
  else target = onGrid ? nearest - 1 : Math.floor(steps)
  if (dir > 0 && multiplier >= MAX_STEP_MULTIPLIER) return multiplier
  return (Math.min(maxSteps, Math.max(minSteps, target)) * STEP_PERCENT) / 100
}

/** Whether a press in `dir` would change the speed. */
export function canStepMultiplier(multiplier: number, dir: -1 | 1): boolean {
  return Math.abs(stepMultiplier(multiplier, dir) - multiplier) > 1e-9
}

export type SpeedInputKind = 'multiplier' | 'percent' | 'bpm'

export type SpeedParseResult =
  | { readonly ok: true; readonly multiplier: number; readonly kind: SpeedInputKind }
  | { readonly ok: false; readonly error: string }

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u
const FORMAT_HINT = 'Try 0.6, 60% or 72 BPM.'

const fail = (error: string): SpeedParseResult => ({ ok: false, error })

function checkRange(multiplier: number, kind: SpeedInputKind): SpeedParseResult {
  if (multiplier < MIN_MULTIPLIER) return fail('That is slower than 5% of the original tempo.')
  if (multiplier > MAX_CUSTOM_MULTIPLIER) return fail('That is faster than 10 times the original tempo.')
  return { ok: true, multiplier, kind }
}

/**
 * Parse custom speed entry. Accepts a multiplier ("0.6", "1.8x", "x0.6", "0,6"), a percentage
 * ("60%") or a tempo in BPM of the shown beat unit ("72 bpm", "bpm 72", "♩ = 72 bpm"), which
 * becomes `bpm / sourceBeatBpm`. A bare number is read as `bareAs` ('multiplier' by default).
 * Zero, negative, non-finite, out-of-range and unreadable values are rejected with a message.
 */
export function parseSpeedInput(
  text: string,
  sourceBeatBpm: number,
  bareAs: 'multiplier' | 'bpm' = 'multiplier',
): SpeedParseResult {
  let t = text.trim().toLowerCase().replace(/,/gu, '.').replace(/\s+/gu, '')
  if (t === '') return fail(`Enter a speed. ${FORMAT_HINT}`)
  const equals = t.lastIndexOf('=')
  if (equals >= 0) t = t.slice(equals + 1)

  let kind: SpeedInputKind = bareAs
  if (t.startsWith('bpm')) {
    kind = 'bpm'
    t = t.slice(3)
  } else if (t.endsWith('bpm')) {
    kind = 'bpm'
    t = t.slice(0, -3)
  } else if (t.endsWith('%')) {
    kind = 'percent'
    t = t.slice(0, -1)
  } else if (/^[x×]/u.test(t)) {
    kind = 'multiplier'
    t = t.slice(1)
  } else if (/[x×]$/u.test(t)) {
    kind = 'multiplier'
    t = t.slice(0, -1)
  }

  if (!NUMBER.test(t)) return fail(`Could not read "${text.trim()}". ${FORMAT_HINT}`)
  const value = Number(t)
  if (!Number.isFinite(value)) return fail('Enter a finite number.')
  if (value <= 0) return fail('Speed must be greater than zero.')

  if (kind === 'bpm') {
    if (!Number.isFinite(sourceBeatBpm) || sourceBeatBpm <= 0) {
      return fail('Set the original tempo first. BPM entry needs it as a reference.')
    }
    return checkRange(value / sourceBeatBpm, 'bpm')
  }
  const multiplier = kind === 'percent' ? value / 100 : value
  if (kind === 'multiplier' && multiplier > MAX_CUSTOM_MULTIPLIER && value <= 1000) {
    return fail(`That is faster than 10 times the original tempo. Write ${text.trim()}% for ${text.trim()} percent.`)
  }
  return checkRange(multiplier, kind)
}

/** "100%", "62.5%": the speed as a percentage with at most one decimal. */
export function formatSpeedPercent(multiplier: number): string {
  return `${Number((multiplier * 100).toFixed(1))}%`
}

/** Whole BPM when close to one, otherwise one decimal ("72", "43.2"). */
export function formatBpm(bpm: number): string {
  return Math.abs(bpm - Math.round(bpm)) < 0.05 ? String(Math.round(bpm)) : bpm.toFixed(1)
}
