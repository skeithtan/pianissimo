import type { AttemptRecord, Completion, InterruptReason } from '../model/practice'
import { isAssistedAttempt, timeDifferenceSec } from './results'
import type { PracticeStreak } from './results'

/** Result-detail text for "Completion time" (spec "Results and timing"). */
export const COMPLETION_TIME_DEFINITION =
  'Time from your first key press to the last missing correct attack of the final required onset. ' +
  'Hesitation, chord assembly and wrong-note recovery after the first press count. Waiting before ' +
  'the first press, automatic playback, final sustain and loop reset do not. It is a total-time ' +
  'measure, not proof of rhythm accuracy.'

export type ScorecardRowId =
  | 'completion'
  | 'wrong-attacks'
  | 'first-pass'
  | 'completion-time'
  | 'expected-time'
  | 'time-difference'
  | 'assistance'
  | 'streak'

export interface ScorecardRow {
  readonly id: ScorecardRowId
  readonly label: string
  readonly value: string
  readonly detail?: string
}

/**
 * - `scored`: completed with a reference attack span, so a difference is defined.
 * - `ungraded`: a single onset group (no tempo ratio); the time is an ungraded time-to-solve.
 * - `unscored`: an unresolved fermata, rubato or tempo issue; no comparison is made.
 * - `none`: not completed, or the clock never started.
 */
export type TimingKind = 'scored' | 'ungraded' | 'unscored' | 'none'

export interface AssistanceDetails {
  readonly level: AttemptRecord['assistance']['level']
  readonly assisted: boolean
  /** Persistent score labels, kept apart from temporary hints. */
  readonly persistentLabelNotes: number
  readonly persistentLabelGroups: number
  readonly labelMode: AttemptRecord['assistance']['labelSettings']['mode']
  readonly hintRequests: number
  readonly autoHints: number
  readonly hintGroups: number
  readonly keyboardShown: boolean
}

export interface Scorecard {
  readonly completion: Completion
  readonly interruptReason?: InterruptReason
  readonly wrongAttacks: number
  /** Required onset groups completed without a wrong attack, as 0..100; null with no groups. */
  readonly firstPassPercent: number | null
  readonly timing: TimingKind
  readonly timingNote?: string
  readonly completionTimeSec: number | null
  readonly expectedTimeSec: number | null
  readonly notatedDurationSec: number | null
  /** Actual minus expected. */
  readonly timeDifferenceSec: number | null
  /** Null when the expected time is zero or absent. */
  readonly timeDifferencePercent: number | null
  readonly assistance: AssistanceDetails
  readonly passed: boolean
  readonly rows: readonly ScorecardRow[]
}

const COMPLETION_TEXT: Readonly<Record<Completion, string>> = {
  completed: 'Completed',
  interrupted: 'Interrupted',
  abandoned: 'Abandoned',
}

const REASON_TEXT: Readonly<Record<InterruptReason, string>> = {
  pause: 'paused',
  seek: 'position changed',
  disconnect: 'piano disconnected',
  suspend: 'app in background',
  'setting-change': 'settings changed',
  'layout-change': 'layout changed',
  'tempo-change': 'tempo changed',
  'hand-change': 'hands changed',
  'range-change': 'range changed',
  'mode-change': 'mode changed',
  'user-stop': 'stopped',
  'user-restart': 'restarted',
}

const ASSISTANCE_TEXT = { none: 'None', names: 'Note names', keyboard: 'Keyboard guide' } as const

/**
 * "59.9 s" below a minute, "1:05.3" beyond. Rounded to tenths before splitting, so 59.96 is
 * "1:00.0" (not "60.0 s") and 119.97 is "2:00.0" (not "1:60.0"); a value that rounds to zero
 * has no sign.
 */
export function formatSeconds(sec: number): string {
  const tenths = Math.round(Math.abs(sec) * 10)
  const sign = sec < 0 && tenths > 0 ? '-' : ''
  if (tenths < 600) return `${sign}${(tenths / 10).toFixed(1)} s`
  const minutes = Math.floor(tenths / 600)
  const rest = ((tenths - minutes * 600) / 10).toFixed(1).padStart(4, '0')
  return `${sign}${minutes}:${rest}`
}

