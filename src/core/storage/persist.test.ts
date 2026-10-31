import { describe, expect, it } from 'vitest'
import { estimateStorage, isStoragePersistent, requestPersistentStorage } from './persist'

describe('persistent storage helpers', () => {
  it('report "unsupported" when the browser has no storage manager', async () => {
    expect(await requestPersistentStorage(undefined)).toBe('unsupported')
    expect(await requestPersistentStorage({})).toBe('unsupported')
    expect(await isStoragePersistent(undefined)).toBeUndefined()
    expect(await isStoragePersistent({})).toBeUndefined()
    expect(await estimateStorage(undefined)).toBeUndefined()
    expect(await estimateStorage({})).toBeUndefined()
  })

  it('request persistence only when it is not already granted', async () => {
    let asked = 0
    const already = { persisted: async () => true, persist: async () => ((asked += 1), true) }
    expect(await requestPersistentStorage(already)).toBe('granted')
    expect(asked).toBe(0)

    const grant = { persisted: async () => false, persist: async () => ((asked += 1), true) }
    expect(await requestPersistentStorage(grant)).toBe('granted')
    expect(asked).toBe(1)

    expect(await requestPersistentStorage({ persist: async () => false })).toBe('denied')
  })

  it('never throw', async () => {
    const broken = {
      persist: () => Promise.reject(new Error('blocked')),
      persisted: () => Promise.reject(new Error('blocked')),
      estimate: () => Promise.reject(new Error('blocked')),
    }
    expect(await requestPersistentStorage(broken)).toBe('denied')
    expect(await isStoragePersistent(broken)).toBeUndefined()
    expect(await estimateStorage(broken)).toBeUndefined()
  })

  it('reads persistence state', async () => {
    expect(await isStoragePersistent({ persisted: async () => true })).toBe(true)
    expect(await isStoragePersistent({ persisted: async () => false })).toBe(false)
  })

  it('estimates usage, quota and the used fraction', async () => {
    expect(await estimateStorage({ estimate: async () => ({ usage: 25, quota: 100 }) })).toEqual({
      usageBytes: 25,
      quotaBytes: 100,
      fraction: 0.25,
    })
    expect(await estimateStorage({ estimate: async () => ({ usage: 500, quota: 100 }) })).toMatchObject({ fraction: 1 })
    expect(await estimateStorage({ estimate: async () => ({ usage: 5 }) })).toEqual({
      usageBytes: 5,
      quotaBytes: undefined,
      fraction: undefined,
    })
    expect(await estimateStorage({ estimate: async () => ({ usage: 5, quota: 0 }) })).toMatchObject({
      fraction: undefined,
    })
  })
})
