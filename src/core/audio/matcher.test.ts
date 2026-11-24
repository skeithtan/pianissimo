/**
 * The onset matcher on hand-made frames (nothing here depends on a synthesizer): each note sounds
 * as eight partials rolling off at 1/h², unlike the matcher's templates (sixteen at 1/h), attacks
 * grow into the frame over a few hops and sounds decay.
 */
import { describe, expect, it } from 'vitest'
import { buildScore } from '../engine/testkit'
import { SEMITONES, frameSize, windowLobe } from './features'
import { type MatcherEvent, type MatcherOptions, OnsetMatcher } from './matcher'
import { attackGroups, attackTemplates, pitchTemplate } from './templates'

const SR = 48000
const FILL = 9
/** Frames an attack takes to reach its level, and the decay of a sounding note per frame. */
const ATTACK = 4
const DECAY = 0.985
const LOBE = windowLobe(frameSize(SR))
const SOUND = { partials: 8, rollOff: 2 }

interface Sounding {
  readonly midi: number
  readonly level: number
  /** Frame of the attack. */
  readonly at: number
  /** Frame of the release (the sound stops), if any. */
  until?: number
}

/** Plays notes into a matcher frame by frame over a faint noise floor. */
class Stage {
  readonly matcher: OnsetMatcher
  readonly events: MatcherEvent[] = []
  readonly heard: number[] = []
  readonly #sounding: Sounding[] = []
  readonly #templates = new Map<number, Float64Array>()
  #frame = 0
  #seed = 1

  constructor(pitches: readonly (readonly number[])[], options: MatcherOptions = {}) {
    const model = buildScore({ notes: pitches.flatMap((chord, k) => chord.map((midi) => ({ at: k, midi }))) })
    const templates = attackTemplates(attackGroups(model), SR)
    this.matcher = new OnsetMatcher(templates, FILL, { ...options, trace: (e) => this.events.push(e) })
  }

