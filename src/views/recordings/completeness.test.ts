import { expect, it } from 'vitest'
import { importFixture } from '../../../tests/unit/import/fixtures'
import type { MidiInputEvent } from '../../core/midi/types'
import { passageKey, type PassageRange } from '../../core/model/practice'
import { midiFile, scorePerformance } from '../../core/recording/performance'
import type { RecordingInfo } from '../../core/recording/records'
import type { PianissimoStorage } from '../../core/storage'
import { isIncomplete, takePlayedThrough } from './completeness'
import { takeTimeline } from './scoreTake'

const { package: pkg } = await importFixture('two-hands.musicxml')
const model = pkg.model

/** A take as it was stored before `playedThrough` was: its notes are only in its MIDI file. */
async function early(id: string, play: (notes: number[]) => number[], range: PassageRange | null = null) {
  const timeline = takeTimeline(model, 'both', range)
  const groups = timeline.groups.map((g) => [...g.pitches])
  const played = play(groups.flat())
  const events = played.map((note, i): MidiInputEvent => ({
    kind: 'noteon',
    note,
    velocity: 80,
    time: i * 200,
    channel: 0,
    seq: i,
    portId: 'p',
  }))
  const info: RecordingInfo = {
    id,
    pieceId: 'p',
    title: 'Two Hands',
    context: JSON.stringify(['p', model.scoreVersionId, 'h', 'both', passageKey(timeline.range)]),
    passage: 'Whole piece',
    passageRange: range,
    hands: 'both',
    createdAt: 0,
    durationMs: 4000,
    input: 'Piano',
    score: scorePerformance(groups, played),
    interrupted: false,
  }
  const midi = await midiFile(events, 0, 60_000).arrayBuffer()
  return { info, storage: { getRecordingMidi: async () => midi } as unknown as PianissimoStorage }
}
const judge = ({ info, storage }: Awaited<ReturnType<typeof early>>, score = model) =>
  takePlayedThrough(info, async () => score, storage)

it('judges an earlier take from its MIDI file and its score', async () => {
  expect(await judge(await early('all', (notes) => notes))).toBe(true)
  expect(await judge(await early('wrong', (notes) => notes.map((n, i) => (i === 3 ? n + 1 : n))))).toBe(true)
  expect(await judge(await early('stopped', (notes) => notes.slice(0, 4)))).toBe(false)
  expect(await judge(await early('bar', (notes) => notes, { fromOcc: 0, toOcc: 0 }))).toBe(true)
  // Before ranges were stored, the comparison context names the bars.
  const { info, storage } = await early('keyed', (notes) => notes, { fromOcc: 0, toOcc: 0 })
  const { passageRange: _, ...keyed } = info
  expect(await judge({ info: keyed, storage })).toBe(true)
})

it('cannot tell when the take’s own score does not come out again, or its score or files are gone', async () => {
  const { info, storage } = await early('rescored', (notes) => notes.slice(0, 4))
  expect(await judge({ info: { ...info, score: { ...info.score, played: 9 } }, storage })).toBeNull()
  const gone = await early('gone', (notes) => notes.slice(0, 4))
  expect(await takePlayedThrough(gone.info, async () => undefined, gone.storage)).toBeNull()
  const lost = await early('lost', (notes) => notes.slice(0, 4))
  const empty = { getRecordingMidi: async () => undefined } as unknown as PianissimoStorage
  expect(await judge({ info: lost.info, storage: empty })).toBeNull()
})

it('counts a take that cannot be told as incomplete only if interrupted, and one still to be judged never', async () => {
  const { info } = await early('any', (notes) => notes)
  const interrupted = { ...info, interrupted: true }
  expect([isIncomplete(info, null), isIncomplete(interrupted, null)]).toEqual([false, true])
  expect([isIncomplete(interrupted, undefined), isIncomplete(interrupted, true)]).toEqual([false, false])
  expect([isIncomplete(info, false), isIncomplete({ ...info, playedThrough: false }, undefined)]).toEqual([true, true])
})
