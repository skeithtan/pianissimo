/**
 * What the Library's rows look like (DECISIONS U157): the opening of each score, and the quiet ground
 * each piece keeps. The list itself loads no score package, so both are kept beside it, in
 * localStorage (this device's). The openings missing are read from their packages one at a time after
 * the list is on screen, once per score version.
 */
import { signal, type Signal } from '@preact/signals'
import type { PieceRecord } from '../../core/storage/records'
import { openingOf, type Opening } from '../../ui/noteDrawing'
import type { LibraryDeps } from './deps'

const CACHE_KEY = 'pianissimo.openings'
const VERSION = 1
/** Before the first missing opening is read, and between two of them: the list comes first. */
const FIRST_MS = 400
const NEXT_MS = 60

type Openings = ReadonlyMap<string, Opening>

/** The quiet grounds of the rows. */
export const TILES = ['moss', 'sand', 'clay', 'fern', 'wheat'] as const
export type Tile = (typeof TILES)[number]

const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isFinite(n))
const entries = (v: unknown): [string, unknown][] => (typeof v === 'object' && v !== null ? Object.entries(v) : [])

function read(): { openings: Openings; tiles: Map<string, number> } {
  const openings = new Map<string, Opening>()
  const tiles = new Map<string, number>()
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as {
      v?: unknown
      openings?: unknown
      tiles?: unknown
    } | null
    if (stored?.v !== VERSION) return { openings, tiles }
    for (const [version, item] of entries(stored.openings)) {
      const { bars, notes } = (item ?? {}) as Partial<Opening>
      if (isNumbers(bars) && isNumbers(notes) && notes.length % 4 === 0) openings.set(version, { bars, notes })
    }
    for (const [id, n] of entries(stored.tiles)) if (Number.isInteger(n)) tiles.set(id, n as number)
  } catch {
    // Private windows, blocked storage or a damaged entry: the rows start again.
  }
  return { openings, tiles }
}

export class LibraryOpenings {
  readonly all: Signal<Openings>
  #tiles: Map<string, number>
  #deps: Pick<LibraryDeps, 'getStorage'>
  #run = 0

  constructor(deps: Pick<LibraryDeps, 'getStorage'>) {
    const { openings, tiles } = read()
    this.all = signal(openings)
    this.#tiles = tiles
    this.#deps = deps
  }

  /** The grounds, given in turn as the list first shows its pieces; each piece keeps its own. */
  tilesOf(pieces: readonly PieceRecord[]): ReadonlyMap<string, Tile> {
    for (const { id } of pieces) if (!this.#tiles.has(id)) this.#tiles.set(id, this.#tiles.size)
    return new Map(pieces.map(({ id }) => [id, TILES[(this.#tiles.get(id) ?? 0) % TILES.length]!]))
  }

  /** Keeps what these pieces need; scores and pieces that left the Library leave with it. */
  #keep(pieces: readonly PieceRecord[]): void {
    const versions = new Set(pieces.map((p) => p.scoreVersionId))
    const ids = new Set(pieces.map((p) => p.id))
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          v: VERSION,
          openings: Object.fromEntries([...this.all.peek()].filter(([v]) => versions.has(v))),
          tiles: Object.fromEntries([...this.#tiles].filter(([id]) => ids.has(id))),
        }),
      )
    } catch {
      // Full or blocked: read again next time.
    }
  }

  /** Reads what is missing for these pieces; a later call (or `stop`) ends the one before. */
  async fill(pieces: readonly PieceRecord[]): Promise<void> {
    const run = ++this.#run
    const versions = new Set(pieces.map((p) => p.scoreVersionId))
    const missing = [...versions].filter((v) => !this.all.peek().has(v))
    if (pieces.length > 0) this.#keep(pieces)
    let wait = FIRST_MS
    for (const version of missing) {
      await new Promise((resolve) => setTimeout(resolve, wait))
      wait = NEXT_MS
      if (run !== this.#run) return
      try {
        const pkg = await (await this.#deps.getStorage()).getPackage(version)
        if (run !== this.#run) return
        const opening = pkg ? openingOf(pkg.model) : { bars: [], notes: [] }
        this.all.value = new Map([...this.all.peek(), [version, opening]])
        this.#keep(pieces)
      } catch {
        return // Storage went away: the rows stay as they are.
      }
    }
  }

  stop(): void {
    this.#run++
  }
}
