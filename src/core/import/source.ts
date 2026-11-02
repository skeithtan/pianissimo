/**
 * Format detection and document loading.
 *
 * Spec ("MusicXML score import"): accept .musicxml and compressed .mxl; accept .xml only when its
 * contents identify a MusicXML score and reject unrelated XML with a clear explanation. Detection
 * is by content (zip signature, then the XML root element), so a mislabeled file is still read
 * correctly and a non-MusicXML file is refused whatever its extension.
 */
import type { ScoreMeta } from '../model/score'
import type { DiagnosticSink } from './diagnostics'
import { ImportError } from './errors'
import type { ImportLimits } from './limits'
import { isZip, mxlRootfiles, resolveEntryPath, ZipReader } from './mxl'
import { decodeXmlBytes, extensionOf } from './text'
import { timewiseToPartwise } from './timewise'
import { attr, childrenNamed, elements, parseXmlDocument, scanProlog, type XmlElement } from './xml'

export type Packaging = ScoreMeta['packaging']

export const SINGLE_DOCUMENT_ID = 'score'

export interface SourceDocument {
  /** Candidate id: the archive entry path, or `SINGLE_DOCUMENT_ID` for an uncompressed file. */
  readonly id: string
  readonly entry?: string
  /** Always score-partwise (timewise input is converted). */
  readonly root: XmlElement
  readonly originalRoot: 'score-partwise' | 'score-timewise'
  readonly musicXmlVersion: string
}

export interface OpenedSource {
  readonly packaging: Packaging
  readonly documents: readonly SourceDocument[]
}

const ACCEPTED_EXTENSIONS = new Set(['musicxml', 'mxl', 'xml'])
const SCORE_ROOTS = new Set(['score-partwise', 'score-timewise'])

function notMusicXml(root: string | null, what: string): ImportError {
  if (root === null) {
    return new ImportError(
      'unsupported-format',
      `${what} is not a MusicXML score. Only MusicXML files (.musicxml, compressed .mxl, or MusicXML .xml) can be imported.`,
    )
  }
  return new ImportError(
    'not-musicxml',
    `${what} is XML but not a MusicXML score: its root element is <${root}>. MusicXML scores start with <score-partwise> or <score-timewise>.`,
  )
}

function toDocument(id: string, entry: string | undefined, root: XmlElement, diag: DiagnosticSink): SourceDocument {
  const originalRoot = root.name === 'score-timewise' ? 'score-timewise' : 'score-partwise'
  const partwise = originalRoot === 'score-timewise' ? timewiseToPartwise(root, diag) : root
  const doc: { -readonly [K in keyof SourceDocument]: SourceDocument[K] } = {
    id,
    root: partwise,
    originalRoot,
    musicXmlVersion: attr(root, 'version') ?? '1.0',
  }
  if (entry !== undefined) doc.entry = entry
  return doc
}

function parseScoreText(text: string, what: string, limits: ImportLimits): XmlElement {
  const prolog = scanProlog(text)
  if (prolog.root === 'opus') {
    throw new ImportError(
      'opus-external',
      `${what} is a MusicXML opus: a list of other score files rather than a score. Open the compressed .mxl that contains those files, or open one of the score files directly.`,
    )
  }
  if (!prolog.root || !SCORE_ROOTS.has(prolog.root)) throw notMusicXml(prolog.root, what)
  const root = parseXmlDocument(text, limits, what)
  if (!SCORE_ROOTS.has(root.name)) throw notMusicXml(root.name, what)
  return root
}

/** Score entries reachable from an opus document inside an archive (depth-limited). */
function opusScores(
  zip: ZipReader,
  entry: string,
  limits: ImportLimits,
  depth: number,
  diag: DiagnosticSink,
  seen: Set<string>,
): string[] {
  if (depth > limits.maxOpusDepth) {
    diag.warn(
      'opus-depth',
      `Opus “${entry}” nests deeper than ${limits.maxOpusDepth} levels. Deeper scores were skipped.`,
    )
    return []
  }
  if (seen.has(entry)) return []
  seen.add(entry)
  const opus = parseXmlDocument(decodeXmlBytes(zip.read(entry), entry), limits, `“${entry}”`)
  const out: string[] = []
  const walk = (node: XmlElement) => {
    for (const c of elements(node)) {
      const href = attr(c, 'xlink:href') ?? attr(c, 'href')
      if ((c.name === 'score' || c.name === 'opus-link') && href) {
        const target = resolveEntryPath(entry, href)
        if (!zip.has(target)) {
          diag.warn('opus-missing-score', `Opus “${entry}” refers to “${href}”, which is not in the archive.`)
          continue
        }
        if (c.name === 'opus-link') out.push(...opusScores(zip, target, limits, depth + 1, diag, seen))
        else out.push(target)
      } else if (c.name === 'opus') {
        walk(c)
      }
    }
  }
  walk(opus)
  return out
}

