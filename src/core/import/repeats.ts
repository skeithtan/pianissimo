/**
 * Repeat unfolding (spec: "Unfold written repeats into a linear performance order for the
 * strip. Preserve printed bar numbers and identify repeat occurrences"; DECISIONS M5).
 *
 * Supported: forward/backward repeat barlines (`times` honored, default two passes), volta
 * endings with number lists ("1, 2"), sequential repeat sections. A backward repeat inside an
 * ending without `times` repeats until the highest ending number of its group has been reached.
 * Nested repeats are unfolded innermost-first and reported.
 *
 * D.C. / D.S. / To Coda / Fine follow a `NavigationPlan` (`navigation.ts`, DECISIONS I4): each
 * jump is taken once, at the end of its bar and after that bar's own repeat; afterwards Fine or
 * To Coda act according to the jump's mode, and repeats and ending groups that were already
 * completed are passed straight through (the last ending is played) unless the jump asks for
 * repeats. Repeats reached for the first time after a jump (in a coda) are taken normally.
 */
import type { DiagnosticSink } from './diagnostics'
import { ImportError } from './errors'
import { type NavAction, type NavigationPlan, type NavJump, NO_NAVIGATION } from './navigation'
import type { RawBarlines } from './read/types'

export interface UnfoldedMeasure {
  /** Source measure index. */
  readonly m: number
  /** 1-based visit count of this source measure. */
  readonly pass: number
  /** Ending text ("1", "1, 2") when this occurrence lies inside a volta ending. */
  readonly ending?: string
  /** Navigation taken at the end of this occurrence (D.C./D.S. jump, To Coda, Fine). */
  readonly nav?: NavAction
}

interface Ending {
  readonly start: number
  end: number
  readonly numbers: readonly number[]
  readonly text: string
  group: number
}

function scanEndings(barlines: readonly RawBarlines[], numbers: readonly string[], diag: DiagnosticSink): Ending[] {
  const endings: Ending[] = []
  let open: Ending | null = null
  barlines.forEach((b, i) => {
    if (b.endingStart) {
      if (open) {
        open.end = i - 1
        diag.warn(
          'ending-unclosed',
          `The ending starting in bar ${numbers[open.start] ?? ''} is not closed before the next ending.`,
          {
            measure: numbers[open.start] ?? '',
          },
        )
        endings.push(open)
      }
      let nums = b.endingStart.numbers
      if (nums.length === 0) {
        nums = [1]
        diag.warn(
          'ending-number-missing',
          `The ending in bar ${numbers[i] ?? ''} has no number. It is treated as ending 1.`,
          {
            measure: numbers[i] ?? '',
          },
        )
      }
      open = { start: i, end: i, numbers: nums, text: b.endingStart.text || nums.join(', '), group: -1 }
    }
    if (b.endingStop && open) {
      open.end = i
      endings.push(open)
      open = null
    }
  })
  if (open !== null) {
    const o: Ending = open
    diag.warn('ending-unclosed', `The ending starting in bar ${numbers[o.start] ?? ''} is never closed.`, {
      measure: numbers[o.start] ?? '',
    })
    endings.push(o)
  }
  let group = 0
  endings.forEach((e, k) => {
    const prev = endings[k - 1]
    if (prev && prev.end + 1 !== e.start) group++
    e.group = group
  })
  return endings
}

/**
 * Performance order of source measures. Throws `score-too-large` when unfolding exceeds
 * `maxOccurrences` (a malformed repeat structure cannot loop forever).
 */
