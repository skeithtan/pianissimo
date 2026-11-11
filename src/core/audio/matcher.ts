/**
 * Onset matcher of the audio follower (DECISIONS P16): decides which onset group of the score
 * the player has just struck, from the semitone energies of successive frames. Pure: one `step`
 * per frame, no clocks.
 *
 * The position only moves when something is struck. A sounding chord, a ringing pedal, room
 * noise or silence, however long, change nothing: the follower waits as long as the player does.
 *
 * 1. **Rise.** Each semitone has a baseline that falls with the sound (60 dB a second at most,
 *    so the dips of beating partials do not count) and rises toward it slowly. The
 *    log-compressed excess over the baselines is the frame's rise; when its norm
 *    passes `riseOn` an **event** opens (something was struck) and lasts until the rise has
 *    fallen back or `maxAge` frames passed.
 * 2. **Evidence.** The event's observed rise is the loudest energy each semitone reached during
 *    it over the energies just before it. For a group, the expected rise is what its attack
 *    template would add to those same energies (so notes already ringing are discounted), at the
 *    best of a few loudness scales. The cosine of the two is the group's evidence; a broadband
 *    burst (a thump, a click) is recognized by the same cosine against a flat spectrum and gives
 *    no group any evidence above it.
 * 3. **Position.** A score per position (group last heard) is updated at each event as in a
 *    Viterbi step: the event is unexplained (free, nothing moves), or it is the attack of group
 *    `c`, reached from the group before it, from up to `near` groups earlier (skipped notes, a
 *    small price each) or from itself (struck again). Every position within `behind`/`ahead`
 *    groups of the best one is kept within `jump` of it, so a run of events that fits somewhere
 *    else (the player skipped a line, or went back to repeat a bar) wins after two or three of
 *    them. The best position is the answer; while the evidence is clear it is given before the
 *    event has ended.
 *
 * A chord rarely arrives all at once: it may be rolled, or one hand comes late. For half a second
 * after its latest notes the group heard last stays **open**: an event that raises semitones the
 * group had not raised yet, and with which everything struck since the group began fits the
 * group clearly better than before, is more of it, at no price. (An event on the semitones
 * already raised is the same notes again: the next group if the score repeats them. The next
 * group, or a wrong note, does not make the whole fit better.) An event nothing explains is
 * likewise kept for a moment and read together with the next one.
 */
import { SEMITONES } from './features'
import type { AttackTemplate } from './templates'

export interface MatcherOptions {
  /** Log compression of energies relative to the level reference (default 100: about 20 dB of range). */
  readonly gamma?: number
  /** Share of a semitone's excess its baseline takes up per frame (default 0.2). */
  readonly baselineRate?: number
  /** Most a baseline falls per frame, as a factor (default 0.87: about 60 dB per second). */
  readonly baselineFall?: number
  /** Rise norm that opens an event (default 1.2). */
  readonly riseOn?: number
  /** Observed-rise norm below which an event says nothing (default 1.6). */
  readonly riseMin?: number
  /** Cosine at which an event neither supports nor contradicts a group (default 0.5). */
  readonly neutral?: number
  /** Score per unit of cosine above `neutral` (default 10). */
  readonly weight?: number
  /** Price of each skipped group (default 0.5: 0.05 of cosine). */
  readonly skip?: number
  /** Price of striking the same group again (default 1). */
  readonly again?: number
  /** How far any position near the best may fall behind it (default 7: two or three clear events). */
  readonly jump?: number
  /** Groups after the best position that stay reachable (default 32). */
  readonly ahead?: number
  /** Groups before the best position that stay reachable (default 24). */
  readonly behind?: number
  /** Groups that may be skipped in one step (default 4). */
  readonly near?: number
  /** Frames an event lasts at most (default 10). */
  readonly maxAge?: number
  /** An event ends when the rise norm falls under this share of its peak (default 0.7). */
  readonly closeDrop?: number
  /** Cosine and score margin that decide an event before it ends (defaults 0.65 and 1). */
  readonly earlyCosine?: number
  readonly earlyMargin?: number
  /** The level reference is never under this many times the noise floor (default 100: 20 dB). */
  readonly noiseMargin?: number
  /** Decay of the level reference per frame (default 0.955: about 20 dB per second). */
  readonly peakDecay?: number
  /** Called for every decided event (tuning against recordings). */
  readonly trace?: (event: MatcherEvent) => void
}

