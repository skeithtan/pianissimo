import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import type { OutputBackend, TimerApi } from '../../core/playback/types'
import {
  CAPTURE_LIMIT,
  MAX_GAP_MS,
  PEDAL_TAIL_MS,
  PassCapture,
  SnippetPlayer,
  playedSnippet,
  writtenSnippet,
  type CapturedKey,
  type CapturedPedal,
} from './snippets'

describe('PassCapture', () => {
  it('keeps one pass under its attempt id, bounded, and drops an unfinished pass on begin', () => {
    const c = new PassCapture()
    c.begin(10)
    c.add(10, 60, 80, 0)
    c.add(20, 60, 0, 0)
    c.finish('a1')
    expect(c.pass('a1')?.keys).toHaveLength(2)
    expect(c.pass('a2')).toBeNull()
    c.begin(0)
    for (let i = 0; i < CAPTURE_LIMIT + 10; i++) c.add(i, 60, 80, 0)
    expect(c.size).toBe(CAPTURE_LIMIT)
    c.finish('a2')
    expect(c.pass('a2')?.truncated).toBe(true)
    expect(c.pass('a1')).toBeNull() // only the last pass is kept
    c.begin(0)
    c.add(1, 60, 80, 0)
    c.begin(0)
    expect(c.size).toBe(0)
    c.clear()
    expect(c.pass('a2')).toBeNull()
  })

  it('keeps the pedals: one down before the first press, moves in the pass, the lift after it (U101)', () => {
    const c = new PassCapture()
    c.pedal(5, 64, 127) // between passes, nothing kept yet: only its value is followed
    c.pedal(6, 67, 0)
    c.begin(10)
    c.add(10, 60, 80, 0)
    c.pedal(400, 64, 0)
    c.pedal(430, 64, 100)
    c.finish('a1')
    c.pedal(900, 64, 0) // lifted after the last chord: still this pass
    c.pedal(950, 66, 127, false) // not a scored pass: followed, not kept
    expect(c.pass('a1')?.pedals).toEqual([
      { time: 10, controller: 64, value: 127 },
      { time: 400, controller: 64, value: 0 },
      { time: 430, controller: 64, value: 100 },
      { time: 900, controller: 64, value: 0 },
    ])
    c.begin(1000)
    c.finish('a2')
    expect(c.pass('a2')?.pedals).toEqual([{ time: 1000, controller: 66, value: 127 }])
  })
})

const key = (time: number, note: number, velocity: number, group: number): CapturedKey => ({
  time,
  note,
  velocity,
  group,
})

