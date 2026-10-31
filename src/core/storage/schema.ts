import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase, StoreNames } from 'idb'
import type { BarRecord } from '../history/types'
import type { AppSettings } from '../model/settings'
import type { AttemptRecord } from '../model/practice'
import type { ScorePackage, SourceFileRecord } from '../model/score'
import type { AbandonRecord, LayoutMeta, LayoutPayload, PieceRecord, SuggestionStateRecord } from './records'

export const DEFAULT_DB_NAME = 'pianissimo'
/** IndexedDB schema version. Bump together with a branch in `upgrade`. */
export const DB_VERSION = 1
/** Single settings record key. */
export const SETTINGS_KEY = 'app'

/** Compound key `[pieceId, barKey]` of the per-bar stores (`barKey` from `core/history`). */
export type BarStoreKey = [pieceId: string, barKey: string]

export interface PianissimoDB extends DBSchema {
  pieces: { key: string; value: PieceRecord; indexes: { lastOpenedAt: number; scoreVersionId: string } }
  /** Original source files, keyed by score version id. */
  sources: { key: string; value: SourceFileRecord }
  /** Normalized score packages, keyed by score version id. */
  packages: { key: string; value: ScorePackage }
  settings: { key: string; value: AppSettings }
  attempts: { key: string; value: AttemptRecord; indexes: { pieceId: string; contextKey: string } }
  measureHistory: { key: BarStoreKey; value: BarRecord; indexes: { pieceId: string } }
  suggestionState: { key: string; value: SuggestionStateRecord }
  abandonEvents: { key: BarStoreKey; value: AbandonRecord; indexes: { pieceId: string } }
  layoutCache: { key: string; value: LayoutPayload }
  layoutMeta: { key: string; value: LayoutMeta; indexes: { scoreVersionId: string; lastUsedAt: number } }
}

export type StoreName = StoreNames<PianissimoDB>
export type Db = IDBPDatabase<PianissimoDB>

/** Stores that hold user data and travel in an export (the layout cache is derived and excluded). */
export const EXPORTED_STORES = [
  'pieces',
  'sources',
  'packages',
  'settings',
  'attempts',
  'measureHistory',
  'suggestionState',
  'abandonEvents',
] as const satisfies readonly StoreName[]

/**
 * Open (and on first use create) the database. Schema: see README. Version upgrades add
 * branches on `oldVersion`; they never drop user data stores.
 */
export function openPianissimoDb(name: string = DEFAULT_DB_NAME): Promise<Db> {
  const opened: Promise<Db> = openDB<PianissimoDB>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const pieces = db.createObjectStore('pieces', { keyPath: 'id' })
        pieces.createIndex('lastOpenedAt', 'lastOpenedAt')
        pieces.createIndex('scoreVersionId', 'scoreVersionId')
        db.createObjectStore('sources')
        db.createObjectStore('packages')
        db.createObjectStore('settings')
        const attempts = db.createObjectStore('attempts', { keyPath: 'id' })
        attempts.createIndex('pieceId', 'pieceId')
        attempts.createIndex('contextKey', 'contextKey')
        db.createObjectStore('measureHistory').createIndex('pieceId', 'pieceId')
        db.createObjectStore('suggestionState', { keyPath: 'pieceId' })
        db.createObjectStore('abandonEvents').createIndex('pieceId', 'pieceId')
        db.createObjectStore('layoutCache', { keyPath: 'key' })
        const meta = db.createObjectStore('layoutMeta', { keyPath: 'key' })
        meta.createIndex('scoreVersionId', 'scoreVersionId')
        meta.createIndex('lastUsedAt', 'lastUsedAt')
      }
    },
    blocking() {
      // A newer app version in another tab wants to upgrade: release this connection.
      void opened.then((db) => db.close())
    },
  })
  return opened
}
