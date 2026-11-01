import { describe, expect, it } from 'vitest'
import type { HintPedalMapping } from '../model/settings'
import {
  HintPedalConfirmation,
  HintPedalLearner,
  HintPedalTrigger,
  hysteresisFor,
  withInversion,
  withThreshold,
} from './hintPedal'
import type { MidiInputEvent } from './types'

let seq = 0
const cc = (controller: number, value: number, channel = 0): MidiInputEvent => ({
  kind: 'cc',
  seq: ++seq,
  channel,
  controller,
  value,
  time: seq,
  portId: 'p',
})

const mapping = (over: Partial<HintPedalMapping> = {}): HintPedalMapping => ({
  channel: 0,
  controller: 66,
  threshold: 64,
  inverted: false,
  observedMin: 0,
  observedMax: 127,
  verified: true,
  ...over,
})

const fires = (t: HintPedalTrigger, values: readonly number[], controller = 66): number =>
  values.filter((v) => t.feed(cc(controller, v))).length

describe('HintPedalTrigger (spec acceptance "Pedal hints")', () => {
  it('fires once per press; holding (continuous values) does not retrigger', () => {
    const t = new HintPedalTrigger(mapping())
    expect(fires(t, [0, 40, 90, 127, 110, 127, 100, 120])).toBe(1)
    expect(t.down).toBe(true)
  })

  it('the next press works after a release', () => {
    const t = new HintPedalTrigger(mapping())
    expect(fires(t, [127, 0, 127, 0, 127])).toBe(3)
  })

  it('values inside the hysteresis band neither fire nor re-arm', () => {
    const t = new HintPedalTrigger(mapping())
    expect(hysteresisFor(mapping())).toBe(8)
    expect(fires(t, [70, 64])).toBe(0)
    expect(fires(t, [72, 60, 72])).toBe(1)
    expect(fires(t, [50, 80])).toBe(1)
  })

  it('supports inverted pedals (rest high, pressed low)', () => {
    const t = new HintPedalTrigger(mapping({ inverted: true }))
    expect(fires(t, [127, 100, 20, 0, 30, 127, 0])).toBe(2)
  })

  it('honors a learned threshold for pedals with a narrow range', () => {
    const t = new HintPedalTrigger(mapping({ threshold: 20, observedMin: 0, observedMax: 40 }))
    expect(fires(t, [0, 26, 0, 30])).toBe(2)
  })

  it('ignores other controllers and channels; a pedal held at start must be released first', () => {
    const t = new HintPedalTrigger(mapping({ channel: 1 }), 127)
    expect(t.feed(cc(66, 127, 0))).toBe(false)
    expect(t.feed(cc(64, 127, 1))).toBe(false)
    expect(t.feed(cc(66, 127, 1))).toBe(false)
    expect(t.feed(cc(66, 0, 1))).toBe(false)
    expect(t.feed(cc(66, 127, 1))).toBe(true)
    const any = new HintPedalTrigger(mapping({ channel: null }))
    expect(any.feed(cc(66, 127, 9))).toBe(true)
  })
})

