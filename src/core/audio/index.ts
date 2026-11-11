/**
 * Audio score follower (DECISIONS P14, redesigned in P16): tells from microphone samples which
 * onset group of a score the player has reached, for Play-through (P12) on an acoustic piano.
 * Pure and worker-safe: the caller (an AudioWorklet and a worker) passes mono samples.
 * See README.md.
 */
import { type Rational, ZERO, cmp, toNumber } from '../music/rational'
import type { ScoreModel } from '../model/score'
import { SemitoneAnalyzer } from './features'
import { type MatcherOptions, OnsetMatcher } from './matcher'
import { type AttackGroup, attackGroups, attackTemplates } from './templates'

export { Fft, HOP_SEC, SEMITONES, SemitoneAnalyzer, frameSize, hopSize } from './features'
export { groupReached } from './groups'
export { OnsetMatcher, type MatcherOptions } from './matcher'
export { attackGroups, attackTemplates, pitchTemplate, type AttackGroup, type AttackTemplate } from './templates'

export type AudioFollowerOptions = MatcherOptions

export interface AudioEstimate {
  /** Index of the onset group heard last (−1: none yet). */
  readonly group: number
  /** Its performance position in float whole notes (just before the first group when none). */
  readonly position: number
  /** 0..1: how well the attack that moved the position last matched its group. */
  readonly confidence: number
  /** Stream time (seconds, the caller's clock) of the end of the latest analyzed frame. */
  readonly time: number
  /** Frames analyzed by this push. */
  readonly frames: number
  /** The position changed during this push. */
  readonly moved: boolean
}

export interface AudioFollower {
  /** The score's onset groups, in the order the follower counts them. */
  readonly groups: readonly AttackGroup[]
  /**
   * Feeds mono samples starting at stream time `time` (seconds). Any block size: a frame is
   * analyzed every 10 ms of audio. A different sample rate than before starts listening afresh
   * at the current position.
   */
  push(samples: Float32Array, sampleRate: number, time: number): AudioEstimate
  /**
   * Expect the first group at or after `position` next (default the start), e.g. after a seek.
   * The sound heard so far stays known: a chord still ringing is not an attack.
   */
  reset(position?: Rational): void
  /** The stream was interrupted (a pause): forget the sound heard so far, keep the position. */
  listen(): void
}

/** How far before the first group the position reads while nothing was heard (whole notes). */
const BEFORE_FIRST = 1e-3

/**
 * An audio follower for `model`. It follows the order of the score's onset groups only: no
 * tempo is involved, the player may take any time. The templates are built lazily for the first
 * sample rate seen (they bin partials as the analyzer does).
 */
export function createAudioFollower(model: ScoreModel, options: AudioFollowerOptions = {}): AudioFollower {
  const groups = attackGroups(model)
  const positions = groups.map((g) => toNumber(g.position))
  let analyzer: SemitoneAnalyzer | null = null
  let matcher: OnsetMatcher | null = null
  /** Group expected next when the matcher is (re)built. */
  let expected = 0
  /** Samples pushed since the analyzer started (frame i ends at sample (i + 1) × hop). */
  let pushed = 0
  let lastTime = 0

  const estimate = (frames: number, moved: boolean): AudioEstimate => {
    const group = matcher ? matcher.group : expected - 1
    return {
      group,
      position: group >= 0 ? positions[group]! : (positions[0] ?? 0) - BEFORE_FIRST,
      confidence: matcher?.confidence ?? 0,
      time: lastTime,
      frames,
      moved,
    }
  }

  return {
    groups,
    push(samples, sampleRate, time) {
      if (!analyzer || analyzer.sampleRate !== sampleRate) {
        if (matcher) expected = matcher.group + 1
        analyzer = new SemitoneAnalyzer(sampleRate)
        matcher = new OnsetMatcher(attackTemplates(groups, sampleRate), analyzer.fillFrames, options)
        matcher.seek(expected)
        pushed = 0
      }
      const m = matcher!
      const hop = analyzer.hop
      const blockStart = pushed
      pushed += samples.length
      let frames = 0
      let moved = false
      let lastIndex = -1
      analyzer.push(samples, (energy, total, index) => {
        if (m.step(energy, total)) moved = true
        frames++
        lastIndex = index
      })
      if (frames > 0) lastTime = time + ((lastIndex + 1) * hop - blockStart) / sampleRate
      return estimate(frames, moved)
    },
    reset(position = ZERO) {
      let g = 0
      while (g < groups.length && cmp(groups[g]!.position, position) < 0) g++
      expected = g
      matcher?.seek(g)
    },
    listen() {
      if (!analyzer || !matcher) return
      analyzer.reset()
      matcher.listen()
      pushed = 0
    },
  }
}