describe('playedSnippet', () => {
  it('replays the presses made at the bar’s groups, with their velocities and releases', () => {
    const keys = [
      key(1000, 60, 70, 0), // another bar
      key(1100, 60, 0, 0),
      key(2000, 62, 90, 1),
      key(2300, 61, 50, 1), // the wrong key, at the same place
      key(2350, 61, 0, 1),
      key(2400, 62, 0, 1),
      key(2600, 64, 80, 2),
    ]
    const s = playedSnippet(keys, new Set([1, 2]))
    expect(s.notes).toEqual([
      { at: 0, note: 62, velocity: 90, duration: 400 },
      { at: 300, note: 61, velocity: 50, duration: 60 },
      { at: 600, note: 64, velocity: 80, duration: 600 }, // never released: held a moment
    ])
    expect(s.shortened).toBe(false)
    expect(s.length).toBe(1200)
  })

  it('shortens long pauses (and says so); empty when nothing was played there', () => {
    const keys = [key(0, 60, 80, 1), key(100, 60, 0, 1), key(6100, 62, 80, 1), key(6200, 62, 0, 1)]
    const s = playedSnippet(keys, new Set([1]))
    expect(s.notes.map((n) => n.at)).toEqual([0, MAX_GAP_MS])
    expect(s.shortened).toBe(true)
    expect(playedSnippet(keys, new Set([5]))).toEqual({ notes: [], pedals: [], length: 0, shortened: false })
  })

  it('replays the learner’s pedal on the replay’s clock and lets it up (U101)', () => {
    const keys = [key(1000, 60, 80, 1), key(1200, 60, 0, 1), key(1500, 62, 80, 1), key(1700, 62, 0, 1)]
    const pedals: CapturedPedal[] = [
      { time: 500, controller: 64, value: 127 }, // down before the bar: down at the start
      { time: 600, controller: 67, value: 127 }, // soft, also down before
      { time: 1480, controller: 64, value: 0 }, // a pedal change in the bar
      { time: 1520, controller: 64, value: 110 },
      { time: 1650, controller: 67, value: 0 },
      { time: 1900, controller: 64, value: 0 }, // lifted after the last key: it rang until then
      { time: 2000, controller: 64, value: 127 }, // the next bar's pedal: not replayed
    ]
    const s = playedSnippet(keys, new Set([1]), pedals)
    expect(s.pedals).toEqual([
      { at: 0, controller: 64, value: 127 },
      { at: 0, controller: 67, value: 127 },
      { at: 480, controller: 64, value: 0 },
      { at: 520, controller: 64, value: 110 },
      { at: 650, controller: 67, value: 0 },
      { at: 900, controller: 64, value: 0 },
    ])
    expect(s.length).toBe(900)
  })

  it('a pedal never lifted rings at most PEDAL_TAIL_MS after the last key; long pauses shorten pedal times too', () => {
    const keys = [key(0, 60, 80, 1), key(100, 60, 0, 1), key(6100, 62, 80, 1), key(6200, 62, 0, 1)]
    const pedals: CapturedPedal[] = [
      { time: 50, controller: 64, value: 127 },
      { time: 6150, controller: 64, value: 0 },
      { time: 6160, controller: 64, value: 127 },
    ]
    const s = playedSnippet(keys, new Set([1]), pedals)
    expect(s.pedals).toEqual([
      { at: 50, controller: 64, value: 127 },
      { at: MAX_GAP_MS + 50, controller: 64, value: 0 },
      { at: MAX_GAP_MS + 60, controller: 64, value: 127 },
      { at: MAX_GAP_MS + 100 + PEDAL_TAIL_MS, controller: 64, value: 0 },
    ])
    expect(s.length).toBe(MAX_GAP_MS + 100 + PEDAL_TAIL_MS)
  })
})

describe('writtenSnippet', () => {
  // 60 quarter-note beats per minute: a quarter note lasts one second at 1×.
  const model = buildScore({ notes: [60, 62, 64, 65, 67].map((midi, at) => ({ at, midi })), bars: 2 })

  it('plays the bar from the score at the pass’s speed', () => {
    const s = writtenSnippet(model, model.tempo, 1, 0)
    expect(s.notes.map((n) => [n.note, Math.round(n.at)])).toEqual([
      [60, 0],
      [62, 1000],
      [64, 2000],
      [65, 3000],
    ])
    const slow = writtenSnippet(model, model.tempo, 0.5, 0)
    expect(Math.round(slow.notes[1]!.at)).toBe(2000)
    expect(writtenSnippet(model, model.tempo, 1, 1).notes.map((n) => n.note)).toEqual([67])
  })

  it('plays the score’s pedal marks, a pedal from an earlier bar down at the start, all up at the bar’s end (U101)', () => {
    const pedalled = buildScore({
      notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
      bars: 2,
      pedals: [
        { at: 2, type: 'start' },
        { at: 5, type: 'change' },
        { at: 7, type: 'stop' },
      ],
    })
    const first = writtenSnippet(pedalled, pedalled.tempo, 1, 0)
    expect(first.pedals.map((p) => [Math.round(p.at), p.controller, p.value])).toEqual([
      [2000, 64, 127],
      [4000, 64, 0],
    ])
    const second = writtenSnippet(pedalled, pedalled.tempo, 0.5, 1)
    expect(second.pedals.map((p) => [Math.round(p.at), p.controller, p.value])).toEqual([
      [0, 64, 127], // down since bar 1
      [2000, 64, 0], // the change, at half speed
      [2060, 64, 127],
      [6000, 64, 0], // the stop
    ])
    expect(second.length).toBe(8000)
  })
})

class FakeTimers implements TimerApi {
  now = 0
  queue: { at: number; fn: () => void; id: number }[] = []
  next = 1
  setTimeout(fn: () => void, ms: number): number {
    const id = this.next++
    this.queue.push({ at: this.now + ms, fn, id })
    return id
  }
  clearTimeout(id: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== id)
  }
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at)
      const t = this.queue[0]
      if (!t || t.at > end) break
      this.queue.shift()
      this.now = t.at
      t.fn()
    }
    this.now = end
  }
}

