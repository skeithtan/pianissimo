/**
 * View navigation. Two main views (Library and Practice; spec "Main user journey") and the
 * Settings overlay, which holds the piano setup (Piano and sound, U143). It sits on top of the
 * mounted view, so opening it never loses the selected score or passage.
 *
 * These signals are the source of truth for what is on screen. `router.ts` mirrors them to the URL
 * hash and back (Back/Forward, reload, deep links); nothing here touches `history` itself.
 *
 * Practice takes a request naming the piece (and an optional preselection from a suggestion). Set it
 * through `openPractice`; the view reads the signal and keeps its own state once opened.
 */
import { batch, computed, signal } from '@preact/signals'
import type { PassageRange, PracticeMode } from '../core/model/practice'
import type { HandSelection } from '../core/model/score'

export type ViewName = 'library' | 'practice'

/**
 * What `navigate` accepts. `'connection'` is kept so older callers keep working: it opens the
 * piano setup (`openConnection`) and leaves the current view in place.
 */
export type NavigationTarget = ViewName | 'connection'

export type SettingsTab = 'reading' | 'piano' | 'app' | 'data'

export interface PracticePreset {
  readonly passage?: PassageRange
  readonly hands?: HandSelection
  readonly multiplier?: number
}

export interface PracticeRequest {
  readonly pieceId: string
  /** Preselects range, hands and speed. Never starts practice automatically (spec). */
  readonly preset?: PracticePreset
  /** Opens in this mode, leaving the piece's own as it is (an old study link, `routes.ts`). */
  readonly mode?: PracticeMode
}

export const currentView = signal<ViewName>('library')
export const settingsOpen = signal(false)
/** The Settings tab on show. Kept while Settings is closed: opening it returns to the last-used tab. */
export const settingsTab = signal<SettingsTab>('reading')
/** Settings was asked for at the Note names rules; it clears this once they are in view. */
export const noteRulesRequested = signal(false)
/** Settings is open on the piano setup: its own name in the URL (`?connection`). */
export const connectionOpen = computed(() => settingsOpen.value && settingsTab.value === 'piano')
export const practiceRequest = signal<PracticeRequest | null>(null)

/** Show a main view. Closes Settings (leaving a page is leaving its overlay). */
export function navigate(target: NavigationTarget): void {
  if (target === 'connection') {
    openConnection()
    return
  }
  batch(() => {
    currentView.value = target
    closeSettings()
  })
}

export function openPractice(request: PracticeRequest): void {
  batch(() => {
    practiceRequest.value = request
    navigate('practice')
  })
}

/** Open Settings over the current view, on the tab used last. */
export function openSettings(): void {
  settingsOpen.value = true
}

export function closeSettings(): void {
  batch(() => {
    settingsOpen.value = false
    noteRulesRequested.value = false
  })
}

/** Open Settings on Piano and sound, at its top: the piano setup. */
export function openConnection(): void {
  batch(() => {
    settingsTab.value = 'piano'
    settingsOpen.value = true
  })
}

/** Open Settings on Reading help with the Note names rules in view and focused. */
export function openNoteRules(): void {
  batch(() => {
    settingsTab.value = 'reading'
    noteRulesRequested.value = true
    settingsOpen.value = true
  })
}
