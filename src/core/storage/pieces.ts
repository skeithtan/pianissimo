import type { IDBPTransaction } from 'idb'
import type { ScorePackage, SourceFileRecord } from '../model/score'
import { SCORE_PACKAGE_FORMAT } from '../model/score'
import type { PiecePatch, PieceRecord } from './records'
import type { Db, PianissimoDB, StoreName } from './schema'
import { observed, runTx } from './tx'
import { pieceProblem } from './validate'

function assertPiece(piece: PieceRecord): void {
  const problem = pieceProblem(piece)
  if (problem !== null) throw new TypeError(`Invalid piece record: ${problem}`)
}

function assertPackage(pkg: ScorePackage): void {
  if (pkg.model.format !== SCORE_PACKAGE_FORMAT) {
    throw new TypeError(`Unsupported score package format ${String(pkg.model.format)}`)
  }
  if (pkg.model.scoreVersionId === '') throw new TypeError('Score package has no scoreVersionId')
}

/** Library entries, most recently opened first. */
export async function listPieces(db: Db): Promise<PieceRecord[]> {
  const all = await db.getAll('pieces')
  return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.title.localeCompare(b.title))
}

export function getPiece(db: Db, id: string): Promise<PieceRecord | undefined> {
  return db.get('pieces', id)
}

export async function putPiece(db: Db, piece: PieceRecord): Promise<void> {
  assertPiece(piece)
  await db.put('pieces', piece)
}

/**
 * Read-modify-write one piece in a single transaction, so a resume position, last speed and
 * last passage written from different places never overwrite each other. Returns the new
 * record, or undefined when the piece does not exist.
 */
export async function updatePiece(db: Db, id: string, patch: PiecePatch): Promise<PieceRecord | undefined> {
  const tx = db.transaction('pieces', 'readwrite')
  return runTx(tx, async () => {
    const current = await tx.store.get(id)
    if (!current) return undefined
    const next: Record<string, unknown> = { ...current, ...patch }
    for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key]
    assertPiece(next as unknown as PieceRecord)
    await tx.store.put(next as unknown as PieceRecord)
    return next as unknown as PieceRecord
  })
}

export function getPackage(db: Db, scoreVersionId: string): Promise<ScorePackage | undefined> {
  return db.get('packages', scoreVersionId)
}

/**
 * Store a package under its own `scoreVersionId`, replacing the previous one (used after the
 * user confirms hands or supplies a tempo). Histories stay keyed by the version id and by the
 * tempo map id carried in each comparison context.
 */
export async function putPackage(db: Db, pkg: ScorePackage): Promise<void> {
  assertPackage(pkg)
  await db.put('packages', pkg, pkg.model.scoreVersionId)
}

export function getSource(db: Db, scoreVersionId: string): Promise<SourceFileRecord | undefined> {
  return db.get('sources', scoreVersionId)
}

export interface ImportCommit {
  readonly source: SourceFileRecord
  readonly pkg: ScorePackage
  readonly piece: PieceRecord
}

/**
 * Persist an import atomically (spec "Storage and recovery"): the source, the package and the
 * piece are written in one transaction, so a failed import (quota, abort, crash) leaves every
 * existing piece untouched and never a piece without its package. Replacing the source of an
 * existing piece drops the old version's heavy data once nothing else uses it; its practice
 * history stays under the old version id and is never mixed with the new one.
 */
export async function commitImport(db: Db, input: ImportCommit): Promise<void> {
  const { source, pkg, piece } = input
  assertPiece(piece)
  assertPackage(pkg)
  const version = pkg.model.scoreVersionId
  if (source.bytes.byteLength === 0) {
    throw new TypeError('The source file is empty (or its buffer was already transferred to a worker)')
  }
  if (piece.scoreVersionId !== version) {
    throw new TypeError('Piece and package disagree about the score version')
  }

  const tx = db.transaction(['pieces', 'sources', 'packages', 'layoutCache', 'layoutMeta'], 'readwrite')
  await runTx(tx, async () => {
    const previous = await tx.objectStore('pieces').get(piece.id)
    await Promise.all([
      observed(tx.objectStore('sources').put(source, version)),
      observed(tx.objectStore('packages').put(pkg, version)),
      observed(tx.objectStore('pieces').put(piece)),
    ])
    if (previous && previous.scoreVersionId !== version) {
      await releaseVersionIfUnused(tx, previous.scoreVersionId)
    }
  })
}

/** A read-write transaction that includes the stores a score version spans. */
type VersionTx = IDBPTransaction<PianissimoDB, ArrayLike<StoreName>, 'readwrite'>

/** Delete a version's source, package and cached layouts when no piece refers to it any more. */
export async function releaseVersionIfUnused(tx: VersionTx, scoreVersionId: string): Promise<void> {
  const users = await tx.objectStore('pieces').index('scoreVersionId').count(scoreVersionId)
  if (users > 0) return
  await Promise.all([
    tx.objectStore('sources').delete(scoreVersionId),
    tx.objectStore('packages').delete(scoreVersionId),
  ])
  const keys = await tx.objectStore('layoutMeta').index('scoreVersionId').getAllKeys(scoreVersionId)
  await Promise.all(
    keys.flatMap((key) => [tx.objectStore('layoutMeta').delete(key), tx.objectStore('layoutCache').delete(key)]),
  )
}

/**
 * Delete a piece and everything that belongs to it: attempts, measure histories, suggestion
 * state and abandon events, plus its source, package and cached layouts when no other piece
 * uses that score version. Returns false when the piece does not exist.
 */
export async function deletePiece(db: Db, id: string): Promise<boolean> {
  const tx = db.transaction(
    [
      'pieces',
      'sources',
      'packages',
      'attempts',
      'measureHistory',
      'suggestionState',
      'abandonEvents',
      'layoutCache',
      'layoutMeta',
    ],
    'readwrite',
  )
  return runTx(tx, async () => {
    const piece = await tx.objectStore('pieces').get(id)
    if (!piece) return false
    await tx.objectStore('pieces').delete(id)
    const [attemptKeys, barKeys, abandonKeys] = await Promise.all([
      tx.objectStore('attempts').index('pieceId').getAllKeys(id),
      tx.objectStore('measureHistory').index('pieceId').getAllKeys(id),
      tx.objectStore('abandonEvents').index('pieceId').getAllKeys(id),
    ])
    await Promise.all([
      ...attemptKeys.map((k) => tx.objectStore('attempts').delete(k)),
      ...barKeys.map((k) => tx.objectStore('measureHistory').delete(k)),
      ...abandonKeys.map((k) => tx.objectStore('abandonEvents').delete(k)),
      tx.objectStore('suggestionState').delete(id),
    ])
    await releaseVersionIfUnused(tx, piece.scoreVersionId)
    return true
  })
}
