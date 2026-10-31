import type { AttemptRecord } from '../model/practice'
import type { Db } from './schema'
import { observed, runTx } from './tx'

export type AttemptQuery =
  | { readonly pieceId: string; readonly contextKey?: string; readonly scoreVersionId?: string }
  | { readonly pieceId?: undefined; readonly contextKey: string; readonly scoreVersionId?: string }

/** Store attempt records in one transaction. Re-adding a record with the same id replaces it. */
export async function addAttempts(db: Db, records: readonly AttemptRecord[]): Promise<void> {
  if (records.length === 0) return
  const tx = db.transaction('attempts', 'readwrite')
  await runTx(tx, () => Promise.all(records.map((r) => observed(tx.store.put(r)))))
}

/**
 * Attempts for a piece and/or one comparison context, oldest first. Results are only ever
 * compared within one context (spec "Results and timing"), so callers normally pass
 * `contextKey`; a piece alone returns every context (and every score version it ever had:
 * pass `scoreVersionId` for the current one).
 */
export async function listAttempts(db: Db, query: AttemptQuery): Promise<AttemptRecord[]> {
  const records =
    query.contextKey !== undefined
      ? await db.getAllFromIndex('attempts', 'contextKey', query.contextKey)
      : await db.getAllFromIndex('attempts', 'pieceId', query.pieceId)
  const filtered = records.filter(
    (r) =>
      (query.pieceId === undefined || r.pieceId === query.pieceId) &&
      (query.scoreVersionId === undefined || r.context.scoreVersionId === query.scoreVersionId),
  )
  return filtered.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export function getAttempt(db: Db, id: string): Promise<AttemptRecord | undefined> {
  return db.get('attempts', id)
}
