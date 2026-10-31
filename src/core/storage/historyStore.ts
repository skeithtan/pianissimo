import type { AbandonEvent, AttemptRecord } from '../model/practice'
import { barKey, emptyPieceHistory } from '../history/types'
import type { BarRecord, HistoryChanges, PieceHistory } from '../history/types'
import type { AbandonRecord, SuggestionStateRecord } from './records'
import type { BarStoreKey, Db } from './schema'
import { observed, runTx } from './tx'

/** Split `barKey(measureContextKey, occ)` back into its parts. */
export function splitBarKey(key: string): { measureContextKey: string; occ: number } | null {
  const at = key.lastIndexOf('#')
  if (at <= 0) return null
  const occ = Number(key.slice(at + 1))
  return Number.isInteger(occ) ? { measureContextKey: key.slice(0, at), occ } : null
}

/** Assemble a piece's measure histories, suggestions and abandon events. */
export async function loadPieceHistory(db: Db, pieceId: string): Promise<PieceHistory> {
  const tx = db.transaction(['measureHistory', 'suggestionState', 'abandonEvents'], 'readonly')
  const [bars, state, abandonRecords] = await runTx(tx, () =>
    Promise.all([
      tx.objectStore('measureHistory').index('pieceId').getAll(pieceId),
      tx.objectStore('suggestionState').get(pieceId),
      tx.objectStore('abandonEvents').index('pieceId').getAll(pieceId),
    ]),
  )

  const barMap: Record<string, BarRecord> = {}
  for (const bar of bars) barMap[barKey(bar.measureContextKey, bar.occ)] = bar
  const abandons: Record<string, readonly AbandonEvent[]> = {}
  for (const record of abandonRecords) abandons[barKey(record.measureContextKey, record.occ)] = record.events
  return {
    ...emptyPieceHistory(pieceId),
    disabled: state?.disabled ?? false,
    bars: barMap,
    suggestions: state?.suggestions ?? [],
    abandons,
  }
}

/** The result of ingesting items for one piece, ready to persist. */
export interface HistoryUpdate {
  readonly history: PieceHistory
  readonly changes: HistoryChanges
}

export interface HistoryBatch {
  readonly attempts: readonly AttemptRecord[]
  readonly updates: readonly HistoryUpdate[]
}

/**
 * Persist attempts and the history records they changed in one transaction: only the bars,
 * the suggestion state and the abandon lists named in `changes` are written.
 */
export async function commitHistory(db: Db, batch: HistoryBatch): Promise<void> {
  const tx = db.transaction(['attempts', 'measureHistory', 'suggestionState', 'abandonEvents'], 'readwrite')
  await runTx(tx, async () => {
    const writes: Promise<unknown>[] = []
    for (const attempt of batch.attempts) writes.push(observed(tx.objectStore('attempts').put(attempt)))
    for (const { history, changes } of batch.updates) {
      for (const bar of changes.bars) {
        const key: BarStoreKey = [history.pieceId, barKey(bar.measureContextKey, bar.occ)]
        writes.push(observed(tx.objectStore('measureHistory').put(bar, key)))
      }
      if (changes.suggestionsChanged) {
        const state: SuggestionStateRecord = {
          pieceId: history.pieceId,
          disabled: history.disabled,
          suggestions: history.suggestions,
        }
        writes.push(observed(tx.objectStore('suggestionState').put(state)))
      }
      for (const key of changes.abandonKeys) {
        const parts = splitBarKey(key)
        if (!parts) continue
        const events = history.abandons[key] ?? []
        const storeKey: BarStoreKey = [history.pieceId, key]
        if (events.length === 0) {
          writes.push(observed(tx.objectStore('abandonEvents').delete(storeKey)))
        } else {
          const record: AbandonRecord = { pieceId: history.pieceId, ...parts, events }
          writes.push(observed(tx.objectStore('abandonEvents').put(record, storeKey)))
        }
      }
    }
    await Promise.all(writes)
  })
}

/** Per-piece "disable suggestions": evidence keeps being recorded (spec "Recognizing improvement"). */
export async function setPieceSuggestionsDisabled(db: Db, pieceId: string, disabled: boolean): Promise<void> {
  const tx = db.transaction('suggestionState', 'readwrite')
  await runTx(tx, async () => {
    const current = await tx.store.get(pieceId)
    await tx.store.put({ pieceId, disabled, suggestions: current?.suggestions ?? [] })
  })
}

export interface ClearOptions {
  /** Also delete the piece's attempt records (scorecards, best times, streaks). Default false. */
  readonly attempts?: boolean
}

/**
 * "Clear the piece's practice history" (spec "Recognizing improvement"): measure histories,
 * suggestions (active and improved) and abandon events are removed; the per-piece disable
 * switch is kept. Attempt records are removed only on request.
 */
export async function clearPieceHistory(db: Db, pieceId: string, options: ClearOptions = {}): Promise<void> {
  const tx = db.transaction(['measureHistory', 'suggestionState', 'abandonEvents', 'attempts'], 'readwrite')
  await runTx(tx, async () => {
    const [barKeys, abandonKeys, state] = await Promise.all([
      tx.objectStore('measureHistory').index('pieceId').getAllKeys(pieceId),
      tx.objectStore('abandonEvents').index('pieceId').getAllKeys(pieceId),
      tx.objectStore('suggestionState').get(pieceId),
    ])
    const writes: Promise<unknown>[] = [
      ...barKeys.map((k) => tx.objectStore('measureHistory').delete(k)),
      ...abandonKeys.map((k) => tx.objectStore('abandonEvents').delete(k)),
    ]
    if (state) {
      writes.push(
        observed(tx.objectStore('suggestionState').put({ pieceId, disabled: state.disabled, suggestions: [] })),
      )
    }
    if (options.attempts) {
      const attemptKeys = await tx.objectStore('attempts').index('pieceId').getAllKeys(pieceId)
      for (const k of attemptKeys) writes.push(observed(tx.objectStore('attempts').delete(k)))
    }
    await Promise.all(writes)
  })
}
