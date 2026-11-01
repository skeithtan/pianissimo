import { describe, expect, it } from 'vitest'
import { MidiAdapter } from '../../core/midi/adapter'
import { FakeAccess, FakeInput, fakeNavigator } from '../../core/midi/fakeWebMidi'
import type { MidiInputEvent } from '../../core/midi/types'
import type { HintPedalMapping } from '../../core/model/settings'
import { HintPedalSetup } from './hintPedalFlow'

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

const feedAll = (setup: HintPedalSetup, events: MidiInputEvent[]) => events.map((ev) => setup.feed(ev))

describe('HintPedalSetup (spec "Set hint pedal")', () => {
  it('listens, proposes the pressed pedal, then confirms with a test press', () => {
    const setup = new HintPedalSetup()
    expect(setup.phase).toBe('idle')
    setup.start()
    expect(setup.phase).toBe('listening')
    feedAll(setup, [cc(66, 10), cc(66, 40), cc(66, 80), cc(66, 127)]) // a continuous pedal going down
    expect(setup.phase).toBe('listening') // still held
    feedAll(setup, [cc(66, 80), cc(66, 30), cc(66, 0)])
    expect(setup.phase).toBe('confirming')
    expect(setup.mapping).toMatchObject({ controller: 66, channel: 0, inverted: false, verified: false })
    expect(setup.feed(cc(66, 127))).toBe(true)
    expect(setup.phase).toBe('pressed')
    expect(setup.feed(cc(66, 0))).toBe(true)
    expect(setup.phase).toBe('confirmed')
    expect(setup.mapping?.verified).toBe(true)
    expect(setup.triggerCount).toBe(1)
  })

  it('prefers the middle pedal when it sends a usable message', () => {
    const setup = new HintPedalSetup()
    setup.start()
    feedAll(setup, [cc(64, 127), cc(64, 0)])
    expect(setup.mapping?.controller).toBe(64)
    expect(setup.middlePedalSeen).toBe(false)
    feedAll(setup, [cc(66, 127), cc(66, 0)])
    expect(setup.phase).toBe('confirming')
    expect(setup.mapping?.controller).toBe(66)
    expect(setup.detected?.mapping.controller).toBe(66)
    expect(setup.middlePedalSeen).toBe(true)
  })

  it('learns an inverted on/off pedal from its baseline', () => {
    const setup = new HintPedalSetup((controller) => (controller === 67 ? 127 : undefined))
    setup.start()
    feedAll(setup, [cc(67, 0), cc(67, 127)])
    expect(setup.phase).toBe('confirming')
    expect(setup.mapping).toMatchObject({ controller: 67, inverted: true })
    expect(setup.middlePedalSeen).toBe(false)
  })

  it('adjusting inversion or threshold clears the test result', () => {
    const setup = new HintPedalSetup()
    const saved: HintPedalMapping = {
      channel: 0,
      controller: 66,
      threshold: 64,
      inverted: false,
      observedMin: 0,
      observedMax: 127,
      verified: true,
    }
    setup.test(saved)
    expect(setup.mapping?.verified).toBe(false)
    feedAll(setup, [cc(66, 127), cc(66, 0)])
    expect(setup.phase).toBe('confirmed')
    setup.adjust({ threshold: 90 })
    expect(setup.phase).toBe('confirming')
    expect(setup.mapping).toMatchObject({ threshold: 90, verified: false })
    setup.adjust({ inverted: true })
    expect(setup.mapping).toMatchObject({ inverted: true, verified: false })
  })

  it('counts one trigger per press, never while held', () => {
    const setup = new HintPedalSetup()
    setup.test({
      channel: 0,
      controller: 66,
      threshold: 64,
      inverted: false,
      observedMin: 0,
      observedMax: 127,
      verified: false,
    })
    feedAll(setup, [cc(66, 127), cc(66, 110), cc(66, 127), cc(66, 0), cc(66, 127), cc(66, 0)])
    expect(setup.triggerCount).toBe(2)
  })

  it('ignores notes and other channels for the trigger', () => {
    const setup = new HintPedalSetup()
    setup.test({
      channel: 0,
      controller: 66,
      threshold: 64,
      inverted: false,
      observedMin: 0,
      observedMax: 127,
      verified: false,
    })
    expect(setup.feed({ kind: 'noteon', seq: ++seq, channel: 0, note: 60, velocity: 90, time: 0, portId: 'p' })).toBe(
      false,
    )
    feedAll(setup, [cc(66, 127, 3)])
    expect(setup.phase).toBe('confirming')
  })

  it('cancel keeps a confirmed mapping and otherwise returns to idle', () => {
    const setup = new HintPedalSetup()
    setup.start()
    setup.cancel()
    expect(setup.phase).toBe('idle')
  })
})

describe('HintPedalSetup over a live adapter (baseline = values before learning began)', () => {
  async function rig() {
    const access = new FakeAccess()
    const input = access.addInput(new FakeInput('in', 'Piano'))
    const adapter = new MidiAdapter({ navigator: fakeNavigator(access), now: () => 1000 })
    await adapter.request()
    adapter.selectInput('in')
    // As HintPedalStep wires it: the live lookup, fed after the adapter updated physical state.
    const setup = new HintPedalSetup((c, ch) => adapter.physical.observedValue(c, ch))
    adapter.subscribe((ev) => setup.feed(ev))
    let t = 1
    const send = (controller: number, value: number) => input.emit([0xb0, controller, value], t++)
    return { setup, send }
  }

  it('a continuous pedal still being pressed is not complete', async () => {
    const { setup, send } = await rig()
    send(67, 0) // at rest before learning
    setup.start()
    for (const v of [0, 10, 25, 40, 60]) send(67, v)
    expect(setup.phase).toBe('listening')
  })

  it('a full press and release learns a non-inverted mapping with the full range', async () => {
    const { setup, send } = await rig()
    setup.start()
    for (const v of [0, 10, 25, 40, 60, 90, 127, 90, 40, 10, 0]) send(67, v)
    expect(setup.phase).toBe('confirming')
    expect(setup.mapping).toMatchObject({ controller: 67, inverted: false, observedMin: 0, observedMax: 127 })
  })

  it('a pedal resting high before learning began is learned as inverted', async () => {
    const { setup, send } = await rig()
    send(67, 127)
    setup.start()
    for (const v of [127, 90, 40, 0, 40, 90, 127]) send(67, v)
    expect(setup.mapping).toMatchObject({ controller: 67, inverted: true })
  })
})