describe('HintPedalLearner ("Set hint pedal")', () => {
  it('learns a continuous middle pedal: controller, channel, threshold and direction', () => {
    const l = new HintPedalLearner()
    for (const v of [0, 30, 80, 127, 90, 20, 0]) l.feed(cc(66, v, 2))
    const c = l.candidate()!
    expect(c.mapping).toMatchObject({
      controller: 66,
      channel: 2,
      threshold: 64,
      inverted: false,
      verified: false,
      observedMin: 0,
      observedMax: 127,
    })
    expect(c.complete).toBe(true)
    expect(l.status).toBe('complete')
  })

  it('reports pressed while held and complete only after release', () => {
    const l = new HintPedalLearner()
    expect(l.status).toBe('listening')
    for (const v of [0, 64, 127]) l.feed(cc(67, v))
    expect(l.status).toBe('pressed')
    l.feed(cc(67, 0))
    expect(l.status).toBe('complete')
  })

  it('detects inversion from the first movement, a switch from its first message, or a baseline', () => {
    const cont = new HintPedalLearner()
    for (const v of [127, 100, 40, 0, 60, 127]) cont.feed(cc(66, v))
    expect(cont.candidate()!.mapping.inverted).toBe(true)

    const sw = new HintPedalLearner()
    for (const v of [0, 127]) sw.feed(cc(66, v))
    expect(sw.candidate()!.mapping.inverted).toBe(true)
    const sw2 = new HintPedalLearner()
    for (const v of [127, 0]) sw2.feed(cc(66, v))
    expect(sw2.candidate()!.mapping.inverted).toBe(false)
    expect(sw2.candidate()!.complete).toBe(true)

    const base = new HintPedalLearner({ baseline: () => 127 })
    for (const v of [127, 0, 127]) base.feed(cc(66, v))
    expect(base.candidate()!.mapping.inverted).toBe(true)
  })

  it('prefers the middle pedal when it is usable, even if another pedal swung further', () => {
    const l = new HintPedalLearner()
    for (const v of [0, 127, 0]) l.feed(cc(64, v))
    for (const v of [0, 50, 0]) l.feed(cc(66, v))
    const c = l.candidate()!
    expect(c.mapping.controller).toBe(66)
    expect(c.preferredMiddle).toBe(true)
    expect(l.middlePedalUsable()).toBe(true)
    expect(l.observedControllers()).toEqual([64, 66])
  })

  it('explains a missing middle pedal: no CC 66 observed, best other pedal proposed', () => {
    const l = new HintPedalLearner()
    for (const v of [0, 127, 0]) l.feed(cc(67, v))
    expect(l.middlePedalObserved()).toBe(false)
    expect(l.candidate()!.mapping.controller).toBe(67)
  })

  it('ignores tiny swings, bank select and channel-mode messages', () => {
    const l = new HintPedalLearner()
    for (const v of [60, 70, 60]) l.feed(cc(66, v))
    for (const v of [0, 127]) l.feed(cc(0, v))
    for (const v of [0, 127]) l.feed(cc(123, v))
    expect(l.candidate()).toBeNull()
    expect(l.status).toBe('listening')
  })
})

describe('HintPedalConfirmation and manual adjustment', () => {
  it('confirms after one press and release, marking the mapping verified', () => {
    const c = new HintPedalConfirmation(mapping({ verified: false }))
    expect(c.feed(cc(66, 127))).toBe('pressed')
    expect(c.result()).toBeNull()
    expect(c.feed(cc(66, 0))).toBe('confirmed')
    expect(c.result()!.verified).toBe(true)
  })

  it('adjusting inversion or threshold clears verification and clamps the threshold', () => {
    expect(withInversion(mapping(), true)).toMatchObject({ inverted: true, verified: false })
    expect(withThreshold(mapping(), 300)).toMatchObject({ threshold: 127, verified: false })
    expect(withThreshold(mapping(), -5).threshold).toBe(1)
  })
})

describe('hysteresis vs a manual threshold near either end', () => {
  it('threshold 4: a full press fires and a release re-arms', () => {
    const m = withThreshold(mapping(), 4)
    const t = new HintPedalTrigger(m)
    expect(t.feed(cc(66, 127))).toBe(true)
    t.feed(cc(66, 0))
    expect(t.down).toBe(false)
    expect(fires(t, [127, 0, 127])).toBe(2)
    const c = new HintPedalConfirmation(m)
    c.feed(cc(66, 127))
    expect(c.feed(cc(66, 0))).toBe('confirmed')
  })

  it('threshold 124: a full press fires and a release re-arms', () => {
    const t = new HintPedalTrigger(withThreshold(mapping(), 124))
    expect(fires(t, [127, 0, 127])).toBe(2)
  })

  it('inverted mappings near either end fire and re-arm too', () => {
    for (const threshold of [1, 4, 124, 127]) {
      const t = new HintPedalTrigger(withThreshold(withInversion(mapping(), true), threshold))
      expect(fires(t, [127, 0, 127, 0])).toBe(2)
    }
  })

  it('the band shrinks to the room around the threshold and stays 8 in the middle', () => {
    expect(hysteresisFor(mapping({ threshold: 4 }))).toBe(3)
    expect(hysteresisFor(mapping({ threshold: 124 }))).toBe(3)
    expect(hysteresisFor(mapping({ threshold: 64 }))).toBe(8)
    expect(hysteresisFor(mapping({ threshold: 1 }))).toBe(0)
  })
})
