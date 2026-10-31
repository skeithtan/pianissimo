/**
 * View navigation. Three main views (Library, Practice, Results; spec "Main user journey") and
 * two overlays, Settings and the Connection setup modal. Overlays sit on top of the mounted view
 * so opening one never loses the selected score or passage; at most one is open at a time.
 *
 * These signals are the source of truth for what is on screen. `router.ts` mirrors them to the URL
 * hash and back (Back/Forward, reload, deep links); nothing here touches `history` itself.
 *
 * Practice and Results take a request naming the piece (and, for Practice, an optional
 * preselection from a suggestion or Results). Set them through `openPractice` / `openResults`;
 * the views read the signals and keep their own state once opened.
 */
import { batch, signal } from '@preact/signals'
import type { PassageRange } from '../core/model/practice'
import type { HandSelection } from '../core/model/score'

export type ViewName = 'library' | 'practice' | 'results'

/**
 * What `navigate` accepts. `'connection'` is kept so older callers keep working: it opens the
 * Connection setup modal (`openConnection`) and leaves the current view in place.
 */
export type NavigationTarget = ViewName | 'connection'

export interface PracticePreset {
  readonly passage?: PassageRange
  readonly hands?: HandSelection
  readonly multiplier?: number
}

export interface PracticeRequest {
  readonly pieceId: string
  /** Preselects range, hands and speed. Never starts practice automatically (spec). */
  readonly preset?: PracticePreset
  /** Start once the newly imported score is ready; consumed by the Practice view. */
  readonly autoStart?: boolean
}

export interface ResultsRequest {
  readonly pieceId: string
  /** The attempt to show as the latest scorecard; omitted → the most recent stored attempt. */
  readonly attemptId?: string
}

export const currentView = signal<ViewName>('library')
export const settingsOpen = signal(false)
export const connectionOpen = signal(false)
export const practiceRequest = signal<PracticeRequest | null>(null)
export const resultsRequest = signal<ResultsRequest | null>(null)

/** Show a main view. Closes any overlay (leaving a page is leaving its overlays). */
export function navigate(target: NavigationTarget): void {
  if (target === 'connection') {
    openConnection()
    return
  }
  batch(() => {
    currentView.value = target
    settingsOpen.value = false
    connectionOpen.value = false
  })
}

export function openPractice(request: PracticeRequest): void {
  batch(() => {
    practiceRequest.value = request
    navigate('practice')
  })
}

export function openResults(request: ResultsRequest): void {
  batch(() => {
    resultsRequest.value = request
    navigate('results')
  })
}

/** Open Settings over the current view (replacing the Connection modal if that is open). */
export function openSettings(): void {
  batch(() => {
    connectionOpen.value = false
    settingsOpen.value = true
  })
}

export function closeSettings(): void {
  settingsOpen.value = false
}

/** Open the Connection setup modal over the current view (replacing Settings if open). */
export function openConnection(): void {
  batch(() => {
    settingsOpen.value = false
    connectionOpen.value = true
  })
}

export function closeConnection(): void {
  connectionOpen.value = false
}
