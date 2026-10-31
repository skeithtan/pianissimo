/**
 * The keyboard guide's highlighted keys (DECISIONS U15): the current targets (pending or already
 * played), what app playback is sounding (Listen, the accompaniment) and the keys the learner
 * holds, each once, low to high, with its note name. Built in the session's frame (never per
 * MIDI event) and published only when something visible changed.
 */
import type { Hand, ScoreModel } from '../../core/model/score'
import type { GuideKey, GuideKeyState } from '../../render/keyboard/types'

export interface GuideInput {
  readonly notes: ScoreModel['notes']
  /** Note indices of the current group (empty in Listen). */
  readonly targetNotes: readonly number[]
  readonly acceptedPitches: readonly number[]
  /** Note indices sounding from app playback, per voice. */
  readonly sounding: Iterable<readonly number[]>
  readonly heldKeys: readonly number[]
  readonly heldWrongKeys: readonly number[]
  /** A score note's name (spelled as written, naming settings applied). */
  readonly noteLabel: (note: number) => string | undefined
  /** A bare key's name (sharps), for held keys the score does not name. */
  readonly keyLabel: (midi: number) => string
}

interface Draft {
  state: GuideKeyState
  hand: Hand | null
  label: string
  held: boolean
}

export function buildGuideKeys(input: GuideInput): GuideKey[] {
  const byMidi = new Map<number, Draft>()
  const add = (note: number, state: GuideKeyState) => {
    const n = input.notes[note]
    if (!n) return
    const existing = byMidi.get(n.midi)
    if (existing) {
      // A unison between hands is drawn neutral; the stronger state wins.
      if (existing.hand !== n.hand) existing.hand = null
      return
    }
    byMidi.set(n.midi, { state, hand: n.hand, label: input.noteLabel(note) ?? input.keyLabel(n.midi), held: false })
  }
  const accepted = new Set(input.acceptedPitches)
  for (const note of input.targetNotes) {
    const n = input.notes[note]
    if (n) add(note, accepted.has(n.midi) ? 'accepted' : 'target')
  }
  for (const voice of input.sounding) for (const note of voice) add(note, 'sounding')
  for (const midi of input.heldKeys) {
    const existing = byMidi.get(midi)
    if (existing) existing.held = true
    else byMidi.set(midi, { state: 'held', hand: null, label: input.keyLabel(midi), held: true })
  }
  for (const midi of input.heldWrongKeys) {
    const existing = byMidi.get(midi)
    if (existing) {
      existing.state = 'wrong'
      existing.held = true
    } else byMidi.set(midi, { state: 'wrong', hand: null, label: input.keyLabel(midi), held: true })
  }
  return [...byMidi.entries()].sort(([a], [b]) => a - b).map(([midi, d]) => ({ midi, ...d }))
}

export function sameGuideKeys(a: readonly GuideKey[], b: readonly GuideKey[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.midi !== y.midi || x.state !== y.state || x.hand !== y.hand || x.label !== y.label || x.held !== y.held)
      return false
  }
  return true
}
