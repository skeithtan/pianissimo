/**
 * Wrong keys in the loop report (DECISIONS P24): a key pressed with a pass's final chord is
 * counted, and the same wrong key at the same place pass after pass reaches the result summary
 * as `repeatedMistakes`.
 */
import { describe, expect, it } from 'vitest'
import { CHORD_SLIP_MS, STRIKE_GAP_MS } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { repeatedMistakeLine } from './mistakes'
import { rankMistakes } from './ranking'
import { harness, type Harness } from './testkit'

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

function ready(h: Harness): void {
  for (let k = 0; k < 500 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
  expect(h.session.engine.state.phase).toBe('ready')
}

/** One pass over bar 1 from Ready: C, then `wrong` (300 ms later, before D), D, E, the chord. */
function pass(h: Harness, wrong: number | null): void {
  ready(h)
  h.play(60)
  if (wrong !== null) {
    h.step(300)
    h.tap(wrong)
    h.step(CHORD_SLIP_MS)
  }
  h.play(62)
  if (h.session.engine.state.onceMore) {
    h.step(CHORD_SLIP_MS)
    h.play(62)
  }
  h.step(CHORD_SLIP_MS)
  h.play(64, 60, 64)
  h.step(200)
}

describe('replaying a group with a repeated extra key', () => {
  it.each(['before', 'before and between', 'after'])(
    'holds the cursor when the same extra key arrives %s the right keys',
    async (order) => {
      const h = harness(score, { range: { fromOcc: 0, toOcc: 1 } })
      await h.session.start()
      h.play(60, 62, 64, 60, 64)
      h.step(20)
      h.tap(65)
      expect(h.session.engine.state.groupIndex).toBe(4)
      h.play(67)
      expect(h.attempts[0]?.groups?.[3]?.wrongPitches).toEqual([65])

      ready(h)
      h.play(60, 62, 64)
      h.step(1000)
      const atChord = h.strip.cursor
      if (order === 'before') h.tap(65, 60, 64)
      else if (order === 'before and between') {
        // Hands not together: the rest of the strike comes well after the slip.
        h.play(60)
        h.step(90)
        h.tap(65)
        h.step(100)
        h.play(60, 64)
      } else {
        h.play(60, 64)
        h.step(20)
        h.tap(65)
      }
      h.step(STRIKE_GAP_MS)
      expect(h.session.engine.state).toMatchObject({
        groupIndex: 3,
        acceptedPitches: [],
        retryGroup: true,
      })
      expect(h.strip.cursor).toBe(atChord)
      expect(h.session.feedback.get().cue).toEqual({ kind: 'retry' })

      h.play(64, 60)
      h.step(CHORD_SLIP_MS)
      expect(h.session.engine.state.groupIndex).toBe(4)
      h.play(67)
      expect(h.attempts[1]).toMatchObject({ completion: 'completed', wrongAttacks: 1 })

      ready(h)
      h.play(60, 62, 64, 60, 64)
      h.step(CHORD_SLIP_MS)
      h.play(67)
      expect(h.attempts[2]).toMatchObject({ completion: 'completed', wrongAttacks: 0 })
    },
  )
})

describe('repeated mistakes in the result summary (P24)', () => {
  it('the same wrong key at the same note three passes running is named in lastResult', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    pass(h, 61)
    pass(h, 61)
    expect(h.attempts.map((a) => a.wrongAttacks)).toEqual([1, 1])
    expect(h.session.ui.get().lastResult?.repeatedMistakes).toBeUndefined()
    pass(h, 61)
    const result = h.session.ui.get().lastResult!
    expect(result.wrongAttacks).toBe(1)
    expect(result.repeatedMistakes).toMatchObject([
      { group: 1, occ: 0, bar: '1', expectedPitch: 62, wrongPitch: 61, passes: 3 },
    ])
    expect(repeatedMistakeLine(result.repeatedMistakes![0]!, score, DEFAULT_SETTINGS.naming)).toBe(
      'D♭ instead of D♮ in bar 1, three passes running',
    )
    // A clean pass at that note: nothing repeated any more.
    pass(h, null)
    expect(h.session.ui.get().lastResult?.repeatedMistakes).toBeUndefined()
  })

  it('a speed change keeps the repeated-mistake count across passes', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    pass(h, 61)
    pass(h, 61)
    h.session.setSelection({ multiplier: 0.8 })
    await h.session.start()
    pass(h, 61)
    expect(h.attempts).toHaveLength(3)
    expect(h.session.ui.get().lastResult?.repeatedMistakes).toMatchObject([
      { group: 1, occ: 0, bar: '1', expectedPitch: 62, wrongPitch: 61, passes: 3 },
    ])
  })

  it('a loop whose start edge moves by one note keeps the repeated-mistake count', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    pass(h, 61)
    pass(h, 61)
    // Shift loop start forward by one quarter note (from C to D): D moves from group 1 to group 0.
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 0, start: { n: 1, d: 4 } } })
    h.session.restart()
    ready(h)
    expect(h.session.engine.timeline.groups.map((g) => g.pitches)).toEqual([[62], [64], [60, 64]])
    h.tap(61)
    h.step(300)
    h.play(62)
    if (h.session.engine.state.onceMore) {
      h.step(CHORD_SLIP_MS)
      h.play(62)
    }
    h.step(CHORD_SLIP_MS + 10)
    h.play(64, 60, 64)
    h.step(200)
    expect(h.attempts).toHaveLength(3)
    expect(h.session.ui.get().lastResult?.repeatedMistakes).toMatchObject([
      { group: 0, occ: 0, bar: '1', expectedPitch: 62, wrongPitch: 61, passes: 3 },
    ])
  })

  it('after a failed pass and a manual Restart, pressing the next note inside the hold of the guarded first note is held as pending and accepted, not graded wrong', async () => {
    // Fast tempo (quarter = 50 ms) so gate 1 arrives after group 0's 90 ms hold while D4 is still within early-press grace.
    const fast = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 1, midi: 62 },
        { at: 2, midi: 64 },
        { at: 3, midi: 65 },
      ],
      bars: 1,
      tempo: { bpm: 1200 },
    })
    const h = harness(fast, { range: loop })
    await h.session.start()
    // Fail on group 0 (C4) with extra key 61, then finish bar 1.
    h.play(60)
    h.tap(61)
    h.play(62, 64, 65)
    h.step(200)
    expect(h.attempts[0]?.passed).toBe(false)

    // Manual restart: group 0 is still guarded for 61.
    h.session.restart()
    ready(h)
    // Press C4 (starts guarded confirmation hold), then press the next note D4 (62) inside the hold.
    h.play(60)
    h.step(20)
    h.tap(62)
    // Let the confirmation hold end and group 1's gate arrive: D4 is accepted, not graded wrong.
    h.step(CHORD_SLIP_MS + 60)
    expect(h.session.engine.state.groupIndex).toBe(2)
    h.play(64, 65)
    h.step(200)
    expect(h.attempts[1]).toMatchObject({ completion: 'completed', passed: true, wrongAttacks: 0 })
  })

  it('after a manual Restart and after an abandoned pass, the next pass still holds on the guarded key', async () => {
    const h = harness(score, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    // First pass: extra F4 (65) after the C-E chord (group 3), then finish bar 2.
    h.play(60, 62, 64, 60, 64)
    h.step(20)
    h.tap(65)
    h.play(67)
    h.step(200)

    // Manual restart: next pass must still hold on 65 at group 3.
    h.session.restart()
    ready(h)
    h.play(60, 62, 64)
    h.step(1000)
    h.tap(65, 60, 64)
    h.step(CHORD_SLIP_MS * 2)
    expect(h.session.engine.state).toMatchObject({ groupIndex: 3, retryGroup: true })
    expect(h.session.feedback.get().cue).toEqual({ kind: 'retry' })

    // Abandon mid-pass (pause + restart): the guarded key from the abandoned pass still holds next pass.
    h.session.pause()
    h.session.restart()
    ready(h)
    h.play(60, 62, 64)
    h.step(1000)
    h.tap(65, 60, 64)
    h.step(CHORD_SLIP_MS * 2)
    expect(h.session.engine.state).toMatchObject({ groupIndex: 3, retryGroup: true })
    expect(h.session.feedback.get().cue).toEqual({ kind: 'retry' })
  })

  it('seedSpots folds stored records asynchronously, informs review counts, ignores mismatched scope, and never arms the retry hold', async () => {
    // Produce two real scored records with wrong key 65 at the C-E chord (group 3) and 61 at D (group 1).
    const producer = harness(score, { range: { fromOcc: 0, toOcc: 1 } })
    await producer.session.start()
    for (let i = 0; i < 2; i++) {
      ready(producer)
      producer.play(60)
      producer.step(300)
      producer.tap(61)
      producer.step(CHORD_SLIP_MS)
      producer.play(62)
      if (producer.session.engine.state.onceMore) {
        producer.step(CHORD_SLIP_MS)
        producer.play(62)
      }
      producer.step(CHORD_SLIP_MS)
      producer.play(64, 60, 64)
      producer.step(20)
      producer.tap(65)
      if (producer.session.engine.state.retryGroup) {
        // The rest of the strike is discarded (P33): strike the chord again after it.
        producer.step(STRIKE_GAP_MS)
        producer.play(60, 64)
        producer.step(CHORD_SLIP_MS)
      }
      producer.play(67)
      producer.step(200)
    }
    expect(producer.attempts).toHaveLength(2)
    const stored = producer.attempts.slice(0, 2).map((r, idx) => ({ ...r, id: `stored-${idx}` }))
    const wrongVersion = { ...stored[0]!, id: 'other-ver', context: { ...stored[0]!.context, scoreVersionId: 'other' } }
    const wrongHands = { ...stored[0]!, id: 'other-hands', context: { ...stored[0]!.context, handsId: 'other' } }

    // Fresh session (later in time): seed with the two stored records (newest first to test sorting) + mismatched ones.
    const h = harness(score, { range: { fromOcc: 0, toOcc: 1 } })
    h.clock.now = 100_000
    const timersBefore = h.clock.pendingTimers
    h.session.seedSpots([stored[1]!, wrongVersion, wrongHands, stored[0]!])
    // Nothing folded synchronously: a timer was queued.
    expect(h.clock.pendingTimers).toBeGreaterThan(timersBefore)

    // Flush seed timers, then play the first live pass.
    await h.session.start()
    h.clock.advance(0)
    ready(h)
    h.play(60)
    h.step(300)
    h.tap(61)
    h.step(CHORD_SLIP_MS)
    h.play(62)
    h.step(CHORD_SLIP_MS)
    h.play(64)
    h.step(1000)
    // On this first live pass, pressing the seeded wrong key 65 with the C-E chord must NOT trigger retry hold.
    h.tap(65, 60, 64)
    h.step(CHORD_SLIP_MS * 2)
    expect(h.session.engine.state.retryGroup).toBe(false)
    expect(h.session.engine.state.groupIndex).toBe(4)
    h.play(67)
    h.step(200)

    // Review counts include the 2 seeded passes + 1 live pass = 3 passes running (mismatched records ignored).
    expect(h.session.ui.get().lastResult?.repeatedMistakes).toMatchObject([
      { group: 1, wrongPitch: 61, passes: 3 },
      { group: 3, wrongPitch: 65, passes: 3 },
    ])

    // Confirm nothing is folded synchronously inside seedSpots: seeding a 4th record does not appear until timers run.
    const extraStored = { ...stored[0]!, id: 'extra-seed', createdAt: stored[0]!.createdAt - 1000 }
    h.session.seedSpots([extraStored])
    expect(h.session.resultDetails()!.spots.get(1)).toHaveLength(3)
    h.clock.advance(0)
    expect(h.session.resultDetails()!.spots.get(1)).toHaveLength(4)
  })

  it('seedSpots folds the passes of different loops in time order: a place played clean since stays forgotten', async () => {
    const both = harness(score, { range: { fromOcc: 0, toOcc: 1 } })
    await both.session.start()
    for (let i = 0; i < 4; i++) {
      pass(both, null)
      both.play(67)
      both.step(200)
    }
    const barOne = harness(score, { range: loop })
    await barOne.session.start()
    pass(barOne, 61)
    // Bars 1–2 clean, then bar 1 alone with 61 for D, then bars 1–2 clean three times: D recovered.
    const order = [both.attempts[0]!, barOne.attempts[0]!, ...both.attempts.slice(1, 4)]
    const stored = order.map((r, i) => ({ ...r, id: `stored-${i}`, createdAt: 1000 * (i + 1) }))
    expect(stored.map((r) => r.completion)).toEqual(Array(5).fill('completed'))

    const h = harness(score, { range: loop })
    h.clock.now = 100_000
    h.session.seedSpots(stored)
    h.clock.advance(0)
    await h.session.start()
    pass(h, 61)
    // Only this pass at D: the stored wrong visit was followed by three clean ones.
    expect(h.session.resultDetails()!.spots.get(1)).toHaveLength(1)
  })

  it('Keep time (strict) passes fold into spot memory but never arm the retry hold', async () => {
    const h = harness(score, { range: loop }, { options: { mode: 'time' } })
    await h.session.start()
    // Wait out count-in into running.
    for (let k = 0; k < 500 && h.session.engine.state.phase !== 'running'; k++) h.step(20)
    expect(h.session.engine.state.phase).toBe('running')
    // Press wrong key 61 at group 0 (C4), then play through.
    h.tap(61)
    h.tap(60)
    for (let k = 0; k < 500 && h.attempts.length < 1; k++) h.step(50)
    expect(h.attempts).toHaveLength(1)
    const details = h.session.resultDetails()
    expect(details?.spots.get(0)?.length).toBe(1)

    // Next Keep time pass: pressing 61 again must NOT arm retry hold.
    for (let k = 0; k < 500 && h.session.engine.state.phase !== 'running'; k++) h.step(20)
    h.tap(61)
    h.tap(60)
    h.step(CHORD_SLIP_MS * 2)
    expect(h.session.engine.state.retryGroup).toBe(false)
  })
})

