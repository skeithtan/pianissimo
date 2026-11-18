/**
 * Mistake playback in the expanded result card (DECISIONS U100): the session captures a pass's
 * keys, replays one bar ("What you played") or plays it from the score ("As written") through the
 * practice output, and never lets the snippet be taken for the learner.
 */
import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { harness, testSettings, type Harness } from './testkit'

// Bar 1: C D E, then the C–E chord; bar 2: G.
const score = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 1, midi: 62 },
    { at: 2, midi: 64 },
    { at: 3, midi: 60 },
    { at: 3, midi: 64 },
    { at: 4, midi: 67 },
  ],
  bars: 2,
})
const loop = { fromOcc: 0, toOcc: 0 }

/** One pass over bar 1 from Ready: C, C♯ (300 ms later, before D), D, E, the chord. */
function pass(h: Harness): void {
  for (let k = 0; k < 500 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
  h.play(60)
  h.step(300)
  h.tap(61)
  h.play(62, 64, 60, 64)
  h.step(200)
}

const ons = (h: Harness) => h.backend.calls.filter((c) => c.op === 'on').map((c) => (c as { note: number }).note)

async function afterPass(settings = testSettings()) {
  const h = harness(score, { range: loop }, { settings })
  await h.session.start()
  pass(h)
  const id = h.session.ui.get().lastResult!.id
  for (let k = 0; k < 500 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
  h.backend.calls.length = 0
  return { h, id }
}

describe('mistake snippets (U100)', () => {
  it('replays the keys of the bar as they were pressed, the wrong one included', async () => {
    const { h, id } = await afterPass()
    expect(h.session.snippetBlocked(id, 0, 'played')).toBeNull()
    expect(await h.session.playSnippet(id, 0, 'played')).toBeNull()
    expect(h.session.snippet.get()).toMatchObject({ occ: 0, kind: 'played' })
    h.step(10_000)
    expect(ons(h)).toEqual([60, 61, 62, 64, 60, 64])
    expect(h.session.snippet.get()).toBeNull() // ended by itself
    // The pass state is untouched: still the same result, waiting at Ready, no new record.
    expect(h.session.ui.get().lastResult?.id).toBe(id)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.attempts).toHaveLength(1)
  })

  it('plays the bar as written at the pass’s speed', async () => {
    const { h, id } = await afterPass()
    expect(await h.session.playSnippet(id, 0, 'written')).toBeNull()
    h.step(10_000)
    expect(ons(h).sort()).toEqual([60, 60, 62, 64, 64].sort())
    expect(h.attempts).toHaveLength(1)
  })

  it('a key pressed during a snippet stops it at once and starts the next pass as always', async () => {
    const { h, id } = await afterPass()
    await h.session.playSnippet(id, 0, 'written')
    h.step(100)
    expect(h.session.snippet.get()).not.toBeNull()
    h.press(60)
    expect(h.session.snippet.get()).toBeNull()
    expect(h.session.engine.state.phase).toBe('running')
    const after = h.backend.calls.length
    h.step(5000)
    expect(h.backend.calls.slice(after).filter((c) => c.op === 'on')).toEqual([]) // nothing more plays
  })

  it('on a piano that may echo, its own notes coming back are not taken for the learner', async () => {
    const { h, id } = await afterPass(testSettings({ route: { ...testSettings().route, echo: 'echo-detected' } }))
    await h.session.playSnippet(id, 0, 'written')
    h.step(10)
    // The piano sends the snippet's C back: ignored, the snippet plays on, the pass does not start.
    h.press(60)
    expect(h.session.snippet.get()).not.toBeNull()
    expect(h.session.engine.state.phase).toBe('ready')
    h.release(60)
    // A key the snippet is not sounding is the learner: it stops and is handled.
    h.press(65)
    expect(h.session.snippet.get()).toBeNull()
  })

  it('writes nothing to the piece: neither the snippet nor its echo in the MIDI path (U98)', async () => {
    const { h, id } = await afterPass(testSettings({ route: { ...testSettings().route, echo: 'echo-detected' } }))
    const before = h.saves.length
    await h.session.playSnippet(id, 0, 'played')
    h.step(10)
    h.press(60) // the snippet's own C coming back: filtered in the MIDI path
    h.release(60)
    h.step(10_000)
    await h.session.playSnippet(id, 0, 'written')
    h.step(10_000)
    expect(h.saves.slice(before)).toEqual([])
  })

  it('stops when the result ends, and says why it cannot play', async () => {
    const { h, id } = await afterPass()
    await h.session.playSnippet(id, 0, 'played')
    h.session.dismissResult()
    expect(h.session.snippet.get()).toBeNull()
    expect(h.session.snippetBlocked(id, 0, 'played')).toBe('This pass is over.')
    expect(await h.session.playSnippet(id, 0, 'played')).toBe('This pass is over.')
  })

  it('nothing captured in a bar: What you played says so; As written still plays', async () => {
    const twoBars = harness(score, { range: { fromOcc: 0, toOcc: 1 } })
    await twoBars.session.start()
    pass(twoBars) // bar 1 only: the pass is not complete
    expect(twoBars.session.ui.get().lastResult).toBeNull()
    const { h, id } = await afterPass()
    expect(h.session.snippetBlocked(id, 1, 'played')).toBe('No keys were captured in this bar.')
    expect(h.session.snippetBlocked(id, 1, 'written')).toBeNull()
  })
})

describe('mistake snippets keep the pedal (U101)', () => {
  const untilReady = (h: Harness) => {
    for (let k = 0; k < 500 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
  }
  const hintPedal = {
    ...DEFAULT_SETTINGS.pedal,
    hintPedal: {
      channel: null,
      controller: 66,
      threshold: 64,
      inverted: false,
      observedMin: 0,
      observedMax: 127,
      verified: true,
    },
  }

  it('What you played replays the learner’s sustain (down before the first note, changed, lifted after), never the hint pedal', async () => {
    const h = harness(score, { range: loop }, { settings: testSettings({ pedal: hintPedal }) })
    await h.session.start()
    untilReady(h)
    h.midi.cc(64, 127, h.clock.now) // down before the first note
    h.play(60)
    h.step(300)
    h.midi.cc(66, 127, h.clock.now) // the hint pedal: no sound, never replayed
    h.midi.cc(66, 0, h.clock.now)
    h.play(62)
    h.midi.cc(64, 0, h.clock.now) // a pedal change
    h.step(30)
    h.midi.cc(64, 120, h.clock.now)
    h.play(64, 60, 64)
    h.step(200)
    h.midi.cc(64, 0, h.clock.now) // lifted after the last chord
    const id = h.session.ui.get().lastResult!.id
    untilReady(h)
    h.backend.calls.length = 0
    expect(await h.session.playSnippet(id, 0, 'played')).toBeNull()
    h.step(10_000)
    const ccs = h.backend.ccs()
    expect(ccs.map((c) => [c.controller, c.value])).toEqual([
      [64, 127],
      [64, 0],
      [64, 120],
      [64, 0],
    ])
    // The pedal is down before the first key sounds, and the last key sound rings until it lifts.
    const calls = h.backend.calls
    expect(calls.findIndex((c) => c.op === 'cc')).toBeLessThan(calls.findIndex((c) => c.op === 'on'))
    expect(calls.at(-1)).toMatchObject({ op: 'cc', controller: 64, value: 0 })
    expect(h.session.snippet.get()).toBeNull()
  })

  const pedalled = buildScore({
    notes: [
      { at: 0, midi: 60 },
      { at: 1, midi: 62 },
      { at: 2, midi: 64 },
      { at: 3, midi: 60 },
      { at: 3, midi: 64 },
      { at: 4, midi: 67 },
    ],
    bars: 2,
    pedals: [
      { at: 0, type: 'start' },
      { at: 2, type: 'change' },
    ],
  })

  async function pedalledPass(settings = testSettings()) {
    const h = harness(pedalled, { range: loop }, { settings })
    await h.session.start()
    pass(h)
    const id = h.session.ui.get().lastResult!.id
    untilReady(h)
    h.backend.calls.length = 0
    return { h, id }
  }

  it('As written plays the score’s pedal marks and lets the pedal up at the bar’s end', async () => {
    const { h, id } = await pedalledPass()
    expect(await h.session.playSnippet(id, 0, 'written')).toBeNull()
    h.step(10_000)
    expect(h.backend.ccs().map((c) => [c.controller, c.value])).toEqual([
      [64, 127],
      [64, 0],
      [64, 127],
      [64, 0],
    ])
  })

  it('a key stops the snippet and lets its pedal up; on a piano that may echo, its pedal coming back is not the learner’s', async () => {
    const stopped = await pedalledPass()
    await stopped.h.session.playSnippet(stopped.id, 0, 'written')
    stopped.h.step(10)
    stopped.h.press(65)
    expect(stopped.h.session.snippet.get()).toBeNull()
    expect(stopped.h.backend.ccs().at(-1)).toMatchObject({ controller: 64, value: 0 })

    const { h, id } = await pedalledPass(testSettings({ route: { ...testSettings().route, echo: 'echo-detected' } }))
    await h.session.playSnippet(id, 0, 'written')
    h.step(10)
    h.midi.cc(64, 127, h.clock.now) // the piano sends the snippet's pedal back
    expect(h.session.snippet.get()).not.toBeNull()
    expect(h.session.engine.state.sustainDown).toBe(false)
    h.step(10_000)
    expect(h.backend.ccs().at(-1)).toMatchObject({ controller: 64, value: 0 })
  })
})
