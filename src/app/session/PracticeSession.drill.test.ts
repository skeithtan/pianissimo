/**
 * "Drill this spot" from the review (U168): `drillSpot` sets a tight unpersisted loop
 * around a place with Repeat on (target 3) and the speed ladder suspended; `endDrill` restores
 * what it replaced; manual loop/hand changes forget the return; nested drills keep the original
 * return; drill passes fold into mistake memory.
 */
import { describe, expect, it } from 'vitest'
import { CHORD_SLIP_MS } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { drillRange } from './drill'
import { harness, type Harness } from './testkit'

// Two bars of quarter notes in the right hand: bar 1 C D E F, bar 2 G A B C5.
const twoBars = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
  bars: 2,
  tempo: { bpm: 60 },
})
const twoBarLoop = { fromOcc: 0, toOcc: 1 }

function ready(h: Harness): void {
  for (let k = 0; k < 500 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
  expect(h.session.engine.state.phase).toBe('ready')
}

/** Play the current timeline from start to finish with optional wrong keys at given group indices. */
function playTimeline(h: Harness, wrong: Partial<Record<number, number[]>> = {}): void {
  ready(h)
  const groups = h.session.engine.timeline.groups
  for (let i = 0; i < groups.length; i++) {
    const bad = wrong[i]
    if (bad) {
      h.step(300)
      for (const p of bad) h.tap(p)
      h.step(CHORD_SLIP_MS)
    }
    const pitches = groups[i]!.pitches
    h.play(...pitches)
    if (h.session.engine.state.onceMore) {
      h.step(CHORD_SLIP_MS)
      h.play(...pitches)
    }
    h.step(CHORD_SLIP_MS)
  }
  h.step(200)
}

describe('PracticeSession drillSpot and endDrill', () => {
  it('starts a drill with drillRange, Repeat on target 3, ladder suspended, unpersisted, and restores everything on endDrill', async () => {
    const ladder = { goal: 1, step: 0.05 }
    const h = harness(
      twoBars,
      { hands: 'right', range: twoBarLoop, multiplier: 0.7 },
      {
        options: { repeat: true, repeatTarget: 5, ladder },
      },
    )
    await h.session.start()

    // Pass 1: wrong key at group 4 (G4, bar 2 beat 1).
    playTimeline(h, { 4: [66] })
    const result = h.session.ui.get().lastResult!
    expect(result).not.toBeNull()
    const details = h.session.resultDetails()!
    const expectedRange = drillRange(twoBars, 'right', details.timeline.groups[4]!.position)!
    expect(expectedRange).not.toBeNull()

    const savesBefore = h.saves.length
    expect(h.session.drillSpot(result.id, 4)).toBe(true)

    const drillingUi = h.session.ui.get()
    expect(drillingUi.range).toEqual(expectedRange)
    expect(drillingUi.repeat).toBe(true)
    expect(drillingUi.repeatTarget).toBe(3)
    expect(drillingUi.ladder).toBeNull()
    expect(drillingUi.drill).toEqual({ returnText: 'Bars 1–2' })
    expect(drillingUi.lastResult).toBeNull()
    expect(h.saves.slice(savesBefore)).toEqual([])

    // Play three clean passes in the drill -> reaches target of 3.
    playTimeline(h)
    expect(h.session.ui.get().lastResult?.streak).toBe(1)
    expect(h.session.ui.get().lastResult?.targetReached).toBe(false)
    playTimeline(h)
    expect(h.session.ui.get().lastResult?.streak).toBe(2)
    expect(h.session.ui.get().lastResult?.targetReached).toBe(false)
    playTimeline(h)
    const doneResult = h.session.ui.get().lastResult!
    expect(doneResult.passed).toBe(true)
    expect(doneResult.streak).toBe(3)
    expect(doneResult.targetReached).toBe(true)
    expect(h.session.ui.get().drill).toEqual({ returnText: 'Bars 1–2' })
    expect(h.saves.slice(savesBefore)).toEqual([])

    // endDrill restores loop, Repeat, target, and ladder without persisting.
    h.session.endDrill()
    const restored = h.session.ui.get()
    expect(restored.drill).toBeNull()
    expect(restored.range).toEqual(twoBarLoop)
    expect(restored.repeat).toBe(true)
    expect(restored.repeatTarget).toBe(5)
    expect(restored.ladder).toEqual({ goal: 1, step: 0.05, done: false })
    expect(restored.playing).toBe(false)
    expect(h.saves.slice(savesBefore)).toEqual([])
  })

  it('restores "no loop" and Repeat off when the drill started from a non-Repeat pass', async () => {
    const h = harness(
      twoBars,
      { hands: 'right', range: null, multiplier: 1 },
      {
        options: { repeat: false, repeatTarget: null, mode: 'time' },
      },
    )
    await h.session.start()
    // Wait through the 1-bar Keep time count-in (4 beats @ 60 bpm = 4000 ms).
    for (let k = 0; k < 50 && h.session.engine.state.phase !== 'running'; k++) h.step(100)
    // Play through bar 1 & 2 cleanly except a wrong note at group 3.
    const groups = h.session.engine.timeline.groups
    for (let i = 0; i < groups.length; i++) {
      if (i === 3) h.tap(66)
      h.play(...groups[i]!.pitches)
      h.step(900)
    }
    for (let k = 0; k < 40 && !h.session.ui.get().lastResult; k++) h.step(100)
    const result = h.session.ui.get().lastResult!
    expect(result).not.toBeNull()

    const savesBefore = h.saves.length
    expect(h.session.drillSpot(result.id, 3)).toBe(true)
    expect(h.session.ui.get().repeat).toBe(true)
    expect(h.session.ui.get().repeatTarget).toBe(3)
    expect(h.session.ui.get().drill).toEqual({ returnText: 'Whole piece' })
    expect(h.saves.slice(savesBefore)).toEqual([])

    h.session.endDrill()
    const restored = h.session.ui.get()
    expect(restored.drill).toBeNull()
    expect(restored.repeat).toBe(false)
    expect(restored.range).toBeNull()
    expect(restored.repeatTarget).toBeNull()
    expect(restored.playing).toBe(false)
    expect(h.saves.slice(savesBefore)).toEqual([])
  })

  it('returns false and changes nothing for a wrong attemptId or a synthetic boundary group', async () => {
    // A note held from bar 1 into bar 2 creates a synthetic boundary reattack at group 0 of bar 2.
    const heldAcross = buildScore({
      notes: [
        { at: 0, midi: 60, dur: 6 },
        { at: 6, midi: 64, dur: 2 },
      ],
      bars: 2,
      tempo: { bpm: 60 },
    })
    const h = harness(heldAcross, { hands: 'right', range: { fromOcc: 1, toOcc: 1 } })
    await h.session.start()
    playTimeline(h, { 1: [63] })
    const result = h.session.ui.get().lastResult!
    const details = h.session.resultDetails()!
    expect(details.timeline.groups[0]?.synthetic).toBe(true)

    const before = h.session.ui.get()
    expect(h.session.drillSpot('wrong-id', 1)).toBe(false)
    expect(h.session.drillSpot(result.id, 0)).toBe(false)
    expect(h.session.drillSpot(result.id, 99)).toBe(false)
    expect(h.session.ui.get()).toEqual(before)
  })

  it('forgets the drill return on manual loop or hand change, but keeps the drill on a speed change', async () => {
    const h = harness(twoBars, { hands: 'right', range: twoBarLoop, multiplier: 1 })
    await h.session.start()
    playTimeline(h, { 4: [66] })
    const result = h.session.ui.get().lastResult!
    expect(h.session.drillSpot(result.id, 4)).toBe(true)

    // Speed change keeps the drill and does not persist the drill loop.
    const savesBefore = h.saves.length
    h.session.setSelection({ multiplier: 0.8 })
    h.frames.flush()
    expect(h.session.ui.get().drill).toEqual({ returnText: 'Bars 1–2' })
    expect(h.session.ui.get().multiplier).toBe(0.8)
    for (const s of h.saves.slice(savesBefore)) expect(s.patch.lastPassage).toBeUndefined()

    // Manual loop change forgets the return.
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 0 } })
    h.frames.flush()
    expect(h.session.ui.get().drill).toBeNull()
    expect(h.session.ui.get().range).toEqual({ fromOcc: 0, toOcc: 0 })
    // endDrill is now a no-op.
    h.session.endDrill()
    h.frames.flush()
    expect(h.session.ui.get().range).toEqual({ fromOcc: 0, toOcc: 0 })

    // Hand change also forgets the return without saving the drill loop as lastPassage.
    playTimeline(h, { 1: [61] })
    expect(h.session.drillSpot(h.session.ui.get().lastResult!.id, 1)).toBe(true)
    expect(h.session.ui.get().drill).toEqual({ returnText: 'Bar 1' })
    const beforeHand = h.saves.length
    h.session.setSelection({ hands: 'both' })
    h.frames.flush()
    expect(h.session.ui.get().drill).toBeNull()
    for (const s of h.saves.slice(beforeHand)) expect(s.patch.lastPassage).toBeUndefined()
  })

  it('closing Repeat or changing hands during a drill never saves the drill loop on that or later changes', async () => {
    const h = harness(twoBars, { hands: 'right', range: twoBarLoop, multiplier: 1 })
    await h.session.start()
    playTimeline(h, { 4: [66] })
    expect(h.session.drillSpot(h.session.ui.get().lastResult!.id, 4)).toBe(true)
    const before = h.saves.length
    h.session.setSelection({ hands: 'both' })
    h.session.setSelection({ multiplier: 0.8 })
    h.session.setRepeatMode(false)
    h.session.setRepeatMode(true)
    h.frames.flush()
    expect(h.session.ui.get().drill).toBeNull()
    // Starting and ending a second drill after forgetting the first still keeps the drill range unsaved.
    await h.session.start()
    playTimeline(h, { 1: [61] })
    expect(h.session.drillSpot(h.session.ui.get().lastResult!.id, 1)).toBe(true)
    h.session.endDrill()
    h.session.setSelection({ multiplier: 0.7 })
    h.frames.flush()
    for (const s of h.saves.slice(before)) expect(s.patch.lastPassage).toBeUndefined()
  })

  it('a forgotten drill brings back the target and ladder it suspended; a target set during a drill stays', async () => {
    const ladder = { goal: 1, step: 0.05 }
    const h = harness(
      twoBars,
      { hands: 'right', range: twoBarLoop, multiplier: 0.7 },
      { options: { repeat: true, repeatTarget: 5, ladder } },
    )
    await h.session.start()
    playTimeline(h, { 4: [66] })
    expect(h.session.drillSpot(h.session.ui.get().lastResult!.id, 4)).toBe(true)
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 0 } })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ drill: null, repeatTarget: 5, ladder: { goal: 1, step: 0.05 } })

    playTimeline(h, { 1: [61] })
    expect(h.session.drillSpot(h.session.ui.get().lastResult!.id, 1)).toBe(true)
    // The drill's own target is 3: choosing 3 is still the learner's choice, saved and kept.
    h.session.setRepeatTarget(3)
    expect(h.saves.at(-1)?.patch).toEqual({ repeatTarget: 3 })
    h.session.endDrill()
    expect(h.session.ui.get().repeatTarget).toBe(3)
  })

  it('keeps the original return point when starting a nested drill from inside a drill', async () => {
    const h = harness(twoBars, { hands: 'right', range: twoBarLoop }, { options: { repeat: true, repeatTarget: 4 } })
    await h.session.start()
    playTimeline(h, { 4: [66] })
    expect(h.session.drillSpot(h.session.ui.get().lastResult!.id, 4)).toBe(true)
    expect(h.session.ui.get().drill).toEqual({ returnText: 'Bars 1–2' })

    // Make a mistake inside the first drill and drill that spot too.
    playTimeline(h, { 1: [63] })
    const innerResult = h.session.ui.get().lastResult!
    expect(h.session.drillSpot(innerResult.id, 1)).toBe(true)
    expect(h.session.ui.get().drill).toEqual({ returnText: 'Bars 1–2' })

    // endDrill returns to the original Bars 1–2 with target 4.
    h.session.endDrill()
    expect(h.session.ui.get().drill).toBeNull()
    expect(h.session.ui.get().range).toEqual(twoBarLoop)
    expect(h.session.ui.get().repeatTarget).toBe(4)
  })

  it('folds drill passes into the mistake memory (resultDetails().spots)', async () => {
    const h = harness(twoBars, { hands: 'right', range: twoBarLoop })
    await h.session.start()
    playTimeline(h, { 4: [66] })
    expect(h.session.drillSpot(h.session.ui.get().lastResult!.id, 4)).toBe(true)

    // Play a clean drill pass: the drilled spot (group 2 of the drill timeline, G4) has both visits in spots.
    playTimeline(h)
    const after = h.session.resultDetails()!
    const g4Index = after.timeline.groups.findIndex((g) => g.pitches.includes(67))
    expect(g4Index).toBeGreaterThanOrEqual(0)
    const visits = after.spots.get(g4Index) ?? []
    expect(visits.map((v) => v.wrong)).toEqual([[66], []])
  })
})
