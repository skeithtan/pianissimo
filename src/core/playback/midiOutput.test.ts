import { describe, expect, it } from 'vitest'
import { FakeOutput, type SentMessage } from '../midi/fakeWebMidi'
import type { MidiInputEvent } from '../midi/types'
import { MidiOutputBackend } from './midiOutput'
import { buildPerformance, passageRange } from './performance'
import { ManualClock, makeModel, r } from './testkit'
import { createTransport } from './transport'
import { OutputLostError } from './types'

const CH = 2

function setup(withClear = false, humanGuard = true) {
  const clock = new ManualClock()
  const out = new FakeOutput('out-1', 'Piano', withClear)
  const be = new MidiOutputBackend({ output: out, channel: CH, clock: clock.clock, humanGuard })
  return { clock, out, be }
}

const human = (kind: 'noteon' | 'noteoff', note: number, channel = CH): MidiInputEvent =>
  kind === 'noteon'
    ? { kind, seq: 0, channel, note, velocity: 60, time: 0, portId: 'in' }
    : { kind, seq: 0, channel, note, velocity: 0, time: 0, portId: 'in' }

const fmt = (m: SentMessage): string => {
  const [status, d1, d2] = m.data as [number, number, number]
  const type = status & 0xf0
  const ch = status & 0x0f
  const name = type === 0x90 ? 'on' : type === 0x80 ? 'off' : type === 0xb0 ? 'cc' : `x${type.toString(16)}`
  return `${name}:${ch}:${d1}:${d2}@${m.time}`
}

