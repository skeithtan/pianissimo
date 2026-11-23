import { messageLanguage, msg } from './messages'

/** Older score packages and worker replies carry rendered English diagnostics. Only interpret
 * known importer sentences here. Filenames, titles, MusicXML tokens and printed bar numbers
 * are literal arguments. Some slots contain another importer-generated phrase. */
const templates: readonly [string, readonly number[]][] = [
  ['{0} in bar {1} has no exact duration. Completion time is not compared.', [0, 1]],
  ['{0} (pass {1})', []],
  ['Verbal tempo "{0}"', []],
  ['Timing instruction "{0}"', []],
  [
    'Bar {0}: the metronome mark {1} ({2} quarter notes per minute) disagrees with the playback tempo of {3} quarter notes per minute. The metronome mark is used. Check the tempo before practicing.',
    [],
  ],
  [
    'Voice {0} of “{1}” has notes on both staves in similar numbers ({2}), so the file does not say which hand plays it. Proposed: {3} hand. Choose the hand before scored practice.',
    [2, 3],
  ],
  [
    '{0} is a MusicXML opus: a list of other score files rather than a score. Open the compressed .mxl that contains those files, or open one of the score files directly.',
    [],
  ],
  [
    '{0} declares XML entities in its DOCTYPE. Entity declarations are refused for safety. Re-export the score from your notation program.',
    [],
  ],
  [
    '{0} is XML but not a MusicXML score: its root element is <{1}>. MusicXML scores start with <score-partwise> or <score-timewise>.',
    [],
  ],
  [
    '{0} is not a MusicXML score. Only MusicXML files (.musicxml, compressed .mxl, or MusicXML .xml) can be imported.',
    [],
  ],
  ['Bar {0} uses a non-traditional key signature. It is treated as having no sharps or flats for note naming.', []],
  ['Part “{0}” is written for a transposing instrument. Sounding pitches were derived from <transpose>.', []],
  ['{0} is not a valid compressed MusicXML archive (no zip signature). It may be damaged or incomplete.', []],
  ['Part “{0}” gives a {1} before stating <divisions>. One division per quarter note is assumed.', [1]],
  ['Unfolding the repeats produces more than {0} bars. The repeat structure may be malformed.', []],
  ['The first numerical tempo appears in bar {0}. It is also used for the music before it ({1}).', []],
  ['The endings starting in bar {0} have no repeat sign. They are played in written order.', []],
  ['The octave shift starting in bar {0} is never ended. It runs to the end of the score.', []],
  ['The compressed file’s container points to “{0}”, which is missing from the archive.', []],
  ['The compressed file has no META-INF/container.xml. Its only score, “{0}”, is used.', []],
  ['Bar {0} starts a repeat inside another repeat. The inner repeat is unfolded first.', []],
  ['Voice {0} of “{1}” is the {2} hand, and {3} of its notes {4} written on the other staff ({5}).', [2, 5]],
  ['Part “{0}” has {1} bars but the selection has {2}. Missing bars are treated as empty.', []],
  ['Two octave shifts overlap on one staff (bars {0} and {1}). The later one applies.', []],
  ['Part “{0}” has no content in timewise measure {1}. An empty measure was inserted.', []],
  ['A tie from {0}{1} in bar {2} has no matching note. The next note is attacked again.', []],
  ['{0} is too large to import ({1} million characters, with a limit of {2} million).', []],
  ['{0} is uncompressed XML despite its .mxl name, so it is read as MusicXML.', []],
  ['An octave shift starting in bar {0} is restarted in bar {1} without an end.', []],
  ['A <backup> in bar {0} moves before the start of the bar. It was clamped.', []],
  ['The import worker failed ({0}). Importing on the main thread instead.', []],
  ['The compressed file lists more than {0} entries. It cannot be opened.', []],
  ['“{0}” has a suspicious compression ratio ({1}:1). It cannot be expanded.', []],
  ['An octave-shift end in bar {0} has no matching start. It was ignored.', []],
  ['An octave shift of size {0} in bar {1} is not supported. It was ignored.', []],
  ['Bar {0} has two different tempo marks at one point ({1} and {2}). {3} is used.', []],
  ['Bar {0}: the score shows {1} but its playback tempo there is {2}. {3} is used.', []],
  ['“{0}” has {1} staves. Only one- or two-staff piano parts are supported.', []],
  ['A rolled chord in bar {0} has conflicting arrows. The first is used.', []],
  ['The ending starting in bar {0} is not closed before the next ending.', []],
  ['Choose which hand plays {0}: its notes are split between the staves.', [0]],
  ['Bar {0} uses a composite time signature. Its total length is used.', []],
  ['{0} declares the text encoding “{1}”, which this browser cannot read.', [0]],
  ['The container points to “{0}”, which is missing from the archive.', []],
  ['In {0} {1}{2}, {3} before the bar does. The rest of the bar is silent in {4}.', [0, 3, 4]],
  ['Opus “{0}” nests deeper than {1} levels. Deeper scores were skipped.', []],
  ['A tie ending on {0}{1} in bar {2} has no start. The note is attacked.', []],
  ['The ending in bar {0} has no number. It is treated as ending 1.', []],
  ['“{0}” in bar {1} is followed: the performance continues at bar {2}.', []],
  ['{0} is not valid {1} text. It may be damaged or not an XML file.', [0]],
  ['The compressed MusicXML file is damaged or incomplete ({0}).', [0]],
  ['{0} has an unusual extension but contains a MusicXML score.', []],
  ['A note in bar {0} has an unreadable pitch. It was skipped.', []],
  ['{0} in {1}: viewable, but scored practice is disabled there.', [0, 1]],
  ['Bar {0} has an unreadable time signature. It was ignored.', []],
  ['To Coda in bar {0} is followed: the coda starts at bar {1}.', []],
  ['Part “{0}” places notes on staff {1} but declares {2} staves.', []],
  ['The metronome mark “{0}” in bar {1} has no usable number.', []],
  ['Archive entry “{0}” is not a MusicXML score (root <{1}>).', []],
  ['Opus “{0}” refers to “{1}”, which is not in the archive.', []],
  ['{0} is a compressed archive, so it is read as .mxl.', []],
  ['Part “{0}” is not listed in the score’s part list.', []],
  ['Voice {0} in bar {1} extends past the end of the bar.', []],
  ['{0} contains {1} scores. Only the first {2} are offered.', []],
  ['The ending starting in bar {0} is never closed.', []],
  ['Staff {0} of “{1}” states no clef, so {2} is assumed.', [2]],
  ['The score has {0} notes. The import limit is {1}.', []],
  ['Parts number bar {0} differently. “{1}” is shown.', []],
  ['The score has {0} bars. The import limit is {1}.', []],
  ['{0} is not well-formed XML (line {1}, column {2}): {3}', []],
  ['{0} more “{1}” findings not listed ({2} in total).', []],
  ['{0} note{1} lie outside the 88-key piano range.', []],
  ['The compressed file does not contain “{0}”.', []],
  ['Bar {0} is shorter than its time signature.', []],
  ['“{0}” uses unsupported compression method {1}', []],
  ['“{0}” expands to {1} MB, above the {2} MB limit.', []],
  ['Bar {0} is longer than its time signature.', []],
  ['A note in bar {0} has no <duration>, so {1}.', [1]],
  ['Bar {0} has an invalid playback tempo “{1}”.', []],
  ['{0}: no D.C. or D.S. al Coda leads to it', []],
  ['The performance ends at Fine in bar {0}.', []],
  ['Part “{0}” is listed but has no music.', []],
  ['Could not start the import worker: {0}', []],
  ['Unknown voice “{0}” in hand assignment', []],
  ['Bar {0} states invalid <divisions> “{1}”.', []],
  ['“{0}” is {1} MB. The import limit is {2} MB.', []],
  ['{0} does not contain a MusicXML score.', []],
  ['Practice tempo set by you: {0} = {1}.', [0]],
  ['{0} contains no XML root element.', []],
  ['Skipping “{0}” ({1}): not MusicXML.', []],
  ['{0} could not be parsed as XML: {1}', []],
  ['Invalid hand “{0}” for voice “{1}”', []],
  ['no message from the browser{0}', []],
  ['Unexpected import failure: {0}', []],
  ['The score has no part “{0}”.', []],
  ['The file has no score “{0}”.', []],
  ['“{0}” has the wrong length', []],
  ['checksum mismatch in “{0}”', []],
  ['The import failed: {0}.', []],
  ['{0} contains no parts.', [0]],
  ['bar {0}', []],
  ['bars {0}', []],
  ['Invalid tempo {0}', []],
  ['“{0}” is empty.', []],
  ['{0} voices end', []],
  ['voice {0} of {1}', []],
]

