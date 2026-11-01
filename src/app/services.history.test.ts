import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PianissimoStorage, StorageOptions } from '../core/storage'
import { openFresh } from '../core/storage/testkit'
import {
  HISTORY_QUOTA_NOTICE,
  HISTORY_SAVE_FAILED_NOTICE,
  getStorage,
  historyFailureNotices,
  resetServicesForTests,
} from './services'
import { notices, resetAppStateForTests, type NoticeInput } from './state'

const opened: PianissimoStorage[] = []
const quota = (): Error => Object.assign(new Error('full'), { name: 'QuotaExceededError' })
const report = { attempts: 1, abandons: 0, suggestionsChanged: [], pieces: [] }

beforeEach(() => {
  resetAppStateForTests()
  resetServicesForTests()
})
afterEach(() => {
  resetServicesForTests()
  resetAppStateForTests()
  for (const s of opened.splice(0)) s.close()
})

describe('historyFailureNotices', () => {
  it('warns once per failure streak when records are dropped, and stays silent on retries', () => {
    const pushed: NoticeInput[] = []
    const hooks = historyFailureNotices((n) => pushed.push(n))
    hooks.onError(quota(), 0) // retry scheduled: nothing lost yet
    expect(pushed).toEqual([])
    hooks.onError(quota(), 3) // batch dropped
    hooks.onError(quota(), 2) // same streak
    expect(pushed).toEqual([{ kind: 'warning', text: HISTORY_QUOTA_NOTICE, timeoutMs: null }])
    hooks.onFlush(report) // a successful write ends the streak
    hooks.onError(new Error('boom'), 1)
    expect(pushed.map((n) => n.text)).toEqual([HISTORY_QUOTA_NOTICE, HISTORY_SAVE_FAILED_NOTICE])
  })
})

describe('getStorage history wiring', () => {
  it('opens storage with history hooks that push the warning notice', async () => {
    let options: StorageOptions | undefined
    resetServicesForTests({
      openStorage: (o) => {
        options = o
        return openFresh(o).then((s) => {
          opened.push(s)
          return s
        })
      },
    })
    await getStorage()
    expect(options?.appVersion).toBeTypeOf('string')
    options?.history?.onError?.(quota(), 4)
    expect(notices.peek().map((n) => [n.kind, n.text])).toEqual([['warning', HISTORY_QUOTA_NOTICE]])
  })
})
