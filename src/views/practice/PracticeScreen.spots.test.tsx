// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { resetAppStateForTests } from '../../app/state'
import { PracticeSession } from '../../app/session'
import { FakeMidi, FakeStrip, ManualFrames } from '../../app/session/testkit'
import { ManualClock } from '../../core/playback/testkit'
import { newPieceRecord } from '../../core/storage/records'
import { openFresh } from '../../core/storage/testkit'
import type { AttemptRecord } from '../../core/model/practice'
import type { PianissimoStorage } from '../../core/storage'
import type { PreparedLayout } from '../../render'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { mount, type Mounted } from '../shared/testing'
import type { PracticeEnv, PracticeStripOptions, StripHandle } from './env'
import { PracticeScreen } from './PracticeScreen'

class TestStrip extends FakeStrip implements StripHandle {
  options: PracticeStripOptions = {}
  occAt(): number {
    return 0
  }
  setZoom(): void {}
  returnToCurrent(): void {}
  destroy(): void {}
  holdLabels(): void {}
}

let mounted: Mounted | null = null

beforeEach(() => {
  resetAppStateForTests()
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

async function settle(frames: ManualFrames, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0))
    })
  }
  act(() => frames.flush())
}

async function setup(opts: { readonly deferPrepare?: boolean; readonly failAttempts?: boolean } = {}) {
  const storage: PianissimoStorage = await openFresh()
  const built = await importFixture('two-hands.musicxml')
  const piece = newPieceRecord(built.package, { id: 'piece-seed', now: 1 })
  await storage.commitImport({ source: built.source, pkg: built.package, piece })
  const clock = new ManualClock()
  clock.now = 1000
  const frames = new ManualFrames(clock.clock)
  const midi = new FakeMidi()
  let resolvePrepare: ((layout: PreparedLayout) => void) | null = null
  const listSpy = opts.failAttempts
    ? vi.spyOn(storage, 'listRecentAttempts').mockRejectedValue(new Error('storage failed'))
    : vi.spyOn(storage, 'listRecentAttempts')
  const env: PracticeEnv = {
    storage: async () => storage,
    midi: () => midi,
    clock: clock.clock,
    timers: clock,
    frames,
    timeOrigin: 0,
    prepare: () =>
      opts.deferPrepare
        ? new Promise<PreparedLayout>((res) => {
            resolvePrepare = res
          })
        : Promise.resolve({ key: 'fake' } as unknown as PreparedLayout),
    createStrip: (_host, _layout, options) => {
      const s = new TestStrip()
      s.options = options
      return s
    },
  }
  return {
    env,
    storage,
    piece,
    pkg: built.package,
    frames,
    listSpy,
    finishPrepare: () => resolvePrepare?.({ key: 'fake' } as unknown as PreparedLayout),
  }
}

describe('PracticeScreen spot seeding', () => {
  it('loads the 64 newest attempts and calls session.seedSpots once, only after the first layout is ready', async () => {
    const seedSpy = vi.spyOn(PracticeSession.prototype, 'seedSpots')
    const s = await setup({ deferPrepare: true })
    mounted = mount(<PracticeScreen env={s.env} piece={s.piece} pkg={s.pkg} onTempoSaved={async () => {}} />)
    await settle(s.frames)
    // Layout has not finished preparing yet: must not block first frame or query storage yet.
    expect(s.listSpy).not.toHaveBeenCalled()
    expect(seedSpy).not.toHaveBeenCalled()

    s.finishPrepare()
    await settle(s.frames)
    expect(s.listSpy).toHaveBeenCalledTimes(1)
    expect(s.listSpy).toHaveBeenCalledWith(s.piece.id, 64)
    expect(seedSpy).toHaveBeenCalledTimes(1)
    expect(seedSpy).toHaveBeenCalledWith([])
  })

  it('swallows a rejected listRecentAttempts call without surfacing an error', async () => {
    const seedSpy = vi.spyOn(PracticeSession.prototype, 'seedSpots')
    const s = await setup({ failAttempts: true })
    mounted = mount(<PracticeScreen env={s.env} piece={s.piece} pkg={s.pkg} onTempoSaved={async () => {}} />)
    await settle(s.frames)
    expect(s.listSpy).toHaveBeenCalledTimes(1)
    expect(seedSpy).not.toHaveBeenCalled()
    expect(mounted.container.textContent).not.toContain('storage failed')
  })

  it('does not call seedSpots if the view unmounts before storage resolves', async () => {
    const seedSpy = vi.spyOn(PracticeSession.prototype, 'seedSpots')
    const s = await setup()
    const deferred: { resolve?: (records: AttemptRecord[]) => void } = {}
    s.listSpy.mockImplementation(
      () =>
        new Promise<AttemptRecord[]>((res) => {
          deferred.resolve = res
        }),
    )
    mounted = mount(<PracticeScreen env={s.env} piece={s.piece} pkg={s.pkg} onTempoSaved={async () => {}} />)
    await settle(s.frames)
    expect(s.listSpy).toHaveBeenCalledTimes(1)
    mounted.unmount()
    mounted = null
    deferred.resolve?.([])
    await settle(s.frames)
    expect(seedSpy).not.toHaveBeenCalled()
  })
})
