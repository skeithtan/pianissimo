/**
 * The URL scheme (pure functions; no signals, no DOM). The app is a static site under
 * `/pianissimo/`, so routes live in the hash and need no server rewrites:
 *
 * | Hash                                  | Meaning                                              |
 * | ------------------------------------- | ---------------------------------------------------- |
 * | `#/` (or empty)                       | Library                                              |
 * | `#/practice/<pieceId>`                | Practice that piece (`#/practice` = its empty state) |
 * | `#/results/<pieceId>`                 | Results for the piece's latest attempt               |
 * | `#/results/<pieceId>/<attemptId>`     | Results showing that attempt                         |
 * | `#/consult/<pieceId>`                 | Consult that piece (`#/consult` = its empty state)   |
 * | any of the above + `?settings`        | Settings overlay open over that view                 |
 * | any of the above + `?connection`      | Connection setup modal open over that view           |
 * | `#/settings`, `#/connection`          | Aliases: the overlay over the Library                |
 *
 * Anything unrecognized is the Library. Overlays are part of the route so Back closes them and a
 * reload reopens them. A Practice preset (passage, hands, speed) is not in the URL: it rides in
 * `history.state` (see `HistoryState`).
 */
import type { PassageRange } from '../core/model/practice'
import type { Rational } from '../core/music/rational'
import type { HandSelection } from '../core/model/score'
import type { PracticePreset, ViewName } from './navigation'

export type OverlayName = 'settings' | 'connection'

export interface Route {
  readonly view: ViewName
  /** Practice, Results and Consult only. */
  readonly pieceId?: string
  /** Results only. */
  readonly attemptId?: string
  readonly overlay: OverlayName | null
}

/** What the app keeps in `history.state` (structured-cloneable, validated on read). */
export interface HistoryState {
  /** Preselection for a Practice entry (from a suggestion or Results). */
  readonly preset?: PracticePreset
  /**
   * This entry is an overlay opened on top of an entry holding the same route without the
   * overlay, so closing it is "go back". False/absent (a deep link, a reload into an overlay,
   * or an overlay that replaced another): closing rewrites the entry instead.
   */
  readonly overlayFrom?: boolean
}

export const LIBRARY_ROUTE: Route = { view: 'library', overlay: null }

const OVERLAYS: readonly OverlayName[] = ['settings', 'connection']

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Parse a `location.hash` value (with or without the leading `#`). Never throws. */
export function parseHash(hash: string): Route {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  const queryAt = text.indexOf('?')
  const path = queryAt < 0 ? text : text.slice(0, queryAt)
  const query = queryAt < 0 ? '' : text.slice(queryAt + 1)
  const segments = path
    .split('/')
    .filter((s) => s !== '')
    .map(decode)

  let overlay: OverlayName | null = null
  for (const token of query.split('&')) {
    const found = OVERLAYS.find((o) => o === token)
    if (found) overlay = found
  }

  const [head, id, attempt] = segments
  switch (head) {
    case 'practice':
      return id ? { view: 'practice', pieceId: id, overlay } : { view: 'practice', overlay }
    case 'results':
      if (!id) return { view: 'results', overlay }
      return attempt
        ? { view: 'results', pieceId: id, attemptId: attempt, overlay }
        : { view: 'results', pieceId: id, overlay }
    case 'consult':
      return id ? { view: 'consult', pieceId: id, overlay } : { view: 'consult', overlay }
    case 'settings':
    case 'connection':
      return { view: 'library', overlay: head }
    default:
      return { view: 'library', overlay }
  }
}

/** The canonical hash for a route (always starts with `#/`). */
export function formatHash(route: Route): string {
  let path = '/'
  if (route.view === 'practice') {
    path = route.pieceId ? `/practice/${encodeURIComponent(route.pieceId)}` : '/practice'
  } else if (route.view === 'results') {
    path = route.pieceId ? `/results/${encodeURIComponent(route.pieceId)}` : '/results'
    if (route.pieceId && route.attemptId) path += `/${encodeURIComponent(route.attemptId)}`
  } else if (route.view === 'consult') {
    path = route.pieceId ? `/consult/${encodeURIComponent(route.pieceId)}` : '/consult'
  }
  return `#${path}${route.overlay ? `?${route.overlay}` : ''}`
}

/** The part of a route that names a page: two routes with the same base differ only by overlay. */
export function sameBase(a: Route, b: Route): boolean {
  if (a.view !== b.view) return false
  if (a.view === 'library') return true
  return a.pieceId === b.pieceId && (a.view !== 'results' || a.attemptId === b.attemptId)
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.overlay === b.overlay && sameBase(a, b)
}

const HANDS: readonly HandSelection[] = ['both', 'right', 'left', 'none']

function readRational(value: unknown): Rational | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { n, d } = value as Record<string, unknown>
  return Number.isInteger(n) && Number.isInteger(d) && (d as number) > 0
    ? { n: n as number, d: d as number }
    : undefined
}

/** Bars plus valid note-level edges ("Practice again" of a note-level loop, U21). */
function readPassage(value: unknown): PassageRange | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const { fromOcc, toOcc } = raw
  if (typeof fromOcc !== 'number' || typeof toOcc !== 'number') return undefined
  const start = readRational(raw['start'])
  const end = readRational(raw['end'])
  return { fromOcc, toOcc, ...(start ? { start } : {}), ...(end ? { end } : {}) }
}

function readPreset(value: unknown): PracticePreset | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const passage = readPassage(raw['passage'])
  const hands = HANDS.find((h) => h === raw['hands'])
  const multiplier =
    typeof raw['multiplier'] === 'number' && Number.isFinite(raw['multiplier']) ? raw['multiplier'] : undefined
  if (!passage && !hands && multiplier === undefined) return undefined
  return {
    ...(passage ? { passage } : {}),
    ...(hands ? { hands } : {}),
    ...(multiplier !== undefined ? { multiplier } : {}),
  }
}

/** Validate whatever `history.state` holds (it can be null, foreign or stale). */
export function readHistoryState(value: unknown): HistoryState {
  if (typeof value !== 'object' || value === null) return {}
  const raw = value as Record<string, unknown>
  const preset = readPreset(raw['preset'])
  return {
    ...(preset ? { preset } : {}),
    ...(raw['overlayFrom'] === true ? { overlayFrom: true } : {}),
  }
}

export function samePreset(a: PracticePreset | undefined, b: PracticePreset | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
