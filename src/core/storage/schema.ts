import type { RecordingInfo } from '../recording/records'
import { openDB, unwrap } from 'idb'
import type { DBSchema, IDBPDatabase, StoreNames } from 'idb'
import type { BarRecord } from '../history/types'
import type { AppSettings } from '../model/settings'
import type { AttemptRecord } from '../model/practice'
import type { ScorePackage, SourceFileRecord } from '../model/score'
import type { AbandonRecord, LayoutMeta, LayoutPayload, PieceRecord, SuggestionStateRecord } from './records'
import { convertLegacyTakes } from './recordings'
import type { PendingRecording, RecordingFilesRecord } from './recordings'

export const DEFAULT_DB_NAME = 'pianissimo'
/** IndexedDB schema version. Bump together with a branch in `upgrade`. */
export const DB_VERSION = 4
/** Single settings record key. */
export const SETTINGS_KEY = 'app'
/** Installation-local state: deletion and backup contents never reset it. */
export const INITIAL_LIBRARY_KEY = 'initial-library'
export const LIBRARY_EXPANSION_KEY = 'library-expansion-2026'

/** Compound key `[pieceId, barKey]` of the per-bar stores (`barKey` from `core/history`). */
export type BarStoreKey = [pieceId: string, barKey: string]
/** Compound key of one stored block of a take's WAV file. */
export type RecordingBlockKey = [recordingId: string, index: number]

export interface PianissimoDB extends DBSchema {
  recordings: { key: string; value: RecordingInfo }
  /** A take's MIDI file and what to expect in `recordingBlocks` (or, unconverted, the schema 3 shape). */
  recordingFiles: { key: string; value: RecordingFilesRecord }
  recordingBlocks: { key: RecordingBlockKey; value: ArrayBuffer }
  /** Takes whose blocks are being written; leftovers of abandoned writes are removed on open. */
  pendingRecordings: { key: string; value: PendingRecording }
  libraryState: { key: string; value: 'pending' | 'complete' }
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
  'recordings',
  'recordingFiles',
  'recordingBlocks',
] as const satisfies readonly StoreName[]

export interface OpenOptions {
  /**
   * Another tab holds the database open at an older version and has not closed it, so this
   * upgrade waits. The open settles once that tab closes its connection.
   */
  readonly onBlocked?: () => void
}

/**
 * Open (and on first use create) the database. Schema: see README. Version upgrades add
 * branches on `oldVersion`; they never drop user data stores.
 *
 * The version 4 upgrade moves schema 3 takes to blocks in the same transaction. Should that
 * transaction fail as a whole (a browser can refuse the temporary extra space when it commits),
 * the database is opened again without converting: those takes keep their schema 3 records,
 * which every reader accepts.
 */
export async function openPianissimoDb(name: string = DEFAULT_DB_NAME, options: OpenOptions = {}): Promise<Db> {
  let converting = false
  try {
    return await openAt(name, options, true, () => {
      converting = true
    })
  } catch (error) {
    if (!converting) throw error
    return openAt(name, options, false, () => {})
  }
}

function openAt(name: string, options: OpenOptions, convert: boolean, onConvert: () => void): Promise<Db> {
  const opened: Promise<Db> = openDB<PianissimoDB>(name, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
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
      if (oldVersion < 3) {
        db.createObjectStore('recordings', { keyPath: 'id' })
        db.createObjectStore('recordingFiles')
      }
      if (oldVersion < 2) {
        const state = db.createObjectStore('libraryState')
        // An old empty library may be empty because its owner deleted everything.
        // Only a database created by this version is eligible for initial pieces.
        void state.put(oldVersion === 0 ? 'pending' : 'complete', INITIAL_LIBRARY_KEY)
      }
      if (oldVersion < 4) {
        db.createObjectStore('recordingBlocks')
        db.createObjectStore('pendingRecordings')
        // Only a schema 3 database can hold takes.
        if (oldVersion === 3 && convert) {
          onConvert()
          // A failed upgrade surfaces as the rejected open, which falls back to not converting.
          transaction.done.catch(() => undefined)
          void convertLegacyTakes(unwrap(transaction)).catch(() => undefined)
        }
      }
    },
    blocked() {
      options.onBlocked?.()
    },
    blocking() {
      // A newer app version in another tab wants to upgrade: release this connection.
      void opened.then((db) => db.close())
    },
  })
  return opened
}