describe('the expanded result card’s details (U99)', () => {
  it('ranks the last result’s mistakes on demand; nothing without a result', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    expect(h.session.resultDetails()).toBeNull()
    pass(h, 61)
    pass(h, 61)
    const details = h.session.resultDetails()!
    expect(details.attemptId).toBe(h.session.ui.get().lastResult!.id)
    expect(details.records.at(-1)!.id).toBe(details.attemptId)
    expect(rankMistakes(details.records.at(-1), details.timeline, score, details.marks, details.spots)).toMatchObject([
      {
        level: 'habit',
        group: 1,
        bar: '1',
        reason: 'Same wrong key twice now',
        presses: [{ pitch: 61, kind: 'accidental', expectedPitch: 62, passes: 2 }],
        mark: { kind: 'accidental' },
      },
    ])
    // Asking changes nothing: the same answer, the same result, no records written.
    const attempts = h.attempts.length
    expect(h.session.resultDetails()).toEqual(details)
    expect(h.attempts).toHaveLength(attempts)
    // A started but interrupted repeat keeps the previous completed pass under the card.
    ready(h)
    h.tap(30)
    h.session.pause()
    expect(h.attempts.at(-1)?.completion).toBe('interrupted')
    expect(h.session.resultDetails()).toEqual(details)
    // Hide: no result, no details.
    h.session.dismissResult()
    expect(h.session.resultDetails()).toBeNull()
  })

  it('resultDetails().spots holds the visit history for groups with memory, and rankMistakes reports repeated, habit and trouble from it', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    // Pass 1: wrong 61 at group 1 (D), wrong 63 at group 2 (E)
    ready(h)
    h.play(60)
    h.step(300)
    h.tap(61)
    h.step(CHORD_SLIP_MS)
    h.play(62)
    h.step(300)
    h.tap(63)
    h.step(CHORD_SLIP_MS)
    h.play(64, 60, 64)
    h.step(200)

    // Pass 2: wrong 61 at group 1 (D), wrong 65 at group 2 (E), wrong 65 at group 3 (C-E)
    ready(h)
    h.play(60)
    h.step(300)
    h.tap(61)
    h.step(CHORD_SLIP_MS)
    h.play(62)
    if (h.session.engine.state.onceMore) {
      h.step(CHORD_SLIP_MS)
      h.play(62)
    }
    h.step(300)
    h.tap(65)
    h.step(CHORD_SLIP_MS)
    h.play(64)
    h.step(300)
    h.tap(65)
    h.step(CHORD_SLIP_MS)
    h.play(60, 64)
    h.step(200)

    // Pass 3 (at a different speed!): wrong 61 at group 1 (repeated=3), wrong 66 at group 2 (trouble=3 of 3), wrong 65 at group 3 (habit=2)
    h.session.setSelection({ multiplier: 0.8 })
    await h.session.start()
    ready(h)
    h.play(60)
    h.step(300)
    h.tap(61)
    h.step(CHORD_SLIP_MS)
    h.play(62)
    if (h.session.engine.state.onceMore) {
      h.step(CHORD_SLIP_MS)
      h.play(62)
    }
    h.step(300)
    h.tap(66)
    h.step(CHORD_SLIP_MS)
    h.play(64)
    h.step(300)
    h.tap(65)
    h.step(CHORD_SLIP_MS)
    h.play(60, 64)
    if (h.session.engine.state.onceMore) {
      h.step(CHORD_SLIP_MS)
      h.play(60, 64)
    }
    h.step(200)

    const details = h.session.resultDetails()!
    expect(details.spots.has(0)).toBe(false)
    expect(details.spots.get(1)?.length).toBe(3)
    expect(details.spots.get(2)?.length).toBe(3)
    expect(details.spots.get(3)?.length).toBe(2)
    const ranked = rankMistakes(details.records.at(-1), details.timeline, score, details.marks, details.spots)
    expect(ranked.map((m) => [m.group, m.level])).toEqual([
      [1, 'repeated'],
      [3, 'habit'],
      [2, 'trouble'],
    ])
  })

  it('keeps the completed pass’s details after a wrong key and Pause on the next pass', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    pass(h, 61)
    const completedId = h.session.ui.get().lastResult!.id
    ready(h)
    h.tap(61)
    h.session.pause()
    expect(h.session.ui.get().lastResult?.id).toBe(completedId)
    const details = h.session.resultDetails()
    expect(details).not.toBeNull()
    expect(details!.attemptId).toBe(completedId)
    expect(details!.records.at(-1)!.id).toBe(completedId)
    expect(
      rankMistakes(details!.records.at(-1), details!.timeline, score, details!.marks, details!.spots).length,
    ).toBeGreaterThan(0)
  })

  it('caps resultDetails().spots at the shown result’s pass when a later interrupted pass folds', async () => {
    // Part 1: repeated wrong key at group 0 (C4), then a different wrong key at group 0 in an interrupted pass.
    const h = harness(score, { range: loop })
    await h.session.start()
    for (let i = 0; i < 3; i++) {
      ready(h)
      h.tap(61)
      h.step(300)
      h.play(60)
      if (h.session.engine.state.onceMore) {
        h.step(CHORD_SLIP_MS)
        h.play(60)
      }
      h.step(CHORD_SLIP_MS)
      h.play(62, 64, 60, 64)
      h.step(200)
    }
    const completedId = h.session.ui.get().lastResult!.id
    expect(h.session.ui.get().lastResult?.repeatedMistakes).toMatchObject([{ group: 0, wrongPitch: 61, passes: 3 }])

    // Next pass becomes Ready; player taps a different wrong key (63) at group 0 and pauses.
    ready(h)
    h.tap(63)
    h.session.pause()
    expect(h.session.ui.get().lastResult?.id).toBe(completedId)

    const details = h.session.resultDetails()!
    const visitsAt0 = details.spots.get(0)!
    expect(visitsAt0).toHaveLength(3)
    expect(visitsAt0.at(-1)?.attemptId).toBe(completedId)
    expect(rankMistakes(details.records.at(-1), details.timeline, score, details.marks, details.spots)).toMatchObject([
      {
        level: 'repeated',
        group: 0,
        presses: [{ pitch: 61, passes: 3 }],
      },
    ])

    // Part 2: repeated wrong key at group 1 (D4) while group 0 is clean; interrupted next pass goes wrong at group 0.
    const h2 = harness(score, { range: loop })
    await h2.session.start()
    pass(h2, 61)
    pass(h2, 61)
    pass(h2, 61)
    const completedId2 = h2.session.ui.get().lastResult!.id

    ready(h2)
    h2.tap(63)
    h2.session.pause()
    expect(h2.session.ui.get().lastResult?.id).toBe(completedId2)

    const details2 = h2.session.resultDetails()!
    expect(details2.spots.has(0)).toBe(false)
    expect(details2.spots.get(1)?.at(-1)?.attemptId).toBe(completedId2)
    expect(
      rankMistakes(details2.records.at(-1), details2.timeline, score, details2.marks, details2.spots),
    ).toMatchObject([
      {
        level: 'repeated',
        group: 1,
        presses: [{ pitch: 61, passes: 3 }],
      },
    ])
  })

  it('publishes once-more stage cue instead of retry when a lone guarded wrong key takes back the first clean stroke', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    // Pass 1: wrong key 61 pressed alone before D4 (group 1).
    pass(h, 61)

    // Pass 2: repeat wrong key 61 alone -> retry cue ("Try again"); first D4 taken back -> once-more cue ("Once more").
    ready(h)
    h.play(60)
    h.step(300)
    h.tap(61)
    expect(h.session.feedback.get().cue).toEqual({ kind: 'retry' })

    h.step(CHORD_SLIP_MS + 20)
    h.play(62)
    expect(h.session.engine.state.onceMore).toBe(true)
    expect(h.session.feedback.get().cue).toEqual({ kind: 'once-more' })

    // Second clean D4 completes the group and clears the cue.
    h.step(CHORD_SLIP_MS + 20)
    h.play(62)
    h.step(200)
    expect(h.session.engine.state.onceMore).toBe(false)
    expect(h.session.feedback.get().cue).toBeNull()
  })
})

describe('a key pressed with the final chord (P24)', () => {
  it('is counted: the pass fails and its last group carries the wrong key', async () => {
    const h = harness(score, { range: loop }, { deps: { finalSlipMs: CHORD_SLIP_MS } })
    await h.session.start()
    h.play(60, 62, 64, 60, 64)
    // The chord's last right key is in; an extra F arrives 20 ms later.
    expect(h.attempts).toHaveLength(0)
    h.step(20)
    h.tap(65)
    h.step(200)
    expect(h.attempts).toHaveLength(1)
    const r = h.attempts[0]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 1, passed: false })
    expect(r.groups!.at(-1)).toMatchObject({ group: 3, wrongPitches: [65] })
    expect(h.session.ui.get().lastResult).toMatchObject({ passed: false, wrongAttacks: 1, streak: 0 })
  })

  it('a clean final chord still passes, just after the hold', async () => {
    const h = harness(score, { range: loop }, { deps: { finalSlipMs: CHORD_SLIP_MS } })
    await h.session.start()
    h.play(60, 62, 64, 60, 64)
    h.step(CHORD_SLIP_MS + 20)
    expect(h.attempts.map((a) => [a.completion, a.passed])).toEqual([['completed', true]])
  })
})
