/** Search in the Library (DECISIONS L13). Pure: title and composer of the piece records only. */
import type { PieceRecord } from '../../core/storage/records'

/** Case and diacritics do not count: "fur elise" finds "Für Elise". */
function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

/** The typed words; none while nothing is searched. */
export function searchWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean)
}

/** Every word is somewhere in the title or the composer. */
export function matchesSearch(piece: Pick<PieceRecord, 'title' | 'composer'>, words: readonly string[]): boolean {
  const text = fold(`${piece.title}\n${piece.composer ?? ''}`)
  return words.every((word) => text.includes(word))
}
