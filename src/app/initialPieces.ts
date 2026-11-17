/**
 * The first library contains three ordinary pieces. Their sources are bundled with the app;
 * normalization uses the same worker as a user import. No notation engine or audio loads here.
 * The database owns eligibility and the atomic commit, including races with other tabs.
 */
import { createImportClient, type ImportClient } from '../core/import/client'
import type { ImportCommit, PianissimoStorage } from '../core/storage'
import { newPieceRecord } from '../core/storage/records'

export const INITIAL_PIECES = [
  { file: 'ode-to-joy.mxl', title: 'Ode to Joy', composer: 'Ludwig van Beethoven' },
  { file: 'fur-elise.mxl', title: 'Für Elise', composer: 'Ludwig van Beethoven' },
  {
    file: 'la-candeur.mxl',
    title: 'La Candeur, Op. 100 No. 1',
    composer: 'Friedrich Burgmüller',
  },
] as const

export interface InitialPiecesDeps {
  readonly createClient?: () => ImportClient
  readonly loadFile?: (path: string) => Promise<ArrayBuffer>
  readonly now?: () => number
}

async function loadBundledFile(path: string): Promise<ArrayBuffer> {
  const response = await fetch(`${import.meta.env.BASE_URL}scores/${path}`)
  if (!response.ok) throw new Error(`Could not open ${path}`)
  return response.arrayBuffer()
}

/**
 * A failure leaves the library unmodified and eligible for a later retry. Callers may report
 * it without making the working database unavailable or preventing an ordinary import.
 */
export async function ensureInitialPieces(storage: PianissimoStorage, deps: InitialPiecesDeps = {}): Promise<void> {
  if (!(await storage.needsInitialPieces())) return
  const loadFile = deps.loadFile ?? loadBundledFile
  const files = await Promise.all(
    INITIAL_PIECES.map(async (entry) => ({ ...entry, bytes: await loadFile(entry.file) })),
  )
  const client = (deps.createClient ?? createImportClient)()
  const now = (deps.now ?? Date.now)()
  const inputs: ImportCommit[] = []
  try {
    for (const [index, file] of files.entries()) {
      const inspected = await client.inspect({ name: file.file, bytes: file.bytes })
      const [candidate] = inspected.candidates
      if (!candidate || inspected.candidates.length !== 1 || candidate.parts.length !== 1) {
        throw new Error(`The bundled score ${file.file} needs a part selection`)
      }
      const result = await client.build({ candidate: candidate.id, partIds: candidate.parts.map((part) => part.id) })
      if (
        !result.summary.readiness.scoredPractice ||
        result.summary.unsupported.length > 0 ||
        result.summary.timingIssues.length > 0
      ) {
        throw new Error(`The bundled score ${file.file} is not ready for practice`)
      }
      // Retain the exact licensed source bytes; the library uses normal English metadata.
      const pkg = {
        ...result.package,
        model: {
          ...result.package.model,
          meta: { ...result.package.model.meta, title: file.title, composer: file.composer },
        },
      }
      inputs.push({
        source: result.source,
        pkg,
        piece: { ...newPieceRecord(pkg, { now }), lastOpenedAt: now - index },
      })
    }
    await storage.initializeLibrary(inputs)
  } finally {
    client.dispose()
  }
}
