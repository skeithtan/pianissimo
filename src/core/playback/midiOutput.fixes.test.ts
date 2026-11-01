import { expect, it } from 'vitest'
import { FakeOutput } from '../midi/fakeWebMidi'
import type { MidiInputEvent } from '../midi/types'
import { MidiOutputBackend } from './midiOutput'
import { ManualClock } from './testkit'

const CH = 2
const human = (kind: 'noteon' | 'noteoff', note: number): MidiInputEvent =>
  ({ kind, seq: 0, channel: CH, note, velocity: kind === 'noteon' ? 60 : 0, time: 0, portId: 'in' }) as MidiInputEvent

it('a deferred app release is still sent on reconnect when the input came back first', () => {
  const clock = new ManualClock()
  const out = new FakeOutput('out-1', 'Piano')
  const be = new MidiOutputBackend({ output: out, channel: CH, clock: clock.clock })
  be.noteOn(60, 80, 0)
  be.humanInput(human('noteon', 60))
  be.noteOff(60, 500)
  expect(be.deferredNotes()).toEqual([60])
  be.disconnected()
  be.resetHuman()
  expect(be.deferredNotes()).toEqual([60])
  const out2 = new FakeOutput('out-1', 'Piano')
  be.reconnect(out2, 1000)
  expect(out2.sent.map((m) => m.data)).toContainEqual([0x80 | CH, 60, 64])
  expect(be.deferredNotes()).toEqual([])
})

it('a human release during an output-only loss keeps the deferred release for reconnect', () => {
  const clock = new ManualClock()
  const out = new FakeOutput('out-1', 'Piano')
  const be = new MidiOutputBackend({ output: out, channel: CH, clock: clock.clock })
  be.noteOn(60, 80, 0)
  be.humanInput(human('noteon', 60))
  be.noteOff(60, 500)
  be.disconnected()
  be.humanInput(human('noteoff', 60))
  const out2 = new FakeOutput('out-1', 'Piano')
  be.reconnect(out2, 1000)
  expect(out2.sent.map((m) => m.data)).toContainEqual([0x80 | CH, 60, 64])
})

it('without clear(), a deferred cleanup release is never sent before a still-queued attack', () => {
  const clock = new ManualClock()
  const out = new FakeOutput('out-1', 'Piano')
  const be = new MidiOutputBackend({ output: out, channel: CH, clock: clock.clock })
  be.humanInput(human('noteon', 60))
  clock.now = 1000
  be.noteOn(60, 80, 1080)
  be.cleanup(1000)
  clock.now = 1030
  be.humanInput(human('noteoff', 60))
  const offs = out.sent.filter((m) => (m.data[0]! & 0xf0) === 0x80 && m.data[1] === 60)
  expect(offs).toHaveLength(1)
  expect(offs[0]!.time!).toBeGreaterThan(1080)
})

it('with clear(), a deferred cleanup release goes out when the human lets go (the attack was canceled)', () => {
  const clock = new ManualClock()
  const out = new FakeOutput('out-1', 'Piano', true)
  const be = new MidiOutputBackend({ output: out, channel: CH, clock: clock.clock })
  be.humanInput(human('noteon', 60))
  clock.now = 1000
  be.noteOn(60, 80, 1080)
  be.cleanup(1000)
  expect(out.clears).toBe(1)
  clock.now = 1030
  be.humanInput(human('noteoff', 60))
  const offs = out.sent.filter((m) => (m.data[0]! & 0xf0) === 0x80 && m.data[1] === 60)
  expect(offs.map((m) => m.time)).toEqual([1030])
})
