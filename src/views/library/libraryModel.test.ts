import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { LibraryModel } from './libraryModel'
import { testDeps } from './testkit'

describe('LibraryModel.exportBackup', () => {
  it('flushes settings waiting on the save debounce before building the backup', async () => {
    const deps = await testDeps()
    const order: string[] = []
    const exportAll = deps.storage.exportAll.bind(deps.storage)
    const model = new LibraryModel({
      ...deps,
      flushSettings: async () => {
        deps.flushes += 1
        order.push('flush')
      },
      getStorage: async () => ({
        ...deps.storage,
        exportAll: () => {
          order.push('export')
          return exportAll()
        },
      }),
    })
    const name = await model.exportBackup()
    expect(deps.flushes).toBe(1)
    expect(order).toEqual(['flush', 'export'])
    expect(deps.downloads.map((d) => d.fileName)).toEqual([name])
  })
})
