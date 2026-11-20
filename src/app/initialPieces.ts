/**
 * Included scores are ordinary pieces. Their sources are bundled with the app;
 * normalization uses the same worker as a user import. No notation engine or audio loads here.
 * The database owns eligibility and the atomic commit, including races with other tabs.
 */
import { createImportClient, type ImportClient } from '../core/import/client'
import type { ImportCommit, PianissimoStorage } from '../core/storage'
import { newPieceRecord } from '../core/storage/records'

const PREVIOUS_PIECES = [
  { file: 'ode-to-joy.mxl', title: 'Ode to Joy', composer: 'Ludwig van Beethoven' },
  { file: 'fur-elise.mxl', title: 'Für Elise', composer: 'Ludwig van Beethoven' },
] as const

const EXPANSION_PIECES = [
  {
    file: 'turkish-march-easy.mxl',
    title: 'Turkish March (easy arrangement)',
    composer: 'Wolfgang Amadeus Mozart',
  },
  { file: 'clair-de-lune-easy.mxl', title: 'Clair de lune (easy arrangement)', composer: 'Claude Debussy' },
  { file: 'friendly-day-hugo.mxl', title: 'Friendly Day (from Hugo, piano excerpt)', composer: 'Kevin MacLeod' },
  {
    file: 'prelude-in-c-major.mxl',
    title: 'Prelude in C Major, BWV 846',
    composer: 'Johann Sebastian Bach',
  },
  { file: 'canon-in-d.mxl', title: 'Canon in D (piano arrangement)', composer: 'Johann Pachelbel' },
  {
    file: 'nocturne-op-9-no-2-easy.mxl',
    title: 'Nocturne in E-flat Major, Op. 9 No. 2 (easy arrangement)',
    composer: 'Frédéric Chopin',
  },
  {
    file: 'moonlight-sonata-adagio.mxl',
    title: 'Moonlight Sonata — I. Adagio sostenuto',
    composer: 'Ludwig van Beethoven',
  },
  { file: 'the-entertainer.mxl', title: 'The Entertainer', composer: 'Scott Joplin' },
  {
    file: 'dance-of-the-sugar-plum-fairy.mxl',
    title: 'Dance of the Sugar Plum Fairy (piano transcription)',
    composer: 'Pyotr Ilyich Tchaikovsky',
  },
  {
    file: 'prelude-in-c-sharp-minor.mxl',
    title: 'Prelude in C-sharp Minor, Op. 3 No. 2',
    composer: 'Sergei Rachmaninoff',
  },
] as const

export const INITIAL_PIECES = [...PREVIOUS_PIECES, ...EXPANSION_PIECES] as const

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
  if (!(await storage.needsLibraryExpansion())) return
  const initial = await storage.needsInitialPieces()
  const entries = initial ? INITIAL_PIECES : EXPANSION_PIECES
  const loadFile = deps.loadFile ?? loadBundledFile
  const files = await Promise.all(entries.map(async (entry) => ({ ...entry, bytes: await loadFile(entry.file) })))
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
      if (!result.summary.readiness.scoredPractice || result.summary.unsupported.length > 0) {
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
    if (initial && (await storage.initializeLibrary(inputs))) return
    // An import or restore in a second tab may have claimed an empty database while we were
    // reading files. In that case, install only the expansion. The marker guards both paths.
    await storage.initializeLibrary(initial ? inputs.slice(PREVIOUS_PIECES.length) : inputs, 'expansion')
  } finally {
    client.dispose()
  }
}
