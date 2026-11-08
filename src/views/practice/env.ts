/**
 * What the Practice view needs from the outside world, injectable for happy-dom tests:
 * storage, MIDI, clock/timers/frames, layout preparation and the strip. Production values come
 * from `app/services` and `render/` (OSMD itself is a dynamic import inside `prepare`).
 */
import { getFeatures } from '../../app/features'
import { getMidiService, getStorage } from '../../app/services'
import type { FrameApi, MidiSource, StripSink } from '../../app/session'
import { browserTimers, loadBrowserAudio, loadWebAudioMetronome, type TimerApi } from '../../core/playback'
import type { BrowserAudioModule, MetronomeModule } from '../../core/playback'
import type { PianissimoStorage } from '../../core/storage'
import {
  OsmdRenderer,
  type PageOptions,
  PageView,
  StripView,
  prepareLayout,
  storeLayoutCache,
  tieredLayoutCache,
  type LayoutCache,
  type PreparedLayout,
  type PrepareOptions,
  type RenderInput,
  type RespaceSnapshot,
  type StripOptions,
} from '../../render'

/**
 * Strip options, incl. the cursor action (round repeat button on the cursor line, U14) and the
 * page's width fit (`fitWidth`, a phone, R17; the strip ignores it).
 */
export type PracticeStripOptions = StripOptions & Pick<PageOptions, 'fitWidth'>

/** The strip as the view drives it (session part + view-only controls). */
export interface StripHandle extends StripSink {
  /** Shows or hides the cursor's repeat button (U14). */
  setCursorAction(visible: boolean): void
  /** Bar (occurrence) under a viewport x, clamped to the piece (-1 for an empty layout). */
  occAt(clientX: number): number
  setZoom(scale: number): void
  returnToCurrent(): void
  destroy(): void
  /**
   * Viewport x of the cursor line, for a view whose cursor moves (the portrait page). Absent: the
   * strip's fixed cursor at one third of the stage.
   */
  cursorClientX?(): number
  /**
   * Respacing (Labels Off ↔ on, R3 revised): the old view's snapshot for `next`, taken just before
   * it is destroyed (null: nothing to glide from), and the new view's glide from it.
   */
  respaceSnapshot?(next: PreparedLayout): RespaceSnapshot | null
  respaceFrom?(prev: RespaceSnapshot | null): void
  /** Resolves when an active spacing glide ends, so a rapid reversal starts from visible notation. */
  whenRespaced?(): Promise<void>
  /** Hides labels (fading) on a view about to be respaced to show them. */
  holdLabels?(on: boolean): void
}

/** Which score view the Practice screen shows: the landscape strip or the portrait page. */
export type ScoreViewMode = 'strip' | 'page'

export interface PracticeEnv {
  readonly storage: () => Promise<PianissimoStorage>
  readonly midi: () => MidiSource
  readonly clock: () => number
  readonly timers: TimerApi
  readonly frames: FrameApi
  readonly timeOrigin: number
  /**
   * `recent`: the Practice screen's in-memory layouts, checked before IndexedDB (Labels Off ↔ on
   * swaps between two engravings; the one just left comes back at once). One per screen, so a
   * package changed in the Library meanwhile never meets a layout kept from before.
   */
  readonly prepare: (
    storage: PianissimoStorage | null,
    input: RenderInput,
    options: PrepareOptions,
    recent?: LayoutCache,
  ) => Promise<PreparedLayout>
  /**
   * Mounts the score view: the strip, or in portrait the page (`mode: 'page'`, a layout prepared
   * with `PrepareOptions.mode: 'page'`). Both implement the same handle.
   */
  readonly createStrip: (
    host: HTMLElement,
    layout: PreparedLayout,
    options: PracticeStripOptions,
    mode?: ScoreViewMode,
  ) => StripHandle
  readonly loadBrowserAudio?: () => Promise<BrowserAudioModule>
  /** Can this device play sound (Web Audio)? Listen falls back to it without a piano (S3). */
  readonly hasWebAudio?: () => boolean
  readonly loadMetronome?: () => Promise<MetronomeModule>
}

let renderer: OsmdRenderer | null = null

export function defaultPracticeEnv(): PracticeEnv {
  return {
    storage: getStorage,
    midi: () => {
      const service = getMidiService()
      return {
        subscribe: (fn) => service.adapter.subscribe(fn),
        onRoute: (fn) => service.onRoute(fn),
        registerSoundOwner: (owner) => service.registerSoundOwner(owner),
        output: () => service.adapter.output,
      }
    },
    clock: () => performance.now(),
    timers: browserTimers,
    frames: {
      request: (cb) => requestAnimationFrame(cb),
      cancel: (h) => cancelAnimationFrame(h as number),
    },
    timeOrigin: performance.timeOrigin,
    prepare: async (storage, input, options, recent) => {
      renderer ??= new OsmdRenderer()
      const stored = storage
        ? storeLayoutCache({
            getLayout: (key) => storage.getLayout(key),
            putLayout: async (key, version, value, bytes) => {
              await storage.putLayout(key, version, value as never, bytes)
            },
          })
        : null
      const cache = recent && stored ? tieredLayoutCache(recent, stored) : (recent ?? stored)
      return (await prepareLayout(renderer, cache, input, options)).layout
    },
    createStrip: (host, layout, options, mode) =>
      mode === 'page' ? new PageView(host, layout, options) : new StripView(host, layout, options),
    loadBrowserAudio,
    hasWebAudio: () => getFeatures().features.webAudio.supported,
    loadMetronome: loadWebAudioMetronome,
  }
}
