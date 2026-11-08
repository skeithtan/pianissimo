import { describe, expect, it } from 'vitest'
import { createReloader, SAVE_TIMEOUT_MS, SETTLE_MS } from './pwa'

/** A reloader whose waits are steps the test releases, so nothing depends on real time. */
function rig(options: { saveHangs?: boolean } = {}) {
  const state = { busy: false, saves: 0, reloads: 0 }
  const waits: { ms: number; release: () => void }[] = []
  const reloader = createReloader({
    busy: () => state.busy,
    save: () => {
      state.saves++
      return options.saveHangs ? new Promise(() => undefined) : Promise.resolve()
    },
    reload: () => state.reloads++,
    wait: (ms) => new Promise<void>((resolve) => waits.push({ ms, release: resolve })),
  })
  /** Let promise chains run. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  /** Release the oldest pending wait of `ms`. */
  const pass = async (ms: number) => {
    await flush()
    const index = waits.findIndex((w) => w.ms === ms)
    expect(index, `a pending ${ms} ms wait`).toBeGreaterThanOrEqual(0)
    waits.splice(index, 1)[0]!.release()
    await flush()
  }
  return { state, reloader, waits, pass, flush }
}

describe('createReloader', () => {
  it('does nothing until a newer build has taken over', async () => {
    const { state, reloader, waits, flush } = rig()
    reloader.poke()
    await flush()
    expect(waits).toHaveLength(0)
    expect(state.reloads).toBe(0)
  })

  it('reloads when idle, after the left screen settles and everything is saved', async () => {
    const { state, reloader, pass } = rig()
    reloader.stale()
    expect(state.saves).toBe(0)
    await pass(SETTLE_MS)
    expect(state.saves).toBe(1)
    expect(state.reloads).toBe(1)
  })

  it('never reloads while busy, and reloads on the first poke after', async () => {
    const { state, reloader, pass } = rig()
    state.busy = true
    reloader.stale()
    await pass(SETTLE_MS)
    reloader.poke()
    await pass(SETTLE_MS)
    expect(state.saves).toBe(0)
    expect(state.reloads).toBe(0)
    state.busy = false
    reloader.poke()
    await pass(SETTLE_MS)
    expect(state.reloads).toBe(1)
  })

  it('waits for a sheet that is closing before it checks', async () => {
    const { state, reloader, pass } = rig()
    state.busy = true
    reloader.stale()
    state.busy = false // The sheet left the DOM during the settle wait.
    await pass(SETTLE_MS)
    expect(state.reloads).toBe(1)
  })

  it('stands down when the learner opens a session during the settle wait', async () => {
    const { state, reloader, pass } = rig()
    reloader.stale()
    state.busy = true
    await pass(SETTLE_MS)
    expect(state.saves).toBe(0)
    expect(state.reloads).toBe(0)
    state.busy = false
    reloader.poke()
    await pass(SETTLE_MS)
    expect(state.reloads).toBe(1)
  })

  it('reloads even if saving hangs, after the save timeout', async () => {
    const { state, reloader, pass } = rig({ saveHangs: true })
    reloader.stale()
    await pass(SETTLE_MS)
    expect(state.reloads).toBe(0)
    await pass(SAVE_TIMEOUT_MS)
    expect(state.reloads).toBe(1)
  })

  it('starts one reload however often it is poked', async () => {
    const { state, reloader, waits, pass } = rig()
    reloader.stale()
    reloader.poke()
    reloader.poke()
    expect(waits).toHaveLength(1)
    await pass(SETTLE_MS)
    reloader.poke()
    expect(state.reloads).toBe(1)
  })
})
