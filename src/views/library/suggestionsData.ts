/**
 * Data layer for a piece's Suggested practice section (spec "Suggested practice"). Kept apart
 * from the presentation (`PieceSuggestions.tsx`, the shared `SuggestionList`):
 *
 * - `load()` → `storage.loadSuggestions(pieceId, sessionDismissals)` (up to three + Improved).
 * - `dismiss(id)` hides a suggestion for this session only (memory, never persisted).
 * - `setDisabled(bool)` is the per-piece "disable suggestions" switch (evidence keeps being
 *   recorded). The global switch is `settings.suggestions.enabled`.
 * - `practice(s)` opens Practice with the passage, hands and speed preselected; it never starts.
 * - Refreshes when the history writer reports changed suggestions for this piece (between
 *   attempts; never interrupts playing).
 */
import { signal, type Signal } from '@preact/signals'
import { openPractice, type PracticeRequest } from '../../app/navigation'
import { settings } from '../../app/state'
import type { SessionDismissals } from '../../core/history/controls'
import type { Suggestion, SuggestionSelection } from '../../core/history/selection'
import type { PianissimoStorage } from '../../core/storage/storage'
import { sessionDismissals } from '../shared/suggestions/dismissals'

/** Session-scoped dismissals (memory only), shared with Results. */
export { sessionDismissals }

export type SuggestionsState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready'
      readonly selection: SuggestionSelection
      /** Off for every piece in Settings (rather than for this piece). */
      readonly globallyDisabled: boolean
    }
  | { readonly status: 'error'; readonly message: string }

export interface SuggestionsDeps {
  getStorage(): Promise<PianissimoStorage>
  /** Called before opening Practice (the Library marks the piece as opened). */
  beforePractice?(pieceId: string): Promise<void> | void
  /** Navigation seam (tests). */
  openPractice?(request: PracticeRequest): void
  readonly dismissals?: SessionDismissals
}

/** The preset that "Practice this passage" sends: range, hands and speed (never auto-start). */
export function practiceRequestFor(pieceId: string, s: Suggestion): PracticeRequest {
  return { pieceId, preset: { passage: s.passage, hands: s.hands, multiplier: s.multiplier } }
}

export class PieceSuggestionsModel {
  readonly state: Signal<SuggestionsState> = signal({ status: 'loading' })
  readonly pieceId: string
  #deps: SuggestionsDeps
  #generation = 0
  #unsubscribe: (() => void) | null = null
  #disposed = false

  constructor(deps: SuggestionsDeps, pieceId: string) {
    this.#deps = deps
    this.pieceId = pieceId
  }

  get dismissals(): SessionDismissals {
    return this.#deps.dismissals ?? sessionDismissals
  }

  /** Load now and refresh whenever new practice records change this piece's suggestions. */
  async start(): Promise<void> {
    try {
      const storage = await this.#deps.getStorage()
      if (this.#disposed) return
      this.#unsubscribe = storage.history.subscribe((report) => {
        if (report.suggestionsChanged.includes(this.pieceId)) void this.load()
      })
    } catch {
      // `load` reports the failure.
    }
    await this.load()
  }

  async load(): Promise<void> {
    const generation = ++this.#generation
    try {
      const storage = await this.#deps.getStorage()
      const selection = await storage.loadSuggestions(this.pieceId, this.dismissals)
      if (generation !== this.#generation || this.#disposed) return
      this.state.value = { status: 'ready', selection, globallyDisabled: !settings.peek().suggestions.enabled }
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return
      this.state.value = {
        status: 'error',
        message: `Suggestions could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /** Hide one suggestion until the page is reloaded. */
  dismiss(id: string): void {
    this.dismissals.dismiss(id)
    const s = this.state.peek()
    if (s.status === 'ready') {
      // Show the change at once; the reload may bring in the next suggestion.
      this.state.value = { ...s, selection: { ...s.selection, active: s.selection.active.filter((x) => x.id !== id) } }
    }
    void this.load()
  }

  /** Per-piece switch. Evidence is still recorded while suggestions are off. */
  async setDisabled(disabled: boolean): Promise<void> {
    const storage = await this.#deps.getStorage()
    await storage.setSuggestionsDisabled(this.pieceId, disabled)
    await this.load()
  }

  async practice(s: Suggestion): Promise<void> {
    await this.#deps.beforePractice?.(this.pieceId)
    ;(this.#deps.openPractice ?? openPractice)(practiceRequestFor(this.pieceId, s))
  }

  dispose(): void {
    this.#disposed = true
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }
}
