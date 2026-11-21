import type { PracticeEnv } from '../practice/env'
import type { PerformanceInput } from '../../app/audio/performanceInput'
import type { MidiInputEvent } from '../../core/midi/types'
import { buildTimeline } from '../../core/engine/timeline'
import { handAssignmentId, passageKey, type PassageRange } from '../../core/model/practice'
import { describePassage } from '../../core/model/passage'
import type { ScoreModel } from '../../core/model/score'
import { midiFile, type NoteScore } from '../../core/recording/performance'
import type { RecordingInfo } from '../../core/recording/records'
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
function score(groups: readonly (readonly number[])[], played: number[]): Promise<NoteScore> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/recordingScore.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<NoteScore>) => {
      worker.terminate()
      resolve(e.data)
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message))
    }
    worker.postMessage({ groups, played })
  })
}

export function beginTake(target: TakeTarget, input: PerformanceInput, onLost: () => void) {
  const { model, hands, range, env } = target
  const timeline = buildTimeline(model, { hands, range, multiplier: 1, reattackHeldAtStart: false })
  if (!timeline.groups.length) throw new Error(msg('This passage has no notes for the selected hands.'))
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
  let finished: Promise<SavedTake> | null = null
  function stop(interrupted: boolean): Promise<SavedTake> {
    if (finished) return finished
    const end = env.clock()
    off()
    offRoute()
    finished = (async () => {
      const audio = await input.stop()
      const played = events.flatMap((e) => (e.kind === 'noteon' ? [e.note] : []))
      const result = await score(groups, played).catch(async () => {
        const { scorePerformance } = await import('../../core/recording/performance')
        return scorePerformance(groups, played)
      })
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
        passage: describePassage(model, range, hands),
        hands,
        input: input.label,
        createdAt,
        startUtcOffsetMinutes,
        durationMs: Math.max(0, end - start),
        score: result,
        interrupted: interrupted || audio.size <= 44,
      }
      const take = { info, files: { midi: midiFile(events, start, end), audio } }
      unsaved.set(id, take)
      await (await env.storage()).saveRecording(info, take.files)
      unsaved.delete(id)
      return take
    })()
    return finished
  }
  return { stop }
}
