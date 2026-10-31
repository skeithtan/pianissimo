import { describe, expect, it } from 'vitest'
import { importFixture, inspectFixture } from '../../../tests/unit/import/fixtures'
import { summarizeImport } from '../../core/import/summary'
import { handAssignmentId } from '../../core/model/practice'
import { hasTempo, tempoMapId } from '../../core/music/tempo'
import { detectAppleMobile } from './deps'
import { formatBytes, formatLastSpeed, formatRelativeTime, plural } from './format'
import {
  defaultBeatUnit,
  describeStaffUse,
  finalizeImport,
  finalizeStoredReview,
  initialDraft,
  parsePracticeBpm,
  reviewGate,
  storedDraft,
  storedReviewChanges,
} from './review'
import { candidateTitle, describePart, needsChoice, selectionProblem, togglePart } from './selection'

describe('format', () => {
  const now = new Date(2026, 9, 29, 15, 0).getTime()
  it('says when a piece was opened in plain words', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(formatRelativeTime(now - 60_000, now)).toBe('1 minute ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(formatRelativeTime(new Date(2026, 9, 28, 20).getTime(), now)).toBe('yesterday')
    expect(formatRelativeTime(new Date(2026, 9, 25, 9).getTime(), now)).toBe('4 days ago')
    // Older dates use the device locale (DECISIONS D9).
    const older = new Date(2026, 8, 2, 9)
    expect(formatRelativeTime(older.getTime(), now)).toBe(
      older.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
    )
  })
  it('formats speed, sizes and counts', () => {
    expect(formatLastSpeed(0.75)).toBe('75% speed')
    expect(formatLastSpeed(1)).toBe('100% speed')
    expect(formatBytes(512)).toBe('512 bytes')
    expect(formatBytes(1_500_000)).toBe('1.5 MB')
    expect(formatBytes(2_000_000_000)).toBe('2 GB')
    expect(formatBytes(NaN)).toBe('—')
    expect(plural(1, 'piece')).toBe('1 piece')
    expect(plural(3, 'piece')).toBe('3 pieces')
  })
  it('recognizes iPad and iPhone pickers', () => {
    expect(detectAppleMobile({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0)' })).toBe(true)
    expect(detectAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(
      true,
    )
    expect(detectAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(
      false,
    )
    expect(detectAppleMobile({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140' })).toBe(false)
  })
})

describe('score and part selection', () => {
  it('needs no choice for a single two-staff piano part', async () => {
    const inspect = await inspectFixture('two-hands.musicxml')
    expect(needsChoice(inspect)).toBe(false)
  })

  it('asks which part is the piano when the score has a voice part too', async () => {
    const inspect = await inspectFixture('two-parts.musicxml')
    const c = inspect.candidates[0]!
    expect(c.parts.map((p) => p.name)).toEqual(['Voice', 'Piano RH', 'Piano LH'])
    expect(needsChoice(inspect)).toBe(true)
    // The two piano staves are proposed; the user confirms.
    expect(c.suggestedParts).toEqual(['P2', 'P3'])
    expect(selectionProblem(c, c.suggestedParts)).toBeNull()
    expect(selectionProblem(c, ['P1', 'P2', 'P3'])).toMatch(/one two-staff piano part, or two one-staff parts/)
    expect(selectionProblem(c, [])).toMatch(/Choose the piano part/)
    expect(candidateTitle(c)).toBeTruthy()
    expect(describePart(c.parts[0]!)).toMatch(/^Soprano · 1 staff · \d+ notes$/)
    const toggled = togglePart(c, [c.parts[1]!.id], c.parts[0]!.id)
    expect(toggled).toEqual(['P1', 'P2']) // score order kept
    expect(togglePart(c, toggled, 'P1')).toEqual(['P2'])
  })

  it('rejects impossible selections with readable reasons', async () => {
    const inspect = await inspectFixture('two-hands.musicxml')
    const c = inspect.candidates[0]!
    const fake = { ...c, parts: [...c.parts, { ...c.parts[0]!, id: 'P2', name: 'Organ' }] }
    expect(selectionProblem(fake, ['P1', 'P2'])).toMatch(/single staff/)
    const three = { ...c, parts: [{ ...c.parts[0]!, staves: 3 }] }
    expect(selectionProblem(three, ['P1'])).toMatch(/3 staves/)
  })
})

describe('import review gate', () => {
  it('lets a ready score through untouched', async () => {
    const { package: pkg, summary } = await importFixture('two-hands.musicxml')
    const draft = initialDraft(summary, pkg.model)
    expect(reviewGate(summary, draft)).toEqual({ canSave: true, blockers: [], tempoError: null })
    const fin = finalizeImport(pkg.model, summary, draft)
    expect(fin.model).toBe(pkg.model) // nothing to apply
    expect(fin.userTempo).toBeUndefined()
  })

  it('requires choosing the hand of a voice split between the staves, and applies it', async () => {
    const { package: pkg, summary } = await importFixture('split-voice.musicxml')
    const ambiguous = summary.voices.find((v) => v.ambiguous)!
    expect(ambiguous).toBeDefined()
    const draft = initialDraft(summary, pkg.model)
    const gate = reviewGate(summary, draft)
    expect(gate.canSave).toBe(false)
    expect(gate.blockers.join(' ')).toMatch(/Choose which hand plays voice 2/)
    expect(() => finalizeImport(pkg.model, summary, draft)).toThrow(/Choose/)

    const chosen = { ...draft, hands: { ...draft.hands, [ambiguous.key]: 'R' as const }, handsConfirmed: true }
    expect(reviewGate(summary, chosen).canSave).toBe(true)
    const fin = finalizeImport(pkg.model, summary, chosen)
    expect(fin.model.hands.confirmed).toBe(true)
    expect(fin.model.hands.byVoice[ambiguous.key]).toBe('R')
    expect(fin.model.notes.filter((n) => `${n.partId}:${n.voice}` === ambiguous.key).every((n) => n.hand === 'R')).toBe(
      true,
    )
    expect(fin.summary.readiness.scoredPractice).toBe(true)
  })

  it('requires a practice tempo when the score has none, and validates it', async () => {
    const { package: pkg, summary } = await importFixture('no-tempo.musicxml')
    expect(summary.tempo.present).toBe(false)
    const draft = initialDraft(summary, pkg.model)
    const untouched = reviewGate(summary, draft)
    expect(untouched.canSave).toBe(false)
    expect(untouched.tempoError).toBeNull() // no error before the user types or tries to save
    expect(reviewGate(summary, draft, true).tempoError).toBe('Enter a practice tempo.')
    expect(reviewGate(summary, { ...draft, bpmText: 'fast' }).tempoError).toMatch(/number of beats per minute/)
    expect(reviewGate(summary, { ...draft, bpmText: '5' }).tempoError).toMatch(/between 20 and 300/)

    const typed = { ...draft, bpmText: '72', beatUnit: '3/8' as const }
    expect(reviewGate(summary, typed).canSave).toBe(true)
    const fin = finalizeImport(pkg.model, summary, typed)
    expect(hasTempo(fin.model.tempo)).toBe(true)
    expect(fin.model.tempo.segments[0]).toMatchObject({ beatBpm: 72, beatUnit: { n: 3, d: 8 }, source: 'user' })
    expect(fin.userTempo).toEqual({ beatBpm: 72, beatUnit: { n: 3, d: 8 } })
    expect(fin.summary.readiness.tempo).toBe(true)
  })

  it('parses practice tempos and picks a beat unit from the meter', async () => {
    expect(parsePracticeBpm(' 66 ')).toBe(66)
    expect(parsePracticeBpm('72,5')).toBe(72.5)
    expect(parsePracticeBpm('')).toMatch(/Enter/)
    const { package: pkg } = await importFixture('two-hands.musicxml')
    expect(defaultBeatUnit(pkg.model)).toBe('1/4')
    const sixEight = { ...pkg.model, meters: [{ ...pkg.model.meters[0]!, beats: 6, beatType: 8 }] }
    expect(defaultBeatUnit(sixEight)).toBe('3/8')
    const cut = { ...pkg.model, meters: [{ ...pkg.model.meters[0]!, beats: 2, beatType: 2 }] }
    expect(defaultBeatUnit(cut)).toBe('1/2')
    expect(defaultBeatUnit({ ...pkg.model, meters: [] })).toBe('1/4')
  })

  it('blocks saving when the import reported errors', async () => {
    const { package: pkg, summary } = await importFixture('two-hands.musicxml')
    const broken = { ...summary, diagnostics: { ...summary.diagnostics, errors: 1 } }
    const gate = reviewGate(broken, initialDraft(broken, pkg.model))
    expect(gate.canSave).toBe(false)
    expect(gate.blockers[0]).toMatch(/found an error/)
  })

  it('describes which staves a voice uses', () => {
    expect(describeStaffUse({ 0: 3, 1: 12 }, 2)).toBe('3 on the upper staff, 12 on the lower staff')
    expect(describeStaffUse({ 0: 4 }, 1)).toBe('4 on staff 1')
  })
})

describe('review of a stored piece (L5)', () => {
  /** A piece as stored after import: hands confirmed, and the typed tempo when there was none. */
  async function stored(name: string, bpmText = '') {
    const { package: pkg, summary } = await importFixture(name)
    let draft = initialDraft(summary, pkg.model)
    draft = { ...draft, handsConfirmed: true, bpmText }
    const fin = finalizeImport(pkg.model, summary, draft)
    return { model: fin.model, summary: summarizeImport(fin.model), userTempo: fin.userTempo }
  }

  it('starts from the stored hands and prefilled practice tempo, with nothing to save', async () => {
    const piece = await stored('no-tempo.musicxml', '72')
    const draft = storedDraft(piece.summary, piece.model, piece.userTempo)
    expect(draft).toMatchObject({ handsConfirmed: true, bpmText: '72', beatUnit: '1/4' })
    expect(reviewGate(piece.summary, draft, true, true).canSave).toBe(true)
    expect(storedReviewChanges(piece.summary, draft, piece.userTempo)).toEqual({ hands: false, tempo: false })
    expect(() => finalizeStoredReview(piece.model, piece.summary, draft, piece.userTempo)).toThrow(
      /Nothing has changed/,
    )
  })

  it('a new hand assignment keeps the score version and gets a new handsId', async () => {
    const piece = await stored('split-voice.musicxml')
    const voice = piece.summary.voices.find((v) => v.ambiguous)!
    const draft = storedDraft(piece.summary, piece.model, undefined)
    const flipped = {
      ...draft,
      hands: { ...draft.hands, [voice.key]: voice.hand === 'L' ? ('R' as const) : ('L' as const) },
    }
    const fin = finalizeStoredReview(piece.model, piece.summary, flipped, undefined)
    expect(fin.changes).toEqual({ hands: true, tempo: false })
    expect(fin.model.scoreVersionId).toBe(piece.model.scoreVersionId)
    expect(fin.model.hands.byVoice[voice.key]).toBe(flipped.hands[voice.key])
    expect(handAssignmentId(fin.model.hands)).not.toBe(handAssignmentId(piece.model.hands))
    expect(tempoMapId(fin.model.tempo)).toBe(tempoMapId(piece.model.tempo))
    expect(fin.userTempo).toBeUndefined()
  })

  it('a new practice tempo gets a new tempoMapId and is validated like at import', async () => {
    const piece = await stored('no-tempo.musicxml', '72')
    const draft = storedDraft(piece.summary, piece.model, piece.userTempo)
    expect(reviewGate(piece.summary, { ...draft, bpmText: '400' }, true, true).tempoError).toMatch(/between 20 and 300/)
    const fin = finalizeStoredReview(
      piece.model,
      piece.summary,
      { ...draft, bpmText: '90', beatUnit: '1/2' },
      piece.userTempo,
    )
    expect(fin.changes).toEqual({ hands: false, tempo: true })
    expect(fin.userTempo).toEqual({ beatBpm: 90, beatUnit: { n: 1, d: 2 } })
    expect(fin.model.tempo.segments[0]).toMatchObject({ beatBpm: 90, source: 'user' })
    expect(tempoMapId(fin.model.tempo)).not.toBe(tempoMapId(piece.model.tempo))
    expect(handAssignmentId(fin.model.hands)).toBe(handAssignmentId(piece.model.hands))
    expect(fin.model.scoreVersionId).toBe(piece.model.scoreVersionId)
  })

  it('the score tempo is not editable: only a tempo the user entered is', async () => {
    const piece = await stored('two-hands.musicxml')
    const draft = storedDraft(piece.summary, piece.model, undefined)
    expect(storedReviewChanges(piece.summary, { ...draft, bpmText: '200' }, undefined).tempo).toBe(false)
  })
})
