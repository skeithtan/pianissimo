/**
 * Practice session coordinator (WP10). Framework-free; see README.md.
 */
export { PracticeSession, occAt, type SessionOptions } from './PracticeSession'
export { PersistentLabels, labelSnapshot, mergeOpacity } from './labels'
export { accompanimentAllowed, hasSoundOutput } from './output'
export { createPieceSaver, type PieceSaver } from './persistence'
export { practiceModel, practiceTempoMissing } from './model'
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
