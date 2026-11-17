import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import type { OutputBackend, TimerApi } from '../../core/playback/types'
import {
  CAPTURE_LIMIT,
  MAX_GAP_MS,
  PassCapture,
  SnippetPlayer,
  playedSnippet,
  writtenSnippet,
  type CapturedKey,
} from './snippets'

describe('PassCapture', () => {
  it('keeps one pass under its attempt id, bounded, and drops an unfinished pass on begin', () => {
    const c = new PassCapture()
    c.begin()
    c.add(10, 60, 80, 0)
    c.add(20, 60, 0, 0)
    c.finish('a1')
    expect(c.pass('a1')?.keys).toHaveLength(2)
    expect(c.pass('a2')).toBeNull()
    c.begin()
    for (let i = 0; i < CAPTURE_LIMIT + 10; i++) c.add(i, 60, 80, 0)
    expect(c.size).toBe(CAPTURE_LIMIT)
    c.finish('a2')
    expect(c.pass('a2')?.truncated).toBe(true)
    expect(c.pass('a1')).toBeNull() // only the last pass is kept
    c.begin()
    c.add(1, 60, 80, 0)
    c.begin()
    expect(c.size).toBe(0)
    c.clear()
    expect(c.pass('a2')).toBeNull()
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
    expect(playedSnippet(keys, new Set([5]))).toEqual({ notes: [], length: 0, shortened: false })
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
    controlChange: () => undefined,
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
})
