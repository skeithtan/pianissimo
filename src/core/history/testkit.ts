/**
 * Builders for history and storage tests. Not imported by application code.
 */
import { contextKey, measureContextKey } from '../model/practice'
import type {
  AbandonEvent,
  AssistanceRecord,
  AttemptRecord,
  ComparisonContext,
  InterruptReason,
  MeasureTraversal,
} from '../model/practice'
import type { MeasureOccurrence } from '../model/score'
import { rat } from '../music/rational'
import { ingestAbandon, ingestAttempt } from './ingest'
import { toMeasureContext } from './contextKey'
import { emptyPieceHistory } from './types'
import type { PieceHistory } from './types'

export const PIECE = 'piece-1'

export function comparisonContext(over: Partial<ComparisonContext> = {}): ComparisonContext {
  return {
    scoreVersionId: 'v1',
    passage: { fromOcc: 10, toOcc: 16 },
    hands: 'both',
    handsId: 'h1',
    tempoMapId: 'tm1',
    multiplier: 1,
    rollPolicy: 'roll-v1',
    transport: 'free',
    matchingRules: 'match-v1',
    ...over,
  }
}

export const MKEY = measureContextKey(toMeasureContext(comparisonContext()))

export type Outcome =
  'clean' | 'error' | 'assisted' | 'label' | 'keyboard' | 'partial' | 'partial-error' | 'partial-hint'

export function traversal(occ: number, outcome: Outcome, wrong = 1): MeasureTraversal {
  const complete = !outcome.startsWith('partial')
  const errors = outcome === 'error' || outcome === 'partial-error' ? wrong : 0
  return {
    occ,
    complete,
    wrongAttacks: errors,
    wrongAttacksExcludingBoundary: errors,
    groupsWithErrors: errors > 0 ? 1 : 0,
    tempHint: outcome === 'assisted' || outcome === 'partial-hint',
    persistentLabel: outcome === 'label',
    keyboard: outcome === 'keyboard',
  }
}

export function noAssistance(): AssistanceRecord {
  return {
    level: 'none',
    persistentLabelNotes: [],
    persistentLabelGroups: [],
    hintRequests: 0,
    autoHints: 0,
    hintGroups: [],
    keyboardShown: false,
    labelSettings: { mode: 'off', rulesJson: '{}' },
  }
}

let counter = 0

export function attemptRecord(over: Partial<AttemptRecord> = {}): AttemptRecord {
  counter += 1
  const context = over.context ?? comparisonContext()
  return {
    id: `a${counter}`,
    pieceId: PIECE,
    createdAt: 1_000 + counter,
    kind: 'scored',
    context,
    contextKey: contextKey(context),
    completion: 'completed',
    wrongAttacks: 0,
    groupsTotal: 8,
    groupsFirstPass: 8,
    completionTimeSec: 8,
    expectedTimeSec: 8,
    notatedDurationSec: 10,
    assistance: noAssistance(),
    passed: true,
    onsets: [],
    measures: [],
    ...over,
  }
}

/** One attempt that traverses the given bars with the given outcomes. */
export function attemptOf(
  specs: ReadonlyArray<readonly [occ: number, outcome: Outcome]>,
  over: Partial<AttemptRecord> = {},
): AttemptRecord {
  return attemptRecord({ measures: specs.map(([occ, o]) => traversal(occ, o)), ...over })
}

/** Feed one single-bar attempt per outcome, in order. Timestamps increase by 10 per attempt. */
export function play(
  history: PieceHistory,
  occ: number,
  outcomes: readonly Outcome[],
  over: { context?: ComparisonContext; start?: number } = {},
): PieceHistory {
  let h = history
  let at = over.start ?? 10_000 + counter * 10
  for (const outcome of outcomes) {
    at += 10
    const a = attemptRecord({
      createdAt: at,
      measures: [traversal(occ, outcome)],
      ...(over.context ? { context: over.context, contextKey: contextKey(over.context) } : {}),
    })
    h = ingestAttempt(h, a, at).history
  }
  return h
}

export function fresh(): PieceHistory {
  return emptyPieceHistory(PIECE)
}

export function abandon(
  history: PieceHistory,
  occ: number,
  reason: InterruptReason,
  at: number,
  key: string = MKEY,
): PieceHistory {
  const event: AbandonEvent = { pieceId: PIECE, measureContextKey: key, occ, at, reason }
  return ingestAbandon(history, event, at).history
}

/** `count` consecutive occurrences numbered 1..count, one pass each. */
export function occurrences(count: number, extra: Partial<MeasureOccurrence> = {}): MeasureOccurrence[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    sourceMeasure: i,
    number: String(i + 1),
    pass: 1,
    start: rat(i),
    duration: rat(1),
    ...extra,
  }))
}
