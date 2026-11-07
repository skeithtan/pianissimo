/**
 * Practice engine public API (pure, framework-independent). See README.md.
 */
export {
  PracticeEngine,
  defaultTransport,
  matchingRulesFor,
  DEFAULT_PEDAL_DOWN_THRESHOLD,
  DEFAULT_WRONG_FEEDBACK_MS,
  EARLY_PRESS_GRACE_MS,
} from './engine'
export {
  buildTimeline,
  applicableOttavas,
  barLabel,
  groupAtOrAfter,
  transportGates,
  type AutomaticPosition,
  type LearnerHands,
  type OnsetGroup,
  type ScoredBlocker,
  type Timeline,
  type TimelineMeasure,
  type TimelineOptions,
} from './timeline'
export {
  PlayFollower,
  patienceMs,
  LOOKAHEAD_GROUPS,
  LOOKBEHIND_GROUPS,
  PATIENCE_MIN_MS,
  PATIENCE_MAX_MS,
  PATIENCE_LAST_MS,
  FOLLOW_WRONG_FEEDBACK_MS,
  type FollowerConfig,
  type FollowerEvent,
  type FollowerState,
} from './follow'
export { easeInOut, fadeOutOpacity } from './fade'
export { buildAttemptRecord, comparisonContextOf, READING_UNTIMED } from './attempt'
export type { HintSource } from './hints'
export type { GroupOutcome } from '../model/practice'
export type {
  AttemptStartOptions,
  EngineConfig,
  EngineEvent,
  EngineHintSettings,
  EngineReconfigure,
  EngineSettingsPatch,
  EngineState,
  HintPedalDetector,
  HintView,
  Phase,
  PracticeMode,
  ReadyBlocker,
  TransportEta,
  TransportMode,
  WrongReason,
} from './types'
