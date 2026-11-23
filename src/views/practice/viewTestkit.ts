/**
 * The Practice view's test rig (happy-dom): a stored fixture, fake MIDI, a recording score view and
 * manual time. Not imported by production code.
 */
import 'fake-indexeddb/auto'
import { act } from 'preact/test-utils'
import { FakeMidi, FakeStrip, ManualFrames } from '../../app/session/testkit'
import { ManualClock } from '../../core/playback/testkit'
import type { PianissimoStorage } from '../../core/storage'
import { newPieceRecord } from '../../core/storage/records'
import { openFresh } from '../../core/storage/testkit'
import type { PreparedLayout, RespaceSnapshot } from '../../render'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { PHONE_LANDSCAPE_QUERY, PHONE_QUERY } from '../shared/usePhone'
import type { PracticeEnv, PracticeStripOptions, StripHandle } from './env'

export class TestStrip extends FakeStrip implements StripHandle {
  destroyed = false
  options: PracticeStripOptions = {}
  browsing = false
  browsedOcc = 0
  override isBrowsing(): boolean {
    return this.browsing
  }
  occAt(): number {
    return this.browsedOcc
  }
  returned = 0
  setZoom(): void {}
  returnToCurrent(): void {
    this.returned++
    this.browsing = false
  }
  destroy(): void {
    this.destroyed = true
  }
  held: boolean[] = []
  holdLabels(on: boolean): void {
    this.held.push(on)
  }
  readonly snapshot = { from: this } as unknown as RespaceSnapshot
  respaceSnapshot(): RespaceSnapshot | null {
    return this.snapshot
  }
  respacedFrom: (RespaceSnapshot | null)[] = []
  respacing = Promise.resolve()
  whenRespaced(): Promise<void> {
    return this.respacing
  }
  respaceFrom(prev: RespaceSnapshot | null): void {
    this.respacedFrom.push(prev)
  }
}

export interface Rig {
  env: PracticeEnv
  storage: PianissimoStorage
  clock: ManualClock
  frames: ManualFrames
  midi: FakeMidi
  strips: TestStrip[]
  /** The label room of every preparation, in order. */
  rooms: (string | undefined)[]
  pieceId: string
}

export async function rig(): Promise<Rig> {
  const storage = await openFresh()
  const built = await importFixture('two-hands.musicxml')
  const piece = newPieceRecord(built.package, { id: 'piece-1', now: 1 })
  await storage.commitImport({ source: built.source, pkg: built.package, piece })
  const clock = new ManualClock()
  clock.now = 1000
  const frames = new ManualFrames(clock.clock)
  const midi = new FakeMidi()
  const strips: TestStrip[] = []
  const rooms: (string | undefined)[] = []
  const env: PracticeEnv = {
    storage: async () => storage,
    midi: () => midi,
    clock: clock.clock,
    timers: clock,
    frames,
    timeOrigin: 0,
    prepare: async (_s, _i, options) => {
      rooms.push(options.labels.room)
      return { key: 'fake' } as unknown as PreparedLayout
    },
    createStrip: (_host, _layout, options) => {
      const s = new TestStrip()
      s.options = options
      strips.push(s)
      return s
    },
  }
  return { env, storage, clock, frames, midi, strips, rooms, pieceId: piece.id }
}

/** Let promises (storage, preparation) settle, then run a frame. */
export async function settle(r: Rig, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0))
    })
  }
  act(() => r.frames.flush())
}

export function tap(r: Rig, ...notes: number[]): void {
  act(() => {
    for (const n of notes) {
      r.midi.on(n, r.clock.now)
      r.midi.off(n, r.clock.now)
    }
    r.frames.flush()
  })
}

/** A screen the media queries describe (`window.matchMedia`); returns what restores it. */
export function onScreen(kind: 'tablet-portrait' | 'phone' | 'phone-sideways'): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches:
      query === PHONE_QUERY
        ? kind !== 'tablet-portrait'
        : query === PHONE_LANDSCAPE_QUERY
          ? kind === 'phone-sideways'
          : query.includes('portrait') && kind !== 'phone-sideways',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}