/**
 * Detect the packaging and load the score documents. With `onlyId`, only that candidate is
 * parsed (used when building the selected score).
 */
export function openSource(
  bytes: Uint8Array,
  fileName: string,
  limits: ImportLimits,
  diag: DiagnosticSink,
  onlyId?: string,
): OpenedSource {
  if (bytes.length === 0) throw new ImportError('file-empty', `“${fileName}” is empty.`)
  if (bytes.length > limits.maxInputBytes) {
    throw new ImportError(
      'file-too-large',
      `“${fileName}” is ${Math.round(bytes.length / 1e6)} MB. The import limit is ${Math.round(limits.maxInputBytes / 1e6)} MB.`,
    )
  }
  const ext = extensionOf(fileName)
  const what = `“${fileName}”`

  if (isZip(bytes)) {
    if (ext !== 'mxl') diag.info('packaging-by-content', `${what} is a compressed archive, so it is read as .mxl.`)
    const zip = new ZipReader(bytes, limits)
    const rootfiles = mxlRootfiles(zip, limits, diag)
    const scoreEntries: string[] = []
    const seen = new Set<string>()
    const texts = new Map<string, string>()
    for (const rf of rootfiles) {
      const head = decodeXmlBytes(zip.read(rf), `“${rf}”`)
      texts.set(rf, head)
      const prolog = scanProlog(head)
      if (prolog.root === 'opus') scoreEntries.push(...opusScores(zip, rf, limits, 1, diag, seen))
      else if (prolog.root && SCORE_ROOTS.has(prolog.root)) scoreEntries.push(rf)
      else
        diag.warn(
          'mxl-rootfile-not-score',
          `Archive entry “${rf}” is not a MusicXML score (root <${prolog.root ?? '?'}>).`,
        )
    }
    const unique = [...new Set(scoreEntries)]
    if (unique.length === 0) {
      throw new ImportError('mxl-no-score', `${what} does not contain a MusicXML score.`)
    }
    if (unique.length > limits.maxCandidates) {
      diag.warn(
        'candidates-truncated',
        `${what} contains ${unique.length} scores. Only the first ${limits.maxCandidates} are offered.`,
      )
    }
    const documents: SourceDocument[] = []
    for (const entry of unique.slice(0, limits.maxCandidates)) {
      if (onlyId !== undefined && entry !== onlyId) continue
      const text = texts.get(entry) ?? decodeXmlBytes(zip.read(entry), `“${entry}”`)
      documents.push(toDocument(entry, entry, parseScoreText(text, `“${entry}”`, limits), diag))
    }
    return { packaging: 'mxl', documents }
  }

  if (ext === 'mxl') {
    const looksXml = bytes[0] === 0x3c || (bytes[0] === 0xef && bytes[3] === 0x3c)
    if (!looksXml) {
      throw new ImportError(
        'mxl-damaged',
        `${what} is not a valid compressed MusicXML archive (no zip signature). It may be damaged or incomplete.`,
      )
    }
    diag.warn('packaging-by-content', `${what} is uncompressed XML despite its .mxl name, so it is read as MusicXML.`)
  }
  const text = decodeXmlBytes(bytes, what)
  const root = parseScoreText(text, what, limits)
  if (!ACCEPTED_EXTENSIONS.has(ext))
    diag.info('packaging-by-content', `${what} has an unusual extension but contains a MusicXML score.`)
  const packaging: Packaging = ext === 'xml' ? 'xml' : 'musicxml'
  return { packaging, documents: [toDocument(SINGLE_DOCUMENT_ID, undefined, root, diag)] }
}

export function scoreParts(root: XmlElement): XmlElement[] {
  return childrenNamed(root, 'part')
}
