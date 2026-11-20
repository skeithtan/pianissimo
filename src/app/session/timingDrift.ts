import type { OnsetGroup } from '../../core/engine/timeline'
import type { TimingDirection } from '../../core/model/practice'

const TIMING_MATCH_WINDOW_MS = 1000
const TIMING_CUE_MS = 1200

interface ScheduledAttack {
  readonly group: number
  readonly time: number
}

function firstAttackAtOrAfter(attacks: readonly ScheduledAttack[], time: number, group = 0): number {
  let lo = 0
  let hi = attacks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const attack = attacks[mid]!
    if (attack.time < time || attack.group < group) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The near-beat window for feedback, also usable with the tightest scoring tolerance. */
export function timingFeedbackThreshold(toleranceMs: number): number {
  return Math.min(30, toleranceMs / 2)
}

/** Live timing feedback alongside strict scoring. */
export class TimingDrift {
  #older: number | null = null
  #previous: number | null = null
  #drift: TimingDirection | null = null
  #offBeat: { direction: TimingDirection; until: number } | null = null
  #playedGroup = -1
  readonly #playedPitches = new Set<number>()
  #groups: readonly OnsetGroup[] = []
  readonly #attacksByPitch = new Map<number, ScheduledAttack[]>()

  /** The scored trend is also used in the completed pass's timing review. */
  get direction(): TimingDirection | null {
    return this.#drift
  }

  directionAt(now: number): TimingDirection | null {
    return this.#offBeat && now < this.#offBeat.until ? this.#offBeat.direction : this.#drift
  }

  /** Prepare once per passage timeline so each MIDI attack searches only its own pitch. */
  prepare(groups: readonly OnsetGroup[]): void {
    if (groups === this.#groups) return
    this.#groups = groups
    this.#attacksByPitch.clear()
    for (const group of groups) {
      if (group.onsetSec === null) continue
      const attack = { group: group.index, time: Math.round(group.onsetSec * 1000) }
      for (const pitch of group.pitches) {
        const attacks = this.#attacksByPitch.get(pitch)
        if (attacks) attacks.push(attack)
        else this.#attacksByPitch.set(pitch, [attack])
      }
    }
  }

  /**
   * Match just for feedback when strict scoring may reject the note. Prefer a pitch that
   * fits the current score time, then the player's next written group, then a unique pitch
   * match within one second on either side of the playhead.
   */
  attack(pitch: number, time: number, start: number, toleranceMs: number): void {
    const attacks = this.#attacksByPitch.get(pitch)
    if (!attacks || time < start) return
    const elapsed = Math.round(time - start)
    const after = firstAttackAtOrAfter(attacks, elapsed)
    const past = attacks[after - 1]
    const future = attacks[after]
    const nearest = past && (!future || elapsed - past.time <= future.time - elapsed) ? past : future
    if (nearest && Math.abs(elapsed - nearest.time) <= toleranceMs) {
      this.#markPlayed(nearest.group, pitch)
      return
    }

    // A chord's other pitches don't supply a second timing sample for that onset.
    if (this.#groups[this.#playedGroup]?.pitches.includes(pitch) && !this.#playedPitches.has(pitch)) {
      this.#playedPitches.add(pitch)
      return
    }
    const next = this.#playedGroup + 1
    // With a known next pitch we can keep following a larger lead or lag across misses.
    const nextOnset = this.#groups[next]
    const attack =
      nextOnset?.pitches.includes(pitch) && nextOnset.onsetSec !== null
        ? { group: next, time: Math.round(nextOnset.onsetSec * 1000) }
        : this.#nearbyAttack(attacks, elapsed, next)
    if (!attack) return
    this.#markPlayed(attack.group, pitch)
    this.miss()
    this.#offBeat = { direction: elapsed < attack.time ? 'rushing' : 'dragging', until: time + TIMING_CUE_MS }
  }

  /** A pitch repeated within the search window needs more context to identify its onset. */
  #nearbyAttack(attacks: readonly ScheduledAttack[], elapsed: number, next: number): ScheduledAttack | undefined {
    const first = firstAttackAtOrAfter(attacks, elapsed - TIMING_MATCH_WINDOW_MS, next)
    const attack = attacks[first]
    const later = attacks[first + 1]
    const end = elapsed + TIMING_MATCH_WINDOW_MS
    if (attack && attack.time <= end && (!later || later.time > end)) return attack
    return undefined
  }

  #markPlayed(group: number, pitch: number): void {
    if (group !== this.#playedGroup) {
      this.#playedGroup = group
      this.#playedPitches.clear()
    }
    this.#playedPitches.add(pitch)
  }

  /** Three consecutive scored onsets show drift. Two close to the beat clear either cue. */
  observe(offsetMs: number, toleranceMs: number): void {
    const older = this.#older
    const previous = this.#previous
    this.#older = previous
    this.#previous = offsetMs
    if (previous === null) return

    const threshold = timingFeedbackThreshold(toleranceMs)
    if (Math.abs(previous) <= threshold && Math.abs(offsetMs) <= threshold) {
      this.#drift = null
      this.#offBeat = null
    } else if (older !== null) {
      if (previous < -threshold && older > previous && previous > offsetMs && older - offsetMs >= threshold) {
        this.#drift = 'rushing'
      } else if (previous > threshold && older < previous && previous < offsetMs && offsetMs - older >= threshold) {
        this.#drift = 'dragging'
      }
    }
  }

  /** A miss breaks the scored trend. A clear early or late attack can still be recent. */
  miss(): void {
    this.#older = null
    this.#previous = null
    this.#drift = null
  }

  reset(): void {
    this.miss()
    this.#offBeat = null
    this.#playedGroup = -1
    this.#playedPitches.clear()
  }
}

/** Compare live MIDI playing to the written pace between consecutive recognized onsets. */
export class PerformanceTiming {
  #previous: { group: number; writtenSec: number; playedMs: number } | null = null
  #previousDirection: TimingDirection | null = null
  #cue: { direction: TimingDirection; until: number } | null = null

  get cueUntil(): number {
    return this.#cue?.until ?? 0
  }

  directionAt(now: number): TimingDirection | null {
    return this.#cue && now < this.#cue.until ? this.#cue.direction : null
  }

  observe(group: OnsetGroup, playedMs: number): void {
    const previous = this.#previous
    if (group.onsetSec === null || (previous && group.index <= previous.group)) return
    const consecutive = previous !== null && group.index === previous.group + 1
    if (!consecutive) this.reset()
    this.#previous = { group: group.index, writtenSec: group.onsetSec, playedMs }
    if (!consecutive) return

    const writtenMs = (group.onsetSec - previous.writtenSec) * 1000
    const difference = playedMs - previous.playedMs - writtenMs
    const magnitude = Math.abs(difference)
    if (magnitude <= Math.max(30, writtenMs * 0.05)) {
      if (this.#previousDirection === null) this.#cue = null
      this.#previousDirection = null
      return
    }

    const direction = difference < 0 ? 'rushing' : 'dragging'
    if (magnitude > Math.max(150, writtenMs * 0.2) || this.#previousDirection === direction) {
      this.#cue = { direction, until: playedMs + TIMING_CUE_MS }
    }
    this.#previousDirection = direction
  }

  reset(): void {
    this.#previous = null
    this.#previousDirection = null
    this.#cue = null
  }
}