/** A decided event, for `MatcherOptions.trace`. */
export interface MatcherEvent {
  /** Frame of the decision and of the event's first frame (frames since the matcher was built). */
  readonly frame: number
  readonly opened: number
  /** Group heard last before and after the event (−1: none). */
  readonly from: number
  readonly to: number
  /** Cosine of the event with group `to`, and with a flat (broadband) spectrum. */
  readonly cosine: number
  readonly flat: number
  /** Something explained it (a move or the same group again); false: noise, a wrong note, too faint. */
  readonly explained: boolean
  /** Decided before the event ended. */
  readonly early: boolean
  /** Cosine per group for the groups tried (index = group). */
  readonly tried: ReadonlyMap<number, number>
}

/** Loudness scales tried for an expected rise: template energy times the compression. */
const SCALES = [1.5, 5, 15, 50]
/** Frames an unexplained event stays readable together with the next one, and such a run at most. */
const CARRY_FRAMES = 60
const CARRY_RUN_FRAMES = 150
/** Frames a group stays open for its remaining notes after the latest ones. */
const OPEN_FRAMES = 50
/** Cosine by which more notes of the open group must improve its fit. */
const OPEN_GAIN = 0.1
/**
 * An event is the open group's notes again, not more of it, when this share of its rise lies on
 * semitones the group had already raised (by SOUNDING_RISE in log units over the sound before it).
 */
const AGAIN_SHARE = 0.7
const SOUNDING_RISE = 0.5
/** Frames after an event in which what it explained is taken into the baselines. */
const SETTLE_FRAMES = 2
/** Frames of smoothing before the noise floor is trusted. */
const FLOOR_FRAMES = 12
/**
 * The noise floor is read across the spectrum, not across time: the lowest tenth of the
 * semitone energies from G3 up (below it the FFT bins are wider than semitones and many
 * semitones get none). Notes fill a minority of the semitones, so this is the level of what
 * lies between them even while a chord sounds, and a session may start in the middle of one.
 */
const FLOOR_FROM = 34
const FLOOR_QUANTILE = 0.1
/** Smoothing of that level per frame, and the floor's slow way up per frame (3 dB a minute). */
const LEVEL_RATE = 0.2
const FLOOR_DRIFT = 1.00012
/** Nothing quieter than this counts as a noise floor (total energy; a full-scale sine is 1). */
const FLOOR_MIN = 3e-8

interface OpenEvent {
  /** Frames since it opened. */
  age: number
  /** Largest rise norm so far. */
  peak: number
}

export class OnsetMatcher {
  readonly #templates: readonly AttackTemplate[]
  readonly #fill: number
  readonly #gamma: number
  readonly #rate: number
  readonly #fall: number
  readonly #riseOn: number
  readonly #riseMin: number
  readonly #neutral: number
  readonly #weight: number
  readonly #skip: number
  readonly #again: number
  readonly #jump: number
  readonly #ahead: number
  readonly #behind: number
  readonly #near: number
  readonly #maxAge: number
  readonly #closeDrop: number
  readonly #earlyCosine: number
  readonly #earlyMargin: number
  readonly #noiseMargin: number
  readonly #peakDecay: number
  readonly #trace: ((event: MatcherEvent) => void) | undefined