function recorder(): OutputBackend & { log: string[] } {
  const log: string[] = []
  return {
    kind: 'midi',
    log,
    noteOn: (n, v, t) => log.push(`on ${n} ${v} @${Math.round(t)}`),
    noteOff: (n, t) => log.push(`off ${n} @${Math.round(t)}`),
    controlChange: (c, v, t) => log.push(`cc ${c} ${v} @${Math.round(t)}`),
    cleanup: (t) => log.push(`cleanup @${Math.round(t)}`),
    stopSound: () => undefined,
  }
}

describe('SnippetPlayer', () => {
  const snippet = {
    notes: [
      { at: 0, note: 60, velocity: 80, duration: 500 },
      { at: 1000, note: 62, velocity: 70, duration: 500 },
    ],
    pedals: [],
    length: 1500,
    shortened: false,
  }

  it('hands each press and release over when due, then ends', () => {
    const timers = new FakeTimers()
    const out = recorder()
    let ended = 0
    const p = new SnippetPlayer(
      snippet,
      out,
      () => timers.now,
      timers,
      () => ended++,
    )
    timers.advance(2000)
    expect(out.log).toEqual(['on 60 80 @0', 'off 60 @500', 'on 62 70 @1000', 'off 62 @1500'])
    expect(ended).toBe(1)
    expect(p.stopped).toBe(true)
  })

  it('stop releases only what it holds (no global cleanup) and plays nothing more; knows its notes', () => {
    const timers = new FakeTimers()
    const out = recorder()
    let ended = 0
    const p = new SnippetPlayer(
      snippet,
      out,
      () => timers.now,
      timers,
      () => ended++,
    )
    timers.advance(200)
    expect(p.sounds(60, 300)).toBe(true)
    expect(p.sounds(62, 300)).toBe(false)
    expect(p.sounds(62, 1100)).toBe(true)
    p.stop()
    timers.advance(3000)
    expect(out.log).toEqual(['on 60 80 @0', 'off 60 @200'])
    expect(ended).toBe(0)
  })

  const pedalled = {
    notes: [
      { at: 0, note: 60, velocity: 80, duration: 300 },
      { at: 500, note: 62, velocity: 70, duration: 300 },
    ],
    pedals: [
      { at: 0, controller: 64, value: 127 },
      { at: 500, controller: 64, value: 0 },
      { at: 520, controller: 64, value: 127 },
      { at: 1200, controller: 64, value: 0 },
    ],
    length: 1200,
    shortened: false,
  }

  it('moves the pedals in time order (releases, pedals, presses at one instant) and ends after the last', () => {
    const timers = new FakeTimers()
    const out = recorder()
    let ended = 0
    const p = new SnippetPlayer(
      pedalled,
      out,
      () => timers.now,
      timers,
      () => ended++,
    )
    timers.advance(1000)
    expect(ended).toBe(0) // the pedal is still down: the sound rings on
    timers.advance(1000)
    expect(out.log).toEqual([
      'cc 64 127 @0',
      'on 60 80 @0',
      'off 60 @300',
      'cc 64 0 @500',
      'on 62 70 @500',
      'cc 64 127 @520',
      'off 62 @800',
      'cc 64 0 @1200',
    ])
    expect(ended).toBe(1)
    expect(p.drivesPedal(64)).toBe(true)
    expect(p.drivesPedal(67)).toBe(false)
  })

  it('stop lets up only the pedals it pressed', () => {
    const timers = new FakeTimers()
    const out = recorder()
    const p = new SnippetPlayer(
      pedalled,
      out,
      () => timers.now,
      timers,
      () => undefined,
    )
    timers.advance(100)
    p.stop()
    expect(out.log).toEqual(['cc 64 127 @0', 'on 60 80 @0', 'off 60 @100', 'cc 64 0 @100'])
    const quiet = new SnippetPlayer(
      { ...pedalled, pedals: [] },
      recorder(),
      () => timers.now,
      timers,
      () => undefined,
    )
    quiet.stop()
    expect(quiet.drivesPedal(64)).toBe(false)
  })
})
