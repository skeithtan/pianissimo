import type { ImportCommit } from './pieces'
import { assertImport } from './pieces'
import type { Db } from './schema'
import { INITIAL_LIBRARY_KEY } from './schema'
import { observed, runTx } from './tx'

/** Only a genuinely new database may receive its initial pieces. */
export async function needsInitialPieces(db: Db): Promise<boolean> {
  return (await db.get('libraryState', INITIAL_LIBRARY_KEY)) === 'pending'
}

/**
 * Claim a new library and install all its initial pieces in one transaction. Concurrent tabs
 * serialize on libraryState; a failed write rolls back both the pieces and the marker. The
 * complete marker outlives deletion of every piece and is never reset by application updates.
 */
export async function initializeLibrary(db: Db, inputs: readonly ImportCommit[]): Promise<boolean> {
  if (inputs.length < 1 || inputs.length > 3) throw new TypeError('An initial library needs one to three pieces')
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
    if ((await state.get(INITIAL_LIBRARY_KEY)) !== 'pending') return false
    const pieces = tx.objectStore('pieces')
    if ((await pieces.count()) > 0) {
      await state.put('complete', INITIAL_LIBRARY_KEY)
      return false
    }
    for (const { source, pkg, piece } of inputs) {
      await Promise.all([
        observed(pieces.add(piece)),
        observed(tx.objectStore('sources').put(source, piece.scoreVersionId)),
        observed(tx.objectStore('packages').put(pkg, piece.scoreVersionId)),
      ])
    }
    await state.put('complete', INITIAL_LIBRARY_KEY)
    return true
  })
}