  /** Per-semitone baseline energies: down with the sound, up toward it slowly. */
  readonly #base = new Float64Array(SEMITONES)
  /** Energies just before the open event, and before the first of a run of unexplained events. */
  readonly #before = new Float64Array(SEMITONES)
  readonly #carry = new Float64Array(SEMITONES)
  /** Energies before the open group began. */
  readonly #chord = new Float64Array(SEMITONES)
  /** Loudest energy per semitone during the open event. */
  readonly #loudest = new Float64Array(SEMITONES)
  readonly #rise = new Float64Array(SEMITONES)
  readonly #logBefore = new Float64Array(SEMITONES)
  /** Score per state (state s = group s − 1 was heard last; 0 = nothing yet), best = 0. */
  readonly #score: Float64Array
  readonly #next: Float64Array
  readonly #cosine: Float64Array
  readonly #sorted = new Float64Array(SEMITONES - FLOOR_FROM)

  #state = 0
  #confidence = 0
  #frame = 0
  #warm = 0
  #peak = 0
  #level = 0
  #floor = Infinity
  #reference = 1
  #event: OpenEvent | null = null
  #eventOpened = 0
  #settle = 0
  /** Semitones taken into the baselines while settling: a template's, or all (null). */
  #settleMask: AttackTemplate | null = null
  #carryAt = -Infinity
  #carryFrom = -Infinity
  /** State whose group may still get more notes (−1: none) and the frame until which it stays open. */
  #open = -1
  #openUntil = -Infinity
  /** Cosine of everything struck since the open group began with the group, at its latest notes. */
  #openCosine = 0

  /**
   * `templates[i]` is the attack of group i; `fillFrames` is how many frames the analyzer needs
   * before a frame holds only fresh samples (the matcher listens for attacks after that).
   */
  constructor(templates: readonly AttackTemplate[], fillFrames: number, options: MatcherOptions = {}) {
    this.#templates = templates
    this.#fill = fillFrames
    this.#gamma = options.gamma ?? 100
    this.#rate = options.baselineRate ?? 0.2
    this.#fall = options.baselineFall ?? 0.87
    this.#riseOn = options.riseOn ?? 1.2
    this.#riseMin = options.riseMin ?? 1.6
    this.#neutral = options.neutral ?? 0.5
    this.#weight = options.weight ?? 10
    this.#skip = options.skip ?? 0.5
    this.#again = options.again ?? 1
    this.#jump = options.jump ?? 7
    this.#ahead = options.ahead ?? 32
    this.#behind = options.behind ?? 24
    this.#near = options.near ?? 4
    this.#maxAge = options.maxAge ?? 10
    this.#closeDrop = options.closeDrop ?? 0.7
    this.#earlyCosine = options.earlyCosine ?? 0.65
    this.#earlyMargin = options.earlyMargin ?? 1
    this.#noiseMargin = options.noiseMargin ?? 100
    this.#peakDecay = options.peakDecay ?? 0.955
    this.#trace = options.trace
    this.#score = new Float64Array(templates.length + 1)
    this.#next = new Float64Array(templates.length + 1)
    this.#cosine = new Float64Array(templates.length + 1)
    this.seek(0)
    this.listen()
  }

  /** The group heard last (−1: none yet). */
  get group(): number {
    return this.#state - 1
  }

  /** Cosine of the event that last moved the position (0 before the first). */
  get confidence(): number {
    return this.#confidence
  }

  /** Expect `group` next: nothing at or after it has been heard. What sounds now stays known. */
  seek(group: number): void {
    this.#state = Math.min(this.#templates.length, Math.max(0, Math.round(group)))
    this.#score.fill(-Infinity)
    this.#score[this.#state] = 0
    this.#spread()
    this.#confidence = 0
    this.#carryAt = -Infinity
    this.#open = -1
  }

  /**
   * The audio stream starts (again): what sounded before is forgotten and the first frames only
   * fill the analysis frame and measure the level. The position is kept.
   */
  listen(): void {
    this.#warm = this.#fill + FLOOR_FRAMES
    this.#peak = 0
    this.#level = 0
    this.#floor = Infinity
    this.#event = null
    this.#settle = 0
    this.#carryAt = -Infinity
    this.#open = -1
  }