function signed(sec: number): string {
  const text = formatSeconds(sec)
  return text.startsWith('-') ? text : `+${text}`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function timingKind(a: AttemptRecord): TimingKind {
  if (a.timingUnscoredReason !== undefined) return 'unscored'
  if (a.completionTimeSec === undefined) return 'none'
  return a.expectedTimeSec === null ? 'ungraded' : 'scored'
}

function assistanceDetails(a: AttemptRecord): AssistanceDetails {
  const s = a.assistance
  return {
    level: s.level,
    assisted: isAssistedAttempt(a),
    persistentLabelNotes: s.persistentLabelNotes.length,
    persistentLabelGroups: s.persistentLabelGroups.length,
    labelMode: s.labelSettings.mode,
    hintRequests: s.hintRequests,
    autoHints: s.autoHints,
    hintGroups: s.hintGroups.length,
    keyboardShown: s.keyboardShown,
  }
}

function assistanceText(d: AssistanceDetails): { value: string; detail?: string } {
  if (!d.assisted) return { value: ASSISTANCE_TEXT.none }
  const parts: string[] = []
  if (d.persistentLabelNotes > 0) {
    parts.push(
      `persistent labels on ${plural(d.persistentLabelNotes, 'note')} in ${plural(d.persistentLabelGroups, 'group')}`,
    )
  }
  if (d.hintRequests > 0) parts.push(plural(d.hintRequests, 'hint request'))
  if (d.autoHints > 0) parts.push(plural(d.autoHints, 'automatic hint'))
  if (d.hintGroups > 0) parts.push(`${plural(d.hintGroups, 'group')} revealed by hints`)
  if (d.keyboardShown) parts.push('keyboard guide shown')
  return { value: ASSISTANCE_TEXT[d.level], detail: parts.join(', ') }
}

/**
 * The transparent scorecard for one attempt (spec "Results and timing"): the defined result
 * rows, plus the structured values behind them. There is deliberately no points total and no
 * "missed notes" metric. Persistent labels and temporary hints are reported separately.
 * `streak` is the context's practice streak when the caller has it.
 */
export function buildScorecard(a: AttemptRecord, streak?: PracticeStreak): Scorecard {
  const timing = timingKind(a)
  const diff = timing === 'scored' ? timeDifferenceSec(a) : null
  const expected = timing === 'scored' ? a.expectedTimeSec : null
  const diffPercent = diff !== null && expected !== null && expected > 0 ? (diff / expected) * 100 : null
  const firstPassPercent = a.groupsTotal > 0 ? (a.groupsFirstPass / a.groupsTotal) * 100 : null
  const assistance = assistanceDetails(a)
  const assistanceRow = assistanceText(assistance)

  const rows: ScorecardRow[] = [
    {
      id: 'completion',
      label: 'Completion',
      value: COMPLETION_TEXT[a.completion],
      ...(a.interruptReason !== undefined ? { detail: REASON_TEXT[a.interruptReason] } : {}),
    },
    { id: 'wrong-attacks', label: 'Wrong-note attacks', value: String(a.wrongAttacks) },
    {
      id: 'first-pass',
      label: 'First-pass groups',
      value: firstPassPercent === null ? '—' : `${Math.round(firstPassPercent)}%`,
      detail: `${a.groupsFirstPass} of ${a.groupsTotal}`,
    },
  ]

  const completionTime = a.completionTimeSec ?? null
  if (timing === 'scored' || timing === 'ungraded') {
    rows.push({
      id: 'completion-time',
      label: timing === 'ungraded' ? 'Time to solve' : 'Completion time',
      value: completionTime === null ? '—' : formatSeconds(completionTime),
      detail: timing === 'ungraded' ? 'Single onset group: ungraded' : COMPLETION_TIME_DEFINITION,
    })
  } else {
    rows.push({
      id: 'completion-time',
      label: 'Completion time',
      value: '—',
      detail: timing === 'unscored' ? (a.timingUnscoredReason ?? 'Timing not scored') : 'Not completed',
    })
  }
  if (timing === 'scored' && expected !== null) {
    rows.push({
      id: 'expected-time',
      label: 'Expected time',
      value: formatSeconds(expected),
      ...(a.notatedDurationSec !== null ? { detail: `Notated passage ${formatSeconds(a.notatedDurationSec)}` } : {}),
    })
    if (diff !== null) {
      rows.push({
        id: 'time-difference',
        label: 'Time difference',
        value:
          diffPercent === null
            ? signed(diff)
            : `${signed(diff)} (${diffPercent >= 0 ? '+' : ''}${diffPercent.toFixed(0)}%)`,
      })
    }
  }
  rows.push({
    id: 'assistance',
    label: 'Assistance',
    value: assistanceRow.value,
    ...(assistanceRow.detail !== undefined ? { detail: assistanceRow.detail } : {}),
  })
  if (streak) {
    rows.push({
      id: 'streak',
      label: 'Practice streak',
      value: String(streak.current),
      detail: `Best ${streak.best}`,
    })
  }

  return {
    completion: a.completion,
    ...(a.interruptReason !== undefined ? { interruptReason: a.interruptReason } : {}),
    wrongAttacks: a.wrongAttacks,
    firstPassPercent,
    timing,
    ...(a.timingUnscoredReason !== undefined ? { timingNote: a.timingUnscoredReason } : {}),
    completionTimeSec: completionTime,
    expectedTimeSec: a.expectedTimeSec,
    notatedDurationSec: a.notatedDurationSec,
    timeDifferenceSec: diff,
    timeDifferencePercent: diffPercent,
    assistance,
    passed: a.passed,
    rows,
  }
}
