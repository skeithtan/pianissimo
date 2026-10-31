import { emptyPieceHistory } from './types'
import type { PieceHistory } from './types'

/**
 * Suggestions the player dismissed "for the current session". Held in memory only and never
 * persisted: a dismissed suggestion returns after a reload.
 */
export class SessionDismissals {
  private readonly ids = new Set<string>()

  dismiss(id: string): void {
    this.ids.add(id)
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  clear(): void {
    this.ids.clear()
  }
}

/**
 * Per-piece "disable suggestions". Evidence keeps being recorded, so re-enabling shows
 * accurate suggestions.
 */
export function setSuggestionsDisabled(history: PieceHistory, disabled: boolean): PieceHistory {
  return history.disabled === disabled ? history : { ...history, disabled }
}

/**
 * "Clear the piece's practice history": bar histories, suggestions (active and improved) and
 * abandon events are removed. The disable preference is a setting, not history, and is kept.
 */
export function clearPracticeHistory(history: PieceHistory): PieceHistory {
  return { ...emptyPieceHistory(history.pieceId), disabled: history.disabled }
}