describe('MidiOutputBackend (spec "MIDI input, output, and pedal controls")', () => {
  it('sends note on/off and controllers on its channel with performance.now() timestamps', () => {
    const { out, be } = setup()
    be.noteOn(60, 200, 100)
    be.controlChange(64, 127, 100)
    be.noteOff(60, 600)
    expect(out.sent.map(fmt)).toEqual(['on:2:60:127@100', 'cc:2:64:127@100', 'off:2:60:64@600'])
  })

  it('never sends velocity 0 as an attack', () => {
    const { out, be } = setup()
    be.noteOn(60, 0, 0)
    expect(out.sent.map(fmt)).toEqual(['on:2:60:1@0'])
  })

  it('counts overlapping same-pitch app notes so an older release never cuts a newer note', () => {
    const { out, be } = setup()
    be.noteOn(48, 80, 0)
    be.noteOn(48, 80, 250)
    be.noteOff(48, 500)
    expect(be.ownedNotes()).toEqual([48])
    be.noteOff(48, 1000)
    expect(out.sent.map(fmt)).toEqual(['on:2:48:80@0', 'on:2:48:80@250', 'off:2:48:64@1000'])
    be.noteOff(48, 1200)
    expect(out.sent).toHaveLength(3)
  })

  it('defers an app release while the human holds that pitch on the same channel', () => {
    const { clock, out, be } = setup()
    be.noteOn(60, 80, 0)
    be.humanInput(human('noteon', 60))
    be.noteOff(60, 500)
    expect(out.sent.map(fmt)).toEqual(['on:2:60:80@0'])
    expect(be.deferredNotes()).toEqual([60])
    clock.now = 900
    be.humanInput(human('noteoff', 60))
    expect(out.sent.map(fmt)).toEqual(['on:2:60:80@0', 'off:2:60:64@900'])
    expect(be.deferredNotes()).toEqual([])
  })

  it('does not defer for a human key on another channel, or with the guard disabled', () => {
    const a = setup()
    a.be.noteOn(60, 80, 0)
    a.be.humanInput(human('noteon', 60, 0))
    a.be.noteOff(60, 500)
    expect(a.out.sent.map(fmt)).toContain('off:2:60:64@500')
    const b = setup(false, false)
    b.be.noteOn(60, 80, 0)
    b.be.humanInput(human('noteon', 60))
    b.be.noteOff(60, 500)
    expect(b.out.sent.map(fmt)).toContain('off:2:60:64@500')
  })

  it('a new app attack cancels a deferred release (the new note owns the key)', () => {
    const { clock, out, be } = setup()
    be.noteOn(60, 80, 0)
    be.humanInput(human('noteon', 60))
    be.noteOff(60, 500)
    be.noteOn(60, 80, 700)
    clock.now = 800
    be.humanInput(human('noteoff', 60))
    expect(out.sent.map(fmt)).toEqual(['on:2:60:80@0', 'on:2:60:80@700'])
    be.noteOff(60, 1000)
    expect(out.sent.map(fmt).at(-1)).toBe('off:2:60:64@1000')
  })

  it('cleanup with clear(): clears the queue, releases owned notes and pedals on the app channel only', () => {
    const { out, be } = setup(true)
    be.noteOn(60, 80, 0)
    be.noteOn(64, 80, 1050)
    be.controlChange(64, 127, 0)
    be.controlChange(67, 0, 0)
    be.cleanup(1000)
    expect(out.clears).toBe(1)
    expect(out.sent.slice(4).map(fmt)).toEqual(['off:2:60:64@1000', 'off:2:64:64@1000', 'cc:2:64:0@1000'])
    for (const m of out.sent) expect(m.data[0]! & 0x0f).toBe(CH)
    expect(
      out.sent.some((m) => m.data[0] === (0xb0 | CH) && (m.data[1] === 120 || m.data[1] === 123 || m.data[1] === 122)),
    ).toBe(false)
    expect(out.sent.some((m) => (m.data[0]! & 0xf0) === 0xc0)).toBe(false)
    expect(be.ownedNotes()).toEqual([])
  })

  it('cleanup without clear(): releases are timestamped after already queued attacks', () => {
    const { out, be } = setup(false)
    be.noteOn(60, 80, 0)
    be.noteOn(64, 80, 1050)
    be.controlChange(64, 127, 1060)
    be.cleanup(1000)
    expect(out.sent.slice(3).map(fmt)).toEqual(['off:2:60:64@1000', 'off:2:64:64@1051', 'cc:2:64:0@1061'])
  })

  it('cleanup re-sends a release that clear() may have dropped from the queue', () => {
    const { out, be } = setup(true)
    be.noteOn(60, 80, 0)
    be.noteOff(60, 1020)
    be.cleanup(1000)
    expect(out.sent.slice(2).map(fmt)).toEqual(['off:2:60:64@1000'])
  })

  it('cleanup keeps a human-held pitch sounding and releases it when the human lets go', () => {
    const { clock, out, be } = setup(true)
    be.noteOn(60, 80, 0)
    be.humanInput(human('noteon', 60))
    be.cleanup(500)
    expect(out.sent.slice(1).map(fmt)).toEqual([])
    clock.now = 700
    be.humanInput(human('noteoff', 60))
    expect(out.sent.slice(1).map(fmt)).toEqual(['off:2:60:64@700'])
  })

  it('stopSound forces releases (even human-held ones) and sends All Notes Off on the app channel', () => {
    const { out, be } = setup(true)
    be.noteOn(60, 80, 0)
    be.humanInput(human('noteon', 60))
    be.noteOff(60, 100)
    be.noteOn(62, 80, 0)
    be.controlChange(66, 127, 0)
    be.stopSound(500)
    expect(out.sent.slice(3).map(fmt)).toEqual([
      'off:2:60:64@500',
      'off:2:62:64@500',
      'cc:2:66:0@500',
      'cc:2:123:0@500',
    ])
    expect(be.deferredNotes()).toEqual([])
  })

  it('a failed send marks the destination lost; reconnect releases what the app still owned', () => {
    const { out, be } = setup()
    be.noteOn(60, 80, 0)
    be.controlChange(64, 127, 0)
    out.state = 'disconnected'
    expect(() => be.noteOn(62, 80, 10)).toThrow(OutputLostError)
    expect(be.available).toBe(false)
    expect(() => be.noteOff(60, 20)).toThrow(OutputLostError)
    be.cleanup(30)
    const replacement = new FakeOutput('out-2', 'Piano')
    be.reconnect(replacement, 5000)
    expect(be.available).toBe(true)
    expect(replacement.sent.map(fmt)).toEqual(['off:2:60:64@5000', 'cc:2:64:0@5000'])
    expect(be.ownedNotes()).toEqual([])
  })

  it('rejects channels outside 0..15', () => {
    const clock = new ManualClock()
    expect(() => new MidiOutputBackend({ output: new FakeOutput('o', 'o'), channel: 16, clock: clock.clock })).toThrow(
      RangeError,
    )
  })
})