  #noise(): number {
    this.#seed = (Math.imul(this.#seed, 1103515245) + 12345) >>> 0
    return this.#seed / 4294967296
  }

  strike(midis: readonly number[], level = 0.05): this {
    for (const midi of midis) this.#sounding.push({ midi, level, at: this.#frame })
    return this
  }

  release(): this {
    for (const s of this.#sounding) s.until ??= this.#frame
    return this
  }

  /** A broadband burst lasting `frames`. */
  thump(frames = 3, level = 0.2): this {
    for (let i = 0; i < frames; i++) this.#step(level)
    return this
  }

  run(frames: number): this {
    for (let i = 0; i < frames; i++) this.#step(0)
    return this
  }

  #step(burst: number): void {
    const energy = new Float64Array(SEMITONES)
    for (let p = 0; p < SEMITONES; p++) energy[p] = 1e-7 * (0.5 + this.#noise()) + burst / SEMITONES
    for (const s of this.#sounding) {
      if (s.until !== undefined && this.#frame >= s.until) continue
      const age = this.#frame - s.at
      const gain = s.level * Math.min(1, (age + 1) / ATTACK) ** 2 * DECAY ** age
      let t = this.#templates.get(s.midi)
      if (!t) this.#templates.set(s.midi, (t = pitchTemplate(s.midi, SR, LOBE, SOUND)))
      for (let p = 0; p < SEMITONES; p++) energy[p] = energy[p]! + gain * t[p]!
    }
    let total = 0
    for (let p = 0; p < SEMITONES; p++) total += energy[p]!
    if (this.matcher.step(energy, total)) this.heard.push(this.matcher.group)
    this.#frame++
  }
}

/** C major up and down in single notes, then two chords. */
const TUNE = [[60], [62], [64], [65], [67], [48, 64, 72], [50, 65, 74]]

describe('OnsetMatcher', () => {
  it('hears nothing in silence and moves one group per attack', () => {
    const stage = new Stage(TUNE).run(60)
    expect(stage.matcher.group).toBe(-1)
    expect(stage.matcher.confidence).toBe(0)
    for (const chord of TUNE) stage.strike(chord).run(30)
    expect(stage.heard).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(stage.matcher.confidence).toBeGreaterThan(0.8)
    // Every attack was decided within 60 ms of the first rise (P21: not before 40 ms, when the
    // thump of the key has faded and the note has not), before it had fully entered the frame.
    expect(stage.events.filter((e) => e.to !== e.from).every((e) => e.frame - e.opened <= 6)).toBe(true)
  })

  it('waits as long as the player does: a ringing chord, a release and noise move nothing', () => {
    const stage = new Stage(TUNE).run(40).strike([60]).run(30).strike([62]).run(600)
    expect(stage.heard).toEqual([0, 1])
    stage.release().run(600)
    expect(stage.heard).toEqual([0, 1])
    stage.strike([64]).run(30)
    expect(stage.heard).toEqual([0, 1, 2])
  })

  it('listens only after the frame has filled and the level is known', () => {
    const stage = new Stage(TUNE)
    // Struck during the warm-up: it is the sound the matcher starts from, not an attack.
    stage.strike([60]).run(40)
    expect(stage.matcher.group).toBe(-1)
    expect(stage.events).toEqual([])
    stage.strike([60]).run(30)
    expect(stage.heard).toEqual([0])
  })

  it('ignores a wrong note and a thump, then goes on', () => {
    const stage = new Stage(TUNE).run(40).strike([60]).run(30)
    stage.strike([61]).run(30)
    stage.thump().run(30)
    expect(stage.heard).toEqual([0])
    const [, wrong, thump] = stage.events
    expect(wrong!.explained).toBe(false)
    expect(thump!.explained).toBe(false)
    // (The burst is over by the time the event is decided, 40 ms after it rose: what is left of
    // it fits no group. Before P21 it was decided sooner and recognized as flat.)
    stage.strike([62]).run(30)
    expect(stage.heard).toEqual([0, 1])
  })

  it('hears a note under the thump of its key once the thump has faded (patience)', () => {
    // The burst outlasts the 40 ms after which the event is decided: nothing explains it then.
    const masked = (options: MatcherOptions) =>
      new Stage(TUNE, options).run(40).strike([60]).run(30).strike([62]).thump(6, 0.3).run(40)
    const before = masked({ patience: 0 })
    expect(before.heard).toEqual([0])
    expect(before.events.at(-1)!.explained).toBe(false)
    // Listened to for 80 ms more, the note is still there when the burst is not.
    const stage = masked({})
    expect(stage.heard).toEqual([0, 1])
    const late = stage.events.at(-1)!
    expect(late).toMatchObject({ from: 0, to: 1, explained: true, late: true, early: false })
    expect(late.frame - late.opened).toBeLessThanOrEqual(12)
    expect(stage.matcher.confidence).toBeGreaterThan(0.8)
    stage.strike([64]).run(30)
    expect(stage.heard).toEqual([0, 1, 2])
  })

  it('is patient only while the player is in flow, and a new attack ends the wait', () => {
    // More than 0.6 s after the last explained attack (a hesitation) the same attack stays unexplained.
    const stage = new Stage(TUNE).run(40).strike([60]).run(100).strike([62]).thump(6, 0.3).run(40)
    expect(stage.heard).toEqual([0])
    expect(stage.events.at(-1)).toMatchObject({ explained: false, late: false })
    // A wrong note is waited on; the right note struck 60 ms later is heard as its own attack.
    const wrong = new Stage(TUNE).run(40).strike([60]).run(30).strike([61]).run(6).strike([62]).run(30)
    expect(wrong.heard).toEqual([0, 1])
    expect(wrong.events.map((e) => e.explained)).toEqual([true, false, true])
    // Nothing but the wrong note: the wait runs out and it stays unexplained.
    const only = new Stage(TUNE).run(40).strike([60]).run(30).strike([61]).run(40)
    expect(only.heard).toEqual([0])
    expect(only.events.at(-1)).toMatchObject({ explained: false, late: true })
  })

  it('moves over skipped notes at once', () => {
    const stage = new Stage(TUNE).run(40).strike([60]).run(30).strike([65]).run(30)
    expect(stage.heard).toEqual([0, 3])
    stage.strike([67]).run(30)
    expect(stage.heard).toEqual([0, 3, 4])
  })

  it('takes a note struck again for the same group, unless the score repeats it', () => {
    const once = new Stage([[60], [62], [64]]).run(40).strike([60]).run(40).strike([60]).run(40)
    expect(once.heard).toEqual([0])
    expect(once.events[1]!.explained).toBe(true)
    const twice = new Stage([[60], [60], [64]]).run(40).strike([60]).run(40).strike([60]).run(40)
    expect(twice.heard).toEqual([0, 1])
  })

  it('reads the late notes of a chord as the same group, not as the next one', () => {
    // The second group holds a note of the first chord: without the open group it would be taken.
    const pitches = [[48, 55, 64, 72], [72], [74]]
    const rolled = new Stage(pitches).run(40)
    rolled.strike([48, 55]).run(12).strike([64, 72]).run(40)
    expect(rolled.heard).toEqual([0])
    expect(rolled.events.map((e) => e.explained)).toEqual([true, true])
    rolled.release().run(30).strike([72]).run(30)
    expect(rolled.heard).toEqual([0, 1])
    // A chord that arrived whole had raised that note already: the same note again, clearly
    // struck, is the next group.
    const whole = new Stage(pitches).run(40).strike([48, 55, 64, 72]).run(12).strike([72], 0.3).run(40)
    expect(whole.heard).toEqual([0, 1])
  })

  it('needs a few attacks, not one, to believe the player is somewhere else', () => {
    // From G3 up: a lone note below `lowest` is heard by its partials only and may pass for its
    // octave (README "Limits").
    const pitches = Array.from({ length: 30 }, (_, k) => [55 + ((k * 7) % 36)])
    const stage = new Stage(pitches).run(40)
    for (const k of [0, 1, 2]) stage.strike(pitches[k]!).run(30)
    // A jump of two lines.
    stage.strike(pitches[20]!).run(30)
    expect(stage.heard).toEqual([0, 1, 2])
    stage.strike(pitches[21]!).run(30).strike(pitches[22]!).run(30)
    expect(stage.matcher.group).toBe(22)
    // And back to repeat from an earlier bar.
    for (const k of [10, 11, 12]) stage.strike(pitches[k]!).run(30)
    expect(stage.matcher.group).toBe(12)
  })

  it('does not look beyond its reach', () => {
    const pitches = Array.from({ length: 30 }, (_, k) => [48 + ((k * 7) % 36)])
    const stage = new Stage(pitches, { ahead: 8 }).run(40).strike(pitches[0]!).run(30)
    for (const k of [20, 21, 22, 23]) stage.strike(pitches[k]!).run(30)
    expect(stage.heard).toEqual([0])
  })

  it('seeks: the next group is expected there and the sound is still known', () => {
    const stage = new Stage(TUNE).run(40).strike([60]).run(30)
    stage.matcher.seek(3)
    expect(stage.matcher.group).toBe(2)
    expect(stage.matcher.confidence).toBe(0)
    // The note still ringing is no attack at the new place.
    stage.run(100)
    expect(stage.matcher.group).toBe(2)
    stage.strike([65]).run(30)
    expect(stage.matcher.group).toBe(3)
    stage.matcher.seek(99)
    expect(stage.matcher.group).toBe(TUNE.length - 1)
    stage.matcher.seek(-5)
    expect(stage.matcher.group).toBe(-1)
  })

  it('listens afresh after a gap, at the same position', () => {
    const stage = new Stage(TUNE).run(40).strike([60]).run(30)
    stage.matcher.listen()
    // Whatever sounds when the stream comes back is not an attack.
    stage.strike([62]).run(40)
    expect(stage.matcher.group).toBe(0)
    stage.release().run(20).strike([62]).run(30)
    expect(stage.matcher.group).toBe(1)
  })

  it('still hears attacks after a session that began in the middle of a chord', () => {
    const stage = new Stage(TUNE)
    stage.strike([48, 52, 55, 60], 0.05).run(60)
    stage.matcher.seek(1)
    stage.strike([62], 0.03).run(30)
    expect(stage.matcher.group).toBe(1)
  })
})
