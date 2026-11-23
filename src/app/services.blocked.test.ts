import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PianissimoStorage, StorageOptions } from '../core/storage'
import { openStorage } from '../core/storage'
import { freshName } from '../core/storage/testkit'
import { DATABASE_BLOCKED_NOTICE, getStorage, resetServicesForTests } from './services'
import { notices, resetAppStateForTests } from './state'

const opened: Array<{ close(): void }> = []
beforeEach(() => {
  resetAppStateForTests()
  resetServicesForTests()
})
afterEach(() => {
  resetServicesForTests()
  resetAppStateForTests()
  for (const c of opened.splice(0)) c.close()
})

/** A tab of an older version that keeps the database open and never reacts to the upgrade. */
function oldTab(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 3)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

it('asks the player to close the other tab while the upgrade waits, and clears that once it opens', async () => {
  const name = freshName()
  const old = await oldTab(name)
  resetServicesForTests({
    openStorage: (options: StorageOptions) =>
      openStorage(name, options).then((s: PianissimoStorage) => {
        opened.push(s)
        return s
      }),
  })
  const opening = getStorage()
  await vi.waitFor(() =>
    expect(notices.value.map((n) => [n.kind, n.text])).toEqual([['warning', DATABASE_BLOCKED_NOTICE]]),
  )
  old.close()
  await opening
  expect(notices.value).toEqual([])
})