  /** One frame of semitone energies and their sum. True when `group` changed. */
  step(energy: Float64Array, total: number): boolean {
    this.#frame++
    const base = this.#base
    this.#peak = Math.max(total, this.#peak * this.#peakDecay)
    const between = this.#between(energy)
    this.#level = this.#level === 0 ? between : this.#level + LEVEL_RATE * (between - this.#level)
    if (this.#warm > 0) {
      this.#warm--
      if (this.#warm < FLOOR_FRAMES) this.#floor = Math.min(this.#floor, this.#level)
      base.set(energy)
      return false
    }
    // Level reference: the running peak, but never close to the noise floor, so noise alone is
    // always small and nothing rises out of it.
    this.#floor = Math.min(this.#floor * FLOOR_DRIFT, this.#level)
    this.#reference = Math.max(this.#peak, this.#noiseMargin * Math.max(this.#floor, FLOOR_MIN))
    const g = this.#gamma / this.#reference

    let absorbAll = false
    if (this.#settle > 0) {
      // What the last event explained keeps growing into the frame: it is sound now, not a rise.
      this.#settle--
      const mask = this.#settleMask
      if (mask) {
        for (let i = 0; i < mask.index.length; i++) {
          const p = mask.index[i]!
          if (energy[p]! > base[p]!) base[p] = energy[p]!
        }
      } else absorbAll = true
    }
    if (!this.#event) this.#before.set(base)
    let sum = 0
    for (let p = 0; p < SEMITONES; p++) {
      const v = energy[p]!
      const b = base[p]!
      if (absorbAll) {
        base[p] = v
        continue
      }
      if (v <= b) {
        // Down with the sound, but not at once: two partials beating in one semitone dip and
        // come back many times a second, and coming back is not an attack.
        base[p] = Math.max(v, b * this.#fall)
        continue
      }
      const lb = Math.log1p(g * b)
      const d = Math.log1p(g * v) - lb
      sum += d * d
      base[p] = Math.expm1(lb + this.#rate * d) / g
    }
    const norm = Math.sqrt(sum)

    const event = this.#event
    if (!event) {
      if (norm >= this.#riseOn) {
        this.#event = { age: 0, peak: norm }
        this.#eventOpened = this.#frame
        this.#loudest.set(energy)
      }
      return false
    }
    event.age++
    const loudest = this.#loudest
    for (let p = 0; p < SEMITONES; p++) if (energy[p]! > loudest[p]!) loudest[p] = energy[p]!
    if (norm > event.peak) event.peak = norm
    const ending = norm < this.#closeDrop * event.peak || event.age >= this.#maxAge
    return event.age >= 2 || ending ? this.#decide(energy, g, ending) : false
  }

  /** Total energy the frame would have if every semitone were as quiet as its quietest tenth. */
  #between(energy: Float64Array): number {
    const sorted = this.#sorted
    for (let i = 0; i < sorted.length; i++) sorted[i] = energy[FLOOR_FROM + i]!
    sorted.sort()
    return SEMITONES * sorted[Math.floor(FLOOR_QUANTILE * sorted.length)]!
  }

  // ── Evidence ─────────────────────────────────────────────────────────────────────────

  /** The observed rise over the energies `before`; returns its norm. */
  #observe(before: Float64Array, g: number): number {
    const rise = this.#rise
    const logBefore = this.#logBefore
    const loudest = this.#loudest
    let sum = 0
    for (let p = 0; p < SEMITONES; p++) {
      const l = Math.log1p(g * before[p]!)
      logBefore[p] = l
      const d = Math.log1p(g * loudest[p]!) - l
      const r = d > 0 ? d : 0
      rise[p] = r
      sum += r * r
    }
    return Math.sqrt(sum)
  }

  /** Cosine of the observed rise with the rise `template` would add to `before` (best scale). */
  #match(template: AttackTemplate, before: Float64Array, g: number, norm: number): number {
    const rise = this.#rise
    const logBefore = this.#logBefore
    const { index, value } = template
    let best = 0
    for (const scale of SCALES) {
      const s = scale / g
      let dot = 0
      let own = 0
      for (let i = 0; i < index.length; i++) {
        const p = index[i]!
        const expected = Math.log1p(g * (before[p]! + s * value[i]!)) - logBefore[p]!
        dot += rise[p]! * expected
        own += expected * expected
      }
      if (own > 0) {
        const c = dot / (norm * Math.sqrt(own))
        if (c > best) best = c
      }
    }
    return best
  }

  /** The same cosine for a broadband burst: equal energy added to every semitone. */
  #matchFlat(before: Float64Array, g: number, norm: number): number {
    const rise = this.#rise
    const logBefore = this.#logBefore
    let best = 0
    for (const scale of SCALES) {
      const s = (0.2 * scale) / g
      let dot = 0
      let own = 0
      for (let p = 0; p < SEMITONES; p++) {
        const expected = Math.log1p(g * (before[p]! + s)) - logBefore[p]!
        dot += rise[p]! * expected
        own += expected * expected
      }
      if (own > 0) {
        const c = dot / (norm * Math.sqrt(own))
        if (c > best) best = c
      }
    }
    return best
  }

