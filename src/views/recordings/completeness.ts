import type { PassageRange } from '../../core/model/practice'
import type { ScoreModel } from '../../core/model/score'
import { midiNotes } from '../../core/recording/performance'
import type { RecordingInfo } from '../../core/recording/records'
import type { PianissimoStorage } from '../../core/storage'
import { takePassageKey } from './passageLabel'
import { scoreTake, takeTimeline } from './scoreTake'

/** Found out in this visit, by take. null: it cannot be told. */
const found = new Map<string, boolean | null>()

/** A take's passage (null: the whole piece). undefined: an early take of part of a bar does not say. */
function passageOf(info: RecordingInfo): PassageRange | null | undefined {
  if (info.passageRange !== undefined) return info.passageRange
  const bars = /^(\d+)-(\d+)$/.exec(takePassageKey(info) ?? '')
  return bars ? { fromOcc: Number(bars[1]), toOcc: Number(bars[2]) } : undefined
}

async function work(info: RecordingInfo, model: ScoreModel | undefined, storage: PianissimoStorage) {
  const range = passageOf(info)
  if (!model || range === undefined) return null
  const groups = takeTimeline(model, info.hands, range).groups.map((g) => g.pitches)
  const midi = await storage.getRecordingMidi(info.id)
  if (!midi) return null
  const { score, playedThrough } = await scoreTake(groups, midiNotes(midi))
  // Only where the take's own score comes out again: otherwise these are not the notes it was scored
  // with (the hands were assigned anew since), and it must not count as incomplete for that.
  const { expected, played, matched } = info.score
  const same = score.expected === expected && score.played === played && score.matched === matched
  return same ? playedThrough : null
}

/**
 * Was this take played through? New takes say so. For an earlier one it is worked out from its MIDI
 * file and the score of its version; null when that score is gone or no longer the same.
 */
export async function takePlayedThrough(
  info: RecordingInfo,
  modelOf: (info: RecordingInfo) => Promise<ScoreModel | undefined>,
  storage: PianissimoStorage,
): Promise<boolean | null> {
  if (info.playedThrough !== undefined) return info.playedThrough
  const known = found.get(info.id)
  if (known !== undefined) return known
  let result: boolean | null = null
  try {
    result = await work(info, await modelOf(info), storage)
  } catch {
    // A passage its score no longer has, or files that cannot be read.
  }
  found.set(info.id, result)
  return result
}

/**
 * Not played from the start of its passage to the end. One that cannot be told (null) is, if it was
 * interrupted; one that is still to be judged (undefined) is not.
 */
export function isIncomplete(info: RecordingInfo, through: boolean | null | undefined): boolean {
  const known = info.playedThrough ?? through
  return known === undefined ? false : known === null ? info.interrupted : !known
}
