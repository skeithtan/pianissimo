import type { PracticeEnv } from '../practice/env'
import { RecordingError, type PerformanceInput } from '../../app/audio/performanceInput'
import type { MidiInputEvent } from '../../core/midi/types'
import { handAssignmentId, passageKey, type PassageRange } from '../../core/model/practice'
import type { ScoreModel } from '../../core/model/score'
import { midiFile } from '../../core/recording/performance'
import type { RecordingInfo } from '../../core/recording/records'
import { passageFields } from './passageLabel'
import { scoreTake, takeTimeline } from './scoreTake'
import { unsaved, type SavedTake } from './unsaved'
import { msg } from '../../i18n/messages'

export interface TakeTarget {
  pieceId: string
  title: string
  model: ScoreModel
  range: PassageRange | null
  hands: RecordingInfo['hands']
  env: PracticeEnv
}
export function beginTake(target: TakeTarget, input: PerformanceInput, onLost: () => void) {
  const { model, hands, range, env } = target
  const timeline = takeTimeline(model, hands, range)
  if (!timeline.groups.length) throw new RecordingError(msg('This passage has no notes for the selected hands.'))
  const groups = timeline.groups.map((g) => g.pitches)
  const events: MidiInputEvent[] = []
  const midi = env.midi()
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  const startUtcOffsetMinutes = -new Date(createdAt).getTimezoneOffset()
  input.start()
  const start = env.clock()
  const off = midi.subscribe((e) => {
    if (e.time >= start) events.push(e)
  })
  const offRoute = midi.onRoute((e) => {
    if (e.kind === 'input-disconnected') onLost()
  })
  /** The capture ends here and the input closes. */
  function end() {
    const at = env.clock()
    off()
    offRoute()
    return { at, audio: input.stop() }
  }
  async function save(ended: ReturnType<typeof end>, interrupted: boolean): Promise<SavedTake> {
    const audio = await ended.audio
    const played = events.flatMap((e) => (e.kind === 'noteon' ? [e.note] : []))
    const result = await scoreTake(groups, played)
    const info: RecordingInfo = {
      id,
      pieceId: target.pieceId,
      title: target.title,
      context: JSON.stringify([
        target.pieceId,
        model.scoreVersionId,
        handAssignmentId(model.hands),
        hands,
        passageKey(timeline.range),
      ]),
      ...passageFields(model, range, hands),
      hands,
      input: input.label,
      createdAt,
      startUtcOffsetMinutes,
      durationMs: Math.max(0, ended.at - start),
      score: result.score,
      interrupted: interrupted || audio.size <= 44,
      playedThrough: result.playedThrough,
    }
    const take = { info, files: { midi: midiFile(events, start, ended.at), audio } }
    unsaved.set(id, take)
    await (await env.storage()).saveRecording(info, take.files)
    unsaved.delete(id)
    return take
  }
  let finished: Promise<SavedTake> | null = null
  return {
    stop: (interrupted: boolean): Promise<SavedTake> => (finished ??= save(end(), interrupted)),
    /** Stop without saving. The take is kept in memory while the result is: calling it saves it after all. */
    discard(): () => Promise<SavedTake> {
      const ended = end()
      ended.audio.catch(() => undefined)
      return () => (finished ??= save(ended, false))
    },
  }
}