describe('transport → MIDI output end to end', () => {
  it('right-hand practice sends only the left part, waits at the gate, and pause releases app notes', () => {
    const clock = new ManualClock()
    const out = new FakeOutput('out', 'Piano', true)
    const be = new MidiOutputBackend({ output: out, channel: 0, clock: clock.clock })
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/2', midi: 48, hand: 'L' },
        { at: '1/2', dur: '1/2', midi: 43, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 72, hand: 'R' },
        { at: '1/2', dur: '1/4', midi: 74, hand: 'R' },
      ],
    })
    const t = createTransport({
      clock: clock.clock,
      timers: clock,
      tempo: model.tempo,
      multiplier: 1,
      events: buildPerformance(model, { hands: 'right', sendPedals: false }),
      gates: [r('1/4'), r('1/2')],
      range: passageRange(model, null),
      backend: be,
    })
    t.play()
    clock.advanceTo(1000)
    expect(t.holdingGate).toBe(0)
    t.releaseGate(0)
    clock.advanceTo(1500)
    t.pause()
    const sent = out.sent.map(fmt)
    expect(sent).toEqual(['on:0:48:80@0', 'off:0:48:64@1500'])
    expect(out.clears).toBe(1)
    expect(sent.some((m) => m.startsWith('on:0:72') || m.startsWith('on:0:74'))).toBe(false)
  })

  it('defers the automatic release when the learner holds the same pitch early', () => {
    const clock = new ManualClock()
    const out = new FakeOutput('out', 'Piano')
    const be = new MidiOutputBackend({ output: out, channel: 0, clock: clock.clock })
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/2', midi: 60, hand: 'L' },
        { at: '1/2', dur: '1/4', midi: 60, hand: 'R' },
      ],
    })
    const t = createTransport({
      clock: clock.clock,
      timers: clock,
      tempo: model.tempo,
      multiplier: 1,
      events: buildPerformance(model, { hands: 'right', sendPedals: false }),
      gates: [r('1/2')],
      range: passageRange(model, null),
      backend: be,
    })
    t.play()
    clock.advanceTo(1950)
    be.humanInput(human('noteon', 60, 0))
    clock.advanceTo(2100)
    expect(out.sent.map(fmt)).toEqual(['on:0:60:80@0'])
    clock.advanceTo(2400)
    be.humanInput(human('noteoff', 60, 0))
    expect(out.sent.map(fmt)).toEqual(['on:0:60:80@0', 'off:0:60:64@2400'])
  })

  it('an unplugged output interrupts the transport, which resumes after reconnect without replay', () => {
    const clock = new ManualClock()
    const out = new FakeOutput('out', 'Piano')
    const be = new MidiOutputBackend({ output: out, channel: 0, clock: clock.clock })
    const model = makeModel({
      notes: [0, 1, 2, 3].map((i) => ({ at: `${i}/4`, dur: '1/4', midi: 48 + i, hand: 'L' as const })),
    })
    const causes: string[] = []
    const t = createTransport({
      clock: clock.clock,
      timers: clock,
      tempo: model.tempo,
      multiplier: 1,
      events: buildPerformance(model, { hands: 'right', sendPedals: false }),
      gates: null,
      range: passageRange(model, null),
      backend: be,
      onInterrupted: (c) => causes.push(c),
    })
    t.play()
    clock.advanceTo(1500)
    out.state = 'disconnected'
    clock.advanceTo(2500)
    expect(causes).toEqual(['disconnect'])
    expect(t.state).toBe('interrupted')
    expect(clock.pendingTimers).toBe(0)
    clock.advanceTo(3000)
    const replacement = new FakeOutput('out-2', 'Piano')
    be.reconnect(replacement, clock.now)
    expect(replacement.sent.map(fmt)).toEqual(['off:0:49:64@3000'])
    t.play()
    clock.advanceTo(10_000)
    // Interrupted at 1900 ms when the attack due at 2000 failed: resume from there, nothing replayed.
    expect(replacement.sent.map(fmt).filter((m) => m.startsWith('on'))).toEqual(['on:0:50:80@3100', 'on:0:51:80@4100'])
    expect(be.ownedNotes()).toEqual([])
  })
})
