import type { ImportCommit } from './pieces'
import { assertImport } from './pieces'
import type { Db } from './schema'
import { INITIAL_LIBRARY_KEY, LIBRARY_EXPANSION_KEY } from './schema'
import { observed, runTx } from './tx'

/** Only a genuinely new database may receive its initial pieces. */
export async function needsInitialPieces(db: Db): Promise<boolean> {
  return (await db.get('libraryState', INITIAL_LIBRARY_KEY)) === 'pending'
}

export async function needsLibraryExpansion(db: Db): Promise<boolean> {
  return (await db.get('libraryState', LIBRARY_EXPANSION_KEY)) !== 'complete'
}

/**
 * Claim the release once and install its pieces in the same transaction. A first library
 * receives the whole catalog and consumes both markers. Existing libraries receive only the
 * new additions. A failed write rolls back the pieces and marker together.
 */
export async function initializeLibrary(
  db: Db,
  inputs: readonly ImportCommit[],
  mode: 'initial' | 'expansion' = 'initial',
): Promise<boolean> {
  if (!inputs.length) throw new TypeError('An initial library needs at least one piece')
  const ids = new Set<string>()
  const versions = new Set<string>()
  for (const input of inputs) {
    assertImport(input)
    if (ids.has(input.piece.id) || versions.has(input.piece.scoreVersionId)) {
      throw new TypeError('Initial library pieces must have distinct IDs and scores')
    }
    ids.add(input.piece.id)
    versions.add(input.piece.scoreVersionId)
  }
  const tx = db.transaction(['libraryState', 'pieces', 'sources', 'packages'], 'readwrite')
  return runTx(tx, async () => {
    const state = tx.objectStore('libraryState')
    if ((await state.get(LIBRARY_EXPANSION_KEY)) === 'complete') return false
    const isNew = (await state.get(INITIAL_LIBRARY_KEY)) === 'pending'
    if (isNew !== (mode === 'initial')) return false
    const pieces = tx.objectStore('pieces')
    if (isNew && (await pieces.count()) > 0) {
      await state.put('complete', INITIAL_LIBRARY_KEY)
      return false
    }
    // Keep the player's current list order and saved continuation ahead of the new entries.
    const oldest = isNew ? undefined : (await pieces.index('lastOpenedAt').openKeyCursor())?.key
    const byVersion = pieces.index('scoreVersionId')
    for (const [index, { source, pkg, piece }] of inputs.entries()) {
      if (!isNew && (await byVersion.count(piece.scoreVersionId)) > 0) continue
      const lastOpenedAt = oldest === undefined ? piece.lastOpenedAt : Math.min(piece.lastOpenedAt, oldest - index - 1)
      await Promise.all([
        observed(pieces.add({ ...piece, lastOpenedAt })),
        observed(tx.objectStore('sources').put(source, piece.scoreVersionId)),
        observed(tx.objectStore('packages').put(pkg, piece.scoreVersionId)),
      ])
    }
    await state.put('complete', INITIAL_LIBRARY_KEY)
    await state.put('complete', LIBRARY_EXPANSION_KEY)
    return true
  })
}
