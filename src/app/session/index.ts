/**
 * Practice session coordinator (WP10). Framework-free; see README.md.
 */
export { PracticeSession, REVEAL_FALLBACK_S, occAt, type SessionOptions } from './PracticeSession'
export { LADDER_DEFAULT_TARGET, LADDER_DROP_AFTER, LADDER_STEP } from './ladder'
export { PersistentLabels, labelSnapshot, mergeOpacity } from './labels'
export { accompanimentAllowed, hasSoundOutput } from './output'
export { metronomeOn, metronomePatch, metronomeScope, type MetronomeScope } from './metronome'
export { createPieceSaver, type PieceSaver } from './persistence'
export { practiceModel, practiceTempoMissing } from './model'
export { REPEATED_MISTAKE_PASSES, repeatedMistakeLine, repeatedMistakes, type RepeatedMistake } from './mistakes'
export type { GroupMark, MistakeLevel, PressKind, RankedMistake, WrongPress } from './ranking'
export {
  HAND_TEXT,
  clampPassage,
  passageSummary,
  rangeText,
  sameRange,
  selectionTimeline,
  startPlan,
  tempoText,
  type Selection,
  type StartPlan,
} from './selection'
export { Store, shallowEqual, type ReadonlyStore } from './store'
export type * from './types'