export function unfoldRepeats(
  barlines: readonly RawBarlines[],
  numbers: readonly string[],
  maxOccurrences: number,
  diag: DiagnosticSink,
  plan: NavigationPlan = NO_NAVIGATION,
): UnfoldedMeasure[] {
  const n = barlines.length
  const endings = scanEndings(barlines, numbers, diag)
  const endingAt: (Ending | undefined)[] = new Array(n)
  const endingStarting: (Ending | undefined)[] = new Array(n)
  for (const e of endings) {
    endingStarting[e.start] = e
    for (let i = e.start; i <= e.end; i++) endingAt[i] = e
  }
  const groupMax = new Map<number, number>()
  const groupLast = new Map<number, number>()
  const groupHasRepeat = new Map<number, boolean>()
  const groupLastStart = new Map<number, number>()
  for (const e of endings) {
    groupLastStart.set(e.group, e.start)
    groupMax.set(e.group, Math.max(groupMax.get(e.group) ?? 0, ...e.numbers))
    groupLast.set(e.group, e.end)
    let hasRepeat = groupHasRepeat.get(e.group) ?? false
    for (let i = e.start; i <= e.end; i++) if (barlines[i]?.backwardRepeat) hasRepeat = true
    groupHasRepeat.set(e.group, hasRepeat)
  }
  for (const [g, has] of groupHasRepeat) {
    if (has) continue
    const first = endings.find((e) => e.group === g)
    diag.warn(
      'ending-without-repeat',
      `The endings starting in bar ${numbers[first?.start ?? 0] ?? ''} have no repeat sign. They are played in written order.`,
      { measure: numbers[first?.start ?? 0] ?? '' },
    )
  }

  const out: { -readonly [K in keyof UnfoldedMeasure]: UnfoldedMeasure[K] }[] = []
  const visits = new Array<number>(n).fill(0)
  let sectionStart = 0
  let pass = 1
  let explicitOpen = false
  let jumpTarget = -1
  let jumpFrom = -1
  let i = 0
  // Navigation state: jumps taken, the active jump (after it, completed repeats are passed).
  const taken = new Set<number>()
  const repeatDone = new Set<number>()
  const groupDone = new Set<number>()
  let after: NavJump | null = null
  let codaTaken = false
  const passThrough = () => after !== null && !after.withRepeats
  const continueAt = (target: number, action: NavAction, message: string) => {
    out[out.length - 1]!.nav = action
    diag.info(`navigation-${action}`, message, { measure: numbers[i] ?? '', occ: out.length - 1 })
    i = target
    pass = 1
    sectionStart = target
    explicitOpen = false
    jumpTarget = -1
  }
  while (i < n) {
    const b = barlines[i]!
    // The ending is chosen with the enclosing section's pass, before a forward repeat on the same
    // bar opens a new section (a second ending may start the next repeated section). Re-entering
    // a section that begins on an ending bar, for a repeat outside that ending group, plays it.
    const rejump = i === jumpTarget
    jumpTarget = -1
    const starting = endingStarting[i]
    const reentering = rejump && starting !== undefined && endingAt[jumpFrom]?.group !== starting.group
    if (
      !reentering &&
      starting &&
      passThrough() &&
      groupDone.has(starting.group) &&
      groupHasRepeat.get(starting.group)
    ) {
      // After a jump an ending group already played goes straight to its last ending.
      const last = groupLastStart.get(starting.group)!
      if (last !== i) {
        i = last
        continue
      }
    } else if (!reentering && starting && groupHasRepeat.get(starting.group) && !starting.numbers.includes(pass)) {
      const isLast = groupLast.get(starting.group) === starting.end
      i = starting.end + 1
      if (isLast) {
        groupDone.add(starting.group)
        pass = 1
        sectionStart = i
        explicitOpen = false
      }
      continue
    }
    if (b.forwardRepeat && !rejump) {
      if (explicitOpen && sectionStart !== i) {
        diag.warn(
          'repeat-nested',
          `Bar ${numbers[i] ?? ''} starts a repeat inside another repeat. The inner repeat is unfolded first.`,
          {
            measure: numbers[i] ?? '',
          },
        )
      }
      sectionStart = i
      pass = 1
      explicitOpen = true
    }
    visits[i] = (visits[i] ?? 0) + 1
    const ending = endingAt[i]
    const occ: { -readonly [K in keyof UnfoldedMeasure]: UnfoldedMeasure[K] } = { m: i, pass: visits[i]! }
    if (ending && groupHasRepeat.get(ending.group)) occ.ending = ending.text
    out.push(occ)
    if (out.length > maxOccurrences) {
      throw new ImportError(
        'score-too-large',
        `Unfolding the repeats produces more than ${maxOccurrences} bars. The repeat structure may be malformed.`,
      )
    }
    if (b.backwardRepeat && !(passThrough() && repeatDone.has(i))) {
      const times = b.backwardRepeat.times
      const inEnding = endingAt[i]
      const passes = times ?? (inEnding ? (groupMax.get(inEnding.group) ?? 2) : 2)
      if (pass < passes) {
        pass++
        jumpTarget = sectionStart
        jumpFrom = i
        i = sectionStart
        continue
      }
      repeatDone.add(i)
      pass = 1
      sectionStart = i + 1
      explicitOpen = false
    } else if (
      b.backwardRepeat ||
      (ending && groupLast.get(ending.group) === i && groupHasRepeat.get(ending.group) && sectionStart !== i)
    ) {
      pass = 1
      sectionStart = i + 1
      explicitOpen = false
    }
    if (ending && groupLast.get(ending.group) === i && groupHasRepeat.get(ending.group)) groupDone.add(ending.group)

    // Navigation at the end of the bar (after its own repeat).
    if (after?.mode === 'fine' && plan.fine.has(i)) {
      out[out.length - 1]!.nav = 'fine'
      diag.info('navigation-fine', `The performance ends at Fine in bar ${numbers[i] ?? ''}.`, {
        measure: numbers[i] ?? '',
        occ: out.length - 1,
      })
      break
    }
    const coda = plan.toCoda.get(i)
    if (after?.mode === 'coda' && !codaTaken && coda !== undefined) {
      codaTaken = true
      continueAt(
        coda,
        'to-coda',
        `To Coda in bar ${numbers[i] ?? ''} is followed: the coda starts at bar ${numbers[coda] ?? ''}.`,
      )
      continue
    }
    const jump = plan.jumps.get(i)
    if (jump && !taken.has(i)) {
      taken.add(i)
      after = jump
      codaTaken = false
      continueAt(
        jump.target,
        'jump',
        `“${jump.text}” in bar ${numbers[i] ?? ''} is followed: the performance continues at bar ${numbers[jump.target] ?? ''}.`,
      )
      continue
    }
    i++
  }
  return out
}