const diagnostics = templates.map(([source, nested]) => ({
  source,
  nested,
  parts: source.split(/\{\d+\}/),
}))

/** Match fixed separators left to right, with no regex backtracking over imported file data. */
function argumentsOf(text: string, parts: string[]): string[] | null {
  if (!text.startsWith(parts[0]!) || !text.endsWith(parts[parts.length - 1]!)) return null
  const args: string[] = []
  let at = parts[0]!.length
  for (let i = 1; i < parts.length; i++) {
    const separator = parts[i]!
    const end = i === parts.length - 1 ? text.length - separator.length : text.indexOf(separator, at)
    if (end < at) return null
    args.push(text.slice(at, end))
    at = end + separator.length
  }
  return args
}

export function importMessage(text: string, depth = 0): string {
  if (messageLanguage() === 'en-US') return text
  const exact = msg(text)
  if (exact !== text || depth >= 3) return exact
  for (const { source, parts, nested } of diagnostics) {
    const args = argumentsOf(text, parts)
    if (!args) continue
    for (const i of nested) if (args[i]) args[i] = importMessage(args[i]!, depth + 1)
    return msg(source, ...args)
  }
  // Unsupported-region descriptions optionally list details in parentheses, separated by commas:
  // importer phrases, score text followed by a reason, or MusicXML tokens (kept as written).
  const suffix = text.indexOf(' (')
  if (suffix > 0 && text.endsWith(')')) {
    const details = text
      .slice(suffix + 2, -1)
      .split(', ')
      .map((detail) => regionDetail(detail, depth + 1))
    return `${msg(text.slice(0, suffix))} (${details.join(', ')})`
  }
  return text
}

/** Why a repeat instruction is not followed, after the instruction's own text ("D.S. al Coda: no segno before it"). */
const reasons = [
  'D.C. and D.S. in one bar',
  'no segno before it',
  'no Fine after the jump target',
  'no To Coda between the jump target and the jump',
  'no coda sign after the To Coda',
  'inside a repeated section',
]

function regionDetail(detail: string, depth: number): string {
  const known = importMessage(detail, depth)
  if (known !== detail) return known
  for (const reason of reasons)
    if (detail.endsWith(`: ${reason}`)) return msg('{0}: {1}', detail.slice(0, -reason.length - 2), msg(reason))
  return detail
}