  // ── Position ─────────────────────────────────────────────────────────────────────────

  /**
   * Scores the open event. While it lasts only the groups just ahead are tried, and it is decided
   * early only when one of them is clearly it; when it ends every reachable group is tried.
   * True when the position changed.
   */
  #decide(energy: Float64Array, g: number, ending: boolean): boolean {
    const score = this.#score
    const next = this.#next
    const cosine = this.#cosine
    const from = this.#state
    const first = Math.max(0, from - this.#behind)
    const last = Math.min(score.length - 1, from + this.#ahead)
    const lo = Math.max(1, ending ? first : from)
    const hi = ending ? last : Math.min(last, from + 1 + this.#near)
    for (let s = lo; s <= hi; s++) cosine[s] = 0

    // Against the sound just before the event and, after unexplained events, before those too.
    const carried = this.#frame - this.#carryAt < CARRY_FRAMES
    let heard = false
    let flat = 0
    let open = this.#open >= lo && this.#open <= hi && this.#frame <= this.#openUntil ? this.#open : -1
    for (let pass = 0; pass < (carried ? 2 : 1); pass++) {
      const before = pass === 0 ? this.#before : this.#carry
      const norm = this.#observe(before, g)
      // The open group's own notes struck again are not more of it.
      if (pass === 0 && open > 0 && this.#struckAgain(g)) open = -1
      if (norm < this.#riseMin) continue
      heard = true
      if (pass === 0) flat = this.#matchFlat(before, g, norm)
      for (let s = lo; s <= hi; s++) {
        const c = this.#match(this.#templates[s - 1]!, before, g, norm)
        if (c > cosine[s]!) cosine[s] = c
      }
    }

    // More of the open group: everything struck since it began, against the sound before it,
    // must fit the group clearly better than it did.
    let whole = 0
    if (open > 0) {
      const norm = this.#observe(this.#chord, g)
      if (norm >= this.#riseMin) whole = this.#match(this.#templates[open - 1]!, this.#chord, g, norm)
      if (whole >= this.#openCosine + OPEN_GAIN) {
        heard = true
        if (whole > cosine[open]!) cosine[open] = whole
      } else open = -1
    }

    const neutral = Math.max(this.#neutral, flat)
    let best = -Infinity
    let second = -Infinity
    let bestState = from
    for (let s = first; s <= last; s++) {
      // Unexplained: the position stays, at no cost.
      let v = score[s]!
      if (heard && s >= lo && s <= hi) {
        let reached = score[s]! - (s === open ? 0 : this.#again)
        for (let d = 1; d <= 1 + this.#near && s - d >= 0; d++) {
          const x = score[s - d]! - this.#skip * (d - 1)
          if (x > reached) reached = x
        }
        const explained = reached + this.#weight * (cosine[s]! - neutral)
        if (explained > v) v = explained
      }
      next[s] = v
      if (v > best) {
        second = best
        best = v
        bestState = s
      } else if (v > second) second = v
    }

    const moved = bestState !== from
    const clear = moved && cosine[bestState]! >= this.#earlyCosine && best - second >= this.#earlyMargin
    if (!ending && !clear) return false

    const explained = heard && best > score[from]!
    if (this.#trace) {
      const tried = new Map<number, number>()
      if (heard) for (let s = lo; s <= hi; s++) tried.set(s - 1, cosine[s]!)
      this.#trace({
        frame: this.#frame,
        opened: this.#eventOpened,
        from: from - 1,
        to: bestState - 1,
        cosine: bestState > 0 && heard ? (cosine[bestState] ?? 0) : 0,
        flat,
        explained,
        early: !ending,
        tried,
      })
    }
    this.#event = null
    for (let s = first; s <= last; s++) score[s] = next[s]!
    this.#state = bestState
    this.#spread()
    if (moved) this.#confidence = cosine[bestState]!

    const base = this.#base
    if (explained && bestState > 0) {
      // A group that began with this event began on the sound before it (before the unexplained
      // events just before it, when those count as its first notes).
      if (bestState === open) this.#openCosine = whole
      else {
        this.#chord.set(carried ? this.#carry : this.#before)
        this.#openCosine = cosine[bestState]!
      }
      this.#open = bestState
      this.#openUntil = this.#frame + OPEN_FRAMES
      // Its notes keep growing until the whole frame is past the attack; other semitones stay
      // open for the next attack.
      const mask = this.#templates[bestState - 1]!
      this.#settleMask = mask
      this.#settle = Math.max(SETTLE_FRAMES, this.#eventOpened + this.#fill - this.#frame)
      this.#carryAt = -Infinity
      for (let i = 0; i < mask.index.length; i++) {
        const p = mask.index[i]!
        if (energy[p]! > base[p]!) base[p] = energy[p]!
      }
    } else {
      // Unexplained: it is part of the sound now, and the next event is also read against the
      // sound before this one (a rolled chord arrives note by note).
      if (!carried || this.#frame - this.#carryFrom > CARRY_RUN_FRAMES) {
        this.#carry.set(this.#before)
        this.#carryFrom = this.#frame
      }
      this.#carryAt = this.#frame
      this.#settleMask = null
      this.#settle = SETTLE_FRAMES
      for (let p = 0; p < SEMITONES; p++) if (energy[p]! > base[p]!) base[p] = energy[p]!
    }
    return moved
  }

  /**
   * The rise just observed (over the sound before the event) lies mostly on semitones the open
   * group had already raised over the sound before it began: its notes again, not the rest of it.
   */
  #struckAgain(g: number): boolean {
    const rise = this.#rise
    const logBefore = this.#logBefore
    const chord = this.#chord
    let all = 0
    let again = 0
    for (let p = 0; p < SEMITONES; p++) {
      const r = rise[p]! * rise[p]!
      if (r === 0) continue
      all += r
      if (logBefore[p]! - Math.log1p(g * chord[p]!) >= SOUNDING_RISE) again += r
    }
    return again > AGAIN_SHARE * all
  }

  /**
   * Normalizes the scores to the best position and keeps every position near it within `jump`:
   * anywhere there, a run of events that fits overtakes it.
   */
  #spread(): void {
    const score = this.#score
    const lo = Math.max(0, this.#state - this.#behind)
    const hi = Math.min(score.length - 1, this.#state + this.#ahead)
    const best = score[this.#state]!
    for (let s = 0; s < score.length; s++) {
      score[s] = s < lo || s > hi ? -Infinity : Math.max(score[s]! - best, -this.#jump)
    }
  }
}
