/**
 * Builders for storage tests. Not imported by application code.
 */
import { IMPORTER_VERSION, ROLL_POLICY_VERSION, SCORE_PACKAGE_FORMAT } from '../model/score'
import type { ScorePackage, SourceFileRecord } from '../model/score'
import { rat } from '../music/rational'
import { attemptRecord, comparisonContext, traversal } from '../history/testkit'
import type { Outcome } from '../history/testkit'
import { contextKey } from '../model/practice'
import type { AttemptRecord, ComparisonContext } from '../model/practice'
import { newPieceRecord } from './records'
import type { PieceRecord } from './records'
import { openStorage } from './storage'
import type { PianissimoStorage, StorageOptions } from './storage'

let dbCounter = 0

/** A database name no other test uses. */
export function freshName(): string {
  dbCounter += 1
  return `pianissimo-test-${dbCounter}-${Math.random().toString(36).slice(2, 8)}`
}

export function openFresh(options: StorageOptions = {}): Promise<PianissimoStorage> {
  return openStorage(freshName(), options)
}

/** A minimal but valid score package. */
export function makePackage(
  version = 'v1',
  title = 'Etude',
  extra: { confirmed?: boolean; tempo?: boolean } = {},
): ScorePackage {
  return {
    model: {
      format: SCORE_PACKAGE_FORMAT,
      scoreVersionId: version,
      meta: {
        title,
        composer: 'Anon',
        musicXmlVersion: '4.0',
        packaging: 'musicxml',
        sourceFileName: `${title}.musicxml`,
        importerVersion: IMPORTER_VERSION,
        rollPolicyVersion: ROLL_POLICY_VERSION,
        importedAt: 1_700_000_000_000,
      },
      parts: [{ id: 'P1', name: 'Piano', staffCount: 2 }],
      staves: [],
      voices: [],
      hands: { byVoice: {}, ambiguousVoices: [], confirmed: extra.confirmed ?? false },
      sourceMeasures: [],
      sourceNotes: [],
      occurrences: Array.from({ length: 4 }, (_, i) => ({
        index: i,
        sourceMeasure: i,
        number: String(i + 1),
        pass: 1,
        start: rat(i),
        duration: rat(1),
      })),
      notes: [],
      tempo: {
        segments: extra.tempo
          ? [{ start: rat(0), quarterBpm: 100, beatUnit: rat(1, 4), beatBpm: 100, source: 'user' }]
          : [],
      },
      keys: [],
      meters: [],
      clefs: [],
      ottavas: [],
      pedals: [],
      dynamics: [],
      arpeggios: [],
      unsupported: [],
      timingIssues: [],
      diagnostics: [],
      totalDuration: rat(4),
    },
    renderXml: `<score-partwise><!-- ${title} --></score-partwise>`,
  }
}

export function makeSource(
  version = 'v1',
  size = 64,
  packaging: SourceFileRecord['packaging'] = 'musicxml',
): SourceFileRecord {
  const bytes = new Uint8Array(size).map((_, i) => (i * 7 + version.length) & 0xff)
  return { fileName: `${version}.${packaging}`, packaging, bytes: bytes.buffer, sha256: `sha-${version}` }
}

export function makePiece(pkg: ScorePackage, over: Partial<PieceRecord> = {}): PieceRecord {
  return { ...newPieceRecord(pkg, { id: `piece-${pkg.model.scoreVersionId}`, now: 1_000 }), ...over }
}

/** Import a piece with its source and package. */
export async function importPiece(
  storage: PianissimoStorage,
  version = 'v1',
  over: Partial<PieceRecord> = {},
): Promise<{ piece: PieceRecord; pkg: ScorePackage; source: SourceFileRecord }> {
  const pkg = makePackage(version, over.title ?? `Piece ${version}`)
  const source = makeSource(version)
  const piece = makePiece(pkg, over)
  await storage.commitImport({ source, pkg, piece })
  return { piece, pkg, source }
}

let attemptCounter = 0

/** A scored attempt for a piece traversing the given bars. */
export function attemptFor(
  pieceId: string,
  bars: ReadonlyArray<readonly [occ: number, outcome: Outcome]>,
  over: Partial<AttemptRecord> & { context?: ComparisonContext } = {},
): AttemptRecord {
  attemptCounter += 1
  const context = over.context ?? comparisonContext()
  return attemptRecord({
    id: `att-${attemptCounter}`,
    pieceId,
    createdAt: 50_000 + attemptCounter * 100,
    context,
    contextKey: contextKey(context),
    measures: bars.map(([occ, outcome]) => traversal(occ, outcome)),
    ...over,
  })
}
