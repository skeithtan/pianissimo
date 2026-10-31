/**
 * Browser-audio entry point. Import only through `loadBrowserAudio()` (dynamic import) so the
 * sample bank and this code stay out of the MIDI path (spec "MIDI-only resource use").
 */
import { sharedAudioContext } from '../webaudio/context'
import type { Clock } from '../types'
import { BrowserAudioBackend } from './backend'
import type { BankStats, FetchLike } from './samples'

export { BrowserAudioBackend } from './backend'
export type { BrowserAudioOptions } from './backend'
export { DECODED_BUDGET_BYTES, SampleBank, monoTruncate, parseManifest } from './samples'
export type { BankStats, BankStatus, FetchLike, SampleManifest } from './samples'

/** Where the deployed Salamander bank lives (works under the GitHub Pages project path). */
export const SALAMANDER_BASE_URL = `${import.meta.env.BASE_URL}samples/salamander/`

export interface CreateBrowserAudioOptions {
  readonly clock?: Clock
  readonly volume?: number
  readonly onProgress?: (stats: BankStats) => void
}

/**
 * Create the browser-audio backend on the shared AudioContext and start loading samples.
 * Call from a user gesture (the context may be created here).
 */
export function createBrowserAudio(options: CreateBrowserAudioOptions = {}): BrowserAudioBackend {
  const fetchFn: FetchLike = (url) => globalThis.fetch(url)
  const backend = new BrowserAudioBackend({
    context: sharedAudioContext(),
    clock: options.clock ?? (() => performance.now()),
    baseUrl: SALAMANDER_BASE_URL,
    fetch: fetchFn,
    ...(options.volume !== undefined ? { volume: options.volume } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  })
  void backend.load()
  return backend
}
