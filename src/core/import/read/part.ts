/**
 * Read one `<part>` of a score-partwise document into raw, source-positioned data.
 *
 * Spec ("Common score model and import pipeline"): timing follows MusicXML's cursor model in
 * document order — `<duration>` advances the cursor, `<backup>`/`<forward>` move it, `<chord/>`
 * notes share the previous note's onset, grace notes take no time. `<divisions>` may change at
 * any `<attributes>`; durations are converted to exact whole notes as they are read.
 */
import { type Rational, ONE, ZERO, add, gt, lt, max, rat, sub } from '../../music/rational'
import { isStep, type Spelling } from '../../music/pitch'
import type { ClefDef, PedalKind } from '../../model/score'
import type { DiagnosticSink } from '../diagnostics'
import { classifyNavWords, isInstruction } from '../navigation'
import { isSectionHeading, type HeadingStyle } from '../sections'
import { attr, child, childrenNamed, childText, elements, textOf, toInt, toNum, type XmlElement } from '../xml'
import type {
  PartData,
  RawBarlines,
  RawClef,
  RawDivisions,
  RawDynamics,
  NavKind,
  RawKey,
  RawMeasure,
  RawMetronome,
  RawNavMark,
  RawSection,
  RawNote,
  RawOttava,
  RawPedal,
  RawTempo,
  RawTime,
  RawWords,
} from './types'
import { clampVelocity, decimalRat, divisionsToWhole, noteTypeValue } from './values'

/** Conventional velocities for dynamics marks without `<sound dynamics>` (MuseScore defaults). */
const MARK_VELOCITY: Readonly<Record<string, number>> = {
  pppppp: 4,
  ppppp: 8,
  pppp: 12,
  ppp: 16,
  pp: 33,
  p: 49,
  mp: 64,
  mf: 80,
  f: 96,
  ff: 112,
  fff: 126,
  ffff: 127,
  fffff: 127,
  ffffff: 127,
}

const DEFAULT_CLEF_LINE: Readonly<Record<string, number>> = { G: 2, F: 4, C: 3, percussion: 3, TAB: 5, none: 3 }

/** `<sound>` attributes that are navigation marks (dacapo is yes/no, the others are tokens). */
const SOUND_NAV: readonly NavKind[] = ['segno', 'coda', 'tocoda', 'fine', 'dacapo', 'dalsegno']

export interface ReadPartOptions {
  /** Read timing, directions and attributes but not notes (tempo from unselected parts). */
  readonly tempoOnly?: boolean
}

class PartReader {
  private readonly notes: RawNote[] = []
  private readonly keys: RawKey[] = []
  private readonly times: RawTime[] = []
  private readonly clefs: RawClef[] = []
  private readonly divisionsList: RawDivisions[] = []
  private readonly tempos: RawTempo[] = []
  private readonly dynamics: RawDynamics[] = []
  private readonly pedals: RawPedal[] = []
  private readonly ottavas: RawOttava[] = []
  private readonly words: RawWords[] = []
  private readonly navigation: RawNavMark[] = []
  private readonly sections: RawSection[] = []
  private readonly measures: RawMeasure[] = []
  private transpose: PartData['transpose']
  private staves = 1
  private divisions: Rational = ONE
  private divisionsSeen = false
  private docOrder = 0
  private readonly openPedalKind = new Map<string, PedalKind>()

  // Per-measure state.
  private m = 0
  private number = ''
  private cursor: Rational = ZERO
  private filled: Rational = ZERO
  private lastNoteAt: Rational = ZERO
  private voiceEnds = new Map<string, Rational>()

  constructor(
    private readonly partId: string,
    private readonly diag: DiagnosticSink,
    private readonly options: ReadPartOptions,
  ) {}

  read(part: XmlElement): PartData {
    const measureEls = childrenNamed(part, 'measure')
    measureEls.forEach((measure, index) => this.readMeasure(measure, index))
    const data: { -readonly [K in keyof PartData]: PartData[K] } = {
      id: this.partId,
      staves: this.staves,
      measures: this.measures,
      notes: this.notes,
      keys: this.keys,
      times: this.times,
      clefs: this.clefs,
      divisions: this.divisionsList,
      tempos: this.tempos,
      dynamics: this.dynamics,
      pedals: this.pedals,
      ottavas: this.ottavas,
      words: this.words,
      navigation: this.navigation,
      sections: this.sections,
    }
    if (this.transpose) data.transpose = this.transpose
    return data
  }

  private where(): { measure: string } {
    return { measure: this.number }
  }

  private duration(raw: string | undefined, what: string): Rational | undefined {
    const value = decimalRat(raw)
    if (value === undefined) return undefined
    if (!this.divisionsSeen) {
      this.divisionsSeen = true
      this.diag.warn(
        'divisions-missing',
        `Part “${this.partId}” gives a ${what} before stating <divisions>; one division per quarter note is assumed.`,
        this.where(),
      )
    }
    return divisionsToWhole(value, this.divisions)
  }

  private moveCursor(to: Rational): void {
    if (lt(to, ZERO)) {
      this.diag.warn(
        'backup-before-measure',
        `A <backup> in bar ${this.number} moves before the start of the bar; it was clamped.`,
        this.where(),
      )
      this.cursor = ZERO
      return
    }
    this.cursor = to
    this.filled = max(this.filled, to)
  }

  private readMeasure(measure: XmlElement, index: number): void {
    this.m = index
    this.number = attr(measure, 'number') ?? String(index + 1)
    this.cursor = ZERO
    this.filled = ZERO
    this.lastNoteAt = ZERO
    this.voiceEnds = new Map()
    const barlines: { -readonly [K in keyof RawBarlines]: RawBarlines[K] } = { forwardRepeat: false, endingStop: false }
    let hasMultiRest = false

    for (const c of elements(measure)) {
      switch (c.name) {
        case 'note':
          this.readNote(c)
          break
        case 'backup': {
          const d = this.duration(childText(c, 'duration'), '<backup>')
          if (d) this.moveCursor(sub(this.cursor, d))
          break
        }
        case 'forward': {
          const d = this.duration(childText(c, 'duration'), '<forward>')
          if (d) this.moveCursor(add(this.cursor, d))
          break
        }
        case 'attributes':
          if (this.readAttributes(c)) hasMultiRest = true
          break
        case 'direction':
          this.readDirection(c)
          break
        case 'sound':
          this.readSound(c, undefined, { marks: [], tempoInDirection: false })
          for (const [kind, token] of soundNav(c)) this.pushNav(kind, this.cursor, { token, el: c })
          break
        case 'barline':
          this.readBarline(c, barlines)
          break
        default:
          break
      }
    }
    this.measures.push({
      index,
      number: this.number,
      implicit: attr(measure, 'implicit') === 'yes',
      filled: this.filled,
      voiceEnds: this.voiceEnds,
      barlines,
      hasMultiRest,
    })
  }

  // -------------------------------------------------------------------------------------------
  // Notes

  private readNote(c: XmlElement): void {
    const grace = child(c, 'grace') !== undefined
    const chord = child(c, 'chord') !== undefined
    const cue = child(c, 'cue') !== undefined
    let duration = grace ? ZERO : this.duration(childText(c, 'duration'), 'note duration')
    if (duration === undefined) {
      const typed = noteTypeValue(childText(c, 'type') ?? '', childrenNamed(c, 'dot').length)
      duration = typed ?? ZERO
      this.diag.warn(
        'note-duration-missing',
        `A note in bar ${this.number} has no <duration>; ${typed ? 'its notated type was used' : 'it was given no length'}.`,
        this.where(),
      )
    }
    const at = chord ? this.lastNoteAt : this.cursor
    if (!chord) {
      this.lastNoteAt = at
      if (!grace) this.moveCursor(add(at, duration))
    }
    const voice = childText(c, 'voice') || '1'
    if (!grace) {
      const end = add(at, duration)
      const prev = this.voiceEnds.get(voice)
      if (!prev || gt(end, prev)) this.voiceEnds.set(voice, end)
    }
    const docOrder = this.docOrder++
    if (this.options.tempoOnly) return

    const rest = child(c, 'rest') !== undefined
    const unpitched = child(c, 'unpitched') !== undefined
    let pitch: Spelling | undefined
    const pitchEl = child(c, 'pitch')
    if (pitchEl) {
      const step = (childText(pitchEl, 'step') ?? '').toUpperCase()
      const octave = toInt(childText(pitchEl, 'octave'))
      const alter = toNum(childText(pitchEl, 'alter')) ?? 0
      if (isStep(step) && octave !== undefined) pitch = { step, alter, octave }
      else
        this.diag.error(
          'note-pitch-invalid',
          `A note in bar ${this.number} has an unreadable pitch; it was skipped.`,
          this.where(),
        )
    }
    if (!rest && !unpitched && !pitch) return

    let tieStart = false
    let tieStop = false
    for (const t of childrenNamed(c, 'tie')) {
      const type = attr(t, 'type')
      if (type === 'start') tieStart = true
      else if (type === 'stop') tieStop = true
    }
    const hasTieElements = childrenNamed(c, 'tie').length > 0
    let arpeggiate: RawNote['arpeggiate']
    let fermata = false
    let caesura = false
    const ornaments: string[] = []
    let fingering: string | undefined
    for (const n of childrenNamed(c, 'notations')) {
      for (const x of elements(n)) {
        switch (x.name) {
          case 'tied': {
            if (hasTieElements) break
            const type = attr(x, 'type')
            if (type === 'start' || type === 'continue') tieStart = true
            if (type === 'stop' || type === 'continue') tieStop = true
            break
          }
          case 'arpeggiate': {
            const a: { number?: string; direction?: 'up' | 'down' } = {}
            const num = attr(x, 'number')
            const dir = attr(x, 'direction')
            if (num !== undefined) a.number = num
            if (dir === 'up' || dir === 'down') a.direction = dir
            arpeggiate = a
            break
          }
          case 'fermata':
            fermata = true
            break
          case 'ornaments':
            for (const o of elements(x)) if (o.name !== 'accidental-mark') ornaments.push(o.name)
            break
          case 'technical':
            if (fingering === undefined) {
              const f = child(x, 'fingering')
              if (f) fingering = textOf(f) || undefined
            }
            break
          case 'articulations':
            if (child(x, 'caesura')) caesura = true
            break
          default:
            break
        }
      }
    }

    const note: { -readonly [K in keyof RawNote]: RawNote[K] } = {
      partId: this.partId,
      docOrder,
      m: this.m,
      at,
      duration,
      voice,
      staff: toInt(childText(c, 'staff')) ?? 1,
      rest,
      unpitched,
      chord,
      grace,
      cue,
      tieStart,
      tieStop,
      fermata,
      caesura,
      ornaments,
      printObject: attr(c, 'print-object') !== 'no',
    }
    if (pitch) note.pitch = pitch
    const accidental = childText(c, 'accidental')
    if (accidental) note.printedAccidental = accidental
    if (arpeggiate) note.arpeggiate = arpeggiate
    if (fingering !== undefined) note.fingering = fingering
    const attack = decimalRat(attr(c, 'attack'))
    if (attack !== undefined) note.attack = divisionsToWhole(attack, this.divisions)
    const dyn = toNum(attr(c, 'dynamics'))
    if (dyn !== undefined) note.dynamicsPct = dyn
    this.notes.push(note)
  }

  // -------------------------------------------------------------------------------------------
  // Attributes

  /** Returns true when the attributes request a multi-measure rest display. */
  private readAttributes(c: XmlElement): boolean {
    const at = this.cursor
    let multiRest = false
    for (const x of elements(c)) {
      switch (x.name) {
        case 'divisions': {
          const value = decimalRat(textOf(x))
          if (value && value.n > 0) {
            this.divisions = value
            this.divisionsSeen = true
            this.divisionsList.push({ m: this.m, at, value })
          } else {
            this.diag.error(
              'divisions-invalid',
              `Bar ${this.number} states invalid <divisions> “${textOf(x)}”.`,
              this.where(),
            )
          }
          break
        }
        case 'key':
          this.readKey(x, at)
          break
        case 'time':
          this.readTime(x, at)
          break
        case 'staves': {
          const n = toInt(textOf(x))
          if (n !== undefined && n > 0) this.staves = Math.max(this.staves, n)
          break
        }
        case 'clef':
          this.readClef(x, at)
          break
        case 'transpose': {
          const chromatic = toInt(childText(x, 'chromatic')) ?? 0
          const diatonic = toInt(childText(x, 'diatonic')) ?? 0
          const octaveChange = toInt(childText(x, 'octave-change')) ?? 0
          if (chromatic !== 0 || octaveChange !== 0) {
            this.transpose = { chromatic, diatonic, octaveChange }
            this.diag.warn(
              'transposing-part',
              `Part “${this.partId}” is written for a transposing instrument; sounding pitches were derived from <transpose>.`,
              this.where(),
            )
          }
          break
        }
        case 'measure-style':
          if (child(x, 'multiple-rest')) multiRest = true
          break
        default:
          break
      }
    }
    return multiRest
  }

  private readKey(x: XmlElement, at: Rational): void {
    const number = attr(x, 'number')
    if (number !== undefined && number !== '1') return
    const fifths = toInt(childText(x, 'fifths'))
    if (fifths === undefined) {
      this.diag.warn(
        'key-nontraditional',
        `Bar ${this.number} uses a non-traditional key signature; it is treated as having no sharps or flats for note naming.`,
        this.where(),
      )
      this.keys.push({ m: this.m, at, fifths: 0, el: x })
      return
    }
    const key: { -readonly [K in keyof RawKey]: RawKey[K] } = {
      m: this.m,
      at,
      fifths: Math.max(-7, Math.min(7, fifths)),
      el: x,
    }
    const mode = childText(x, 'mode')
    if (mode) key.mode = mode
    this.keys.push(key)
  }

  private readTime(x: XmlElement, at: Rational): void {
    const number = attr(x, 'number')
    if (number !== undefined && number !== '1') return
    const symbol = attr(x, 'symbol')
    if (child(x, 'senza-misura')) {
      const t: { -readonly [K in keyof RawTime]: RawTime[K] } = {
        m: this.m,
        at,
        beats: 0,
        beatType: 4,
        beatsText: '',
        nominal: ZERO,
        senzaMisura: true,
        el: x,
      }
      if (symbol) t.symbol = symbol
      this.times.push(t)
      return
    }
    const beatsEls = childrenNamed(x, 'beats')
    const typeEls = childrenNamed(x, 'beat-type')
    let nominal = ZERO
    let firstBeats = 0
    let firstType = 4
    for (let i = 0; i < beatsEls.length; i++) {
      const beatsText = textOf(beatsEls[i])
      const beatType = toInt(textOf(typeEls[i] ?? typeEls[typeEls.length - 1]))
      const parts = beatsText.split('+').map((s) => toInt(s))
      if (beatType === undefined || beatType <= 0 || parts.some((p) => p === undefined || p <= 0)) continue
      const beats = parts.reduce<number>((a, b) => a + (b ?? 0), 0)
      if (i === 0) {
        firstBeats = beats
        firstType = beatType
      }
      nominal = add(nominal, rat(beats, beatType))
    }
    if (firstBeats === 0) {
      this.diag.warn(
        'time-invalid',
        `Bar ${this.number} has an unreadable time signature; it was ignored.`,
        this.where(),
      )
      return
    }
    if (beatsEls.length > 1) {
      this.diag.info(
        'time-composite',
        `Bar ${this.number} uses a composite time signature; its total length is used.`,
        this.where(),
      )
    }
    const t: { -readonly [K in keyof RawTime]: RawTime[K] } = {
      m: this.m,
      at,
      beats: firstBeats,
      beatType: firstType,
      beatsText: textOf(beatsEls[0]),
      nominal,
      senzaMisura: false,
      el: x,
    }
    if (symbol) t.symbol = symbol
    this.times.push(t)
  }

  private readClef(x: XmlElement, at: Rational): void {
    const staff = toInt(attr(x, 'number')) ?? 1
    const signText = childText(x, 'sign') ?? 'G'
    const sign: ClefDef['sign'] =
      signText === 'G' ||
      signText === 'F' ||
      signText === 'C' ||
      signText === 'percussion' ||
      signText === 'TAB' ||
      signText === 'none'
        ? signText
        : 'none'
    const line = toInt(childText(x, 'line')) ?? DEFAULT_CLEF_LINE[sign] ?? 3
    const octaveChange = toInt(childText(x, 'clef-octave-change')) ?? 0
    this.clefs.push({ m: this.m, at, staff, clef: { sign, line, octaveChange }, el: x })
  }

  // -------------------------------------------------------------------------------------------
  // Directions and sound

  private readDirection(c: XmlElement): void {
    const at = this.cursor
    const staff = toInt(childText(c, 'staff'))
    const marks: string[] = []
    let metronome: RawMetronome | undefined
    let metricModulation = false
    const texts: string[] = []
    const signs: NavKind[] = []
    let pedalSeen = false
    // Section marks: rehearsal marks always; words only when the direction is nothing but words
    // styled like a heading (sections.ts).
    const rehearsals: string[] = []
    let onlyWords = true
    let heading = true
    for (const dt of childrenNamed(c, 'direction-type')) {
      for (const x of elements(dt)) {
        if (x.name !== 'words' && x.name !== 'rehearsal') onlyWords = false
        switch (x.name) {
          case 'segno':
          case 'coda':
            signs.push(x.name)
            break
          case 'octave-shift':
            this.readOctaveShift(x, at, staff)
            break
          case 'pedal':
            pedalSeen = this.readPedal(x, at, staff) || pedalSeen
            break
          case 'dynamics':
            for (const d of elements(x)) marks.push(d.name === 'other-dynamics' ? textOf(d) : d.name)
            break
          case 'metronome': {
            const parsed = this.readMetronome(x)
            if (parsed === 'modulation') metricModulation = true
            else if (parsed) metronome = parsed
            break
          }
          case 'words': {
            const text = textOf(x)
            if (text) {
              texts.push(text)
              const style: HeadingStyle = {
                placement: attr(c, 'placement'),
                fontStyle: attr(x, 'font-style'),
                fontWeight: attr(x, 'font-weight'),
                enclosure: attr(x, 'enclosure'),
              }
              heading &&= isSectionHeading(text, style)
            }
            break
          }
          case 'rehearsal': {
            const text = textOf(x)
            if (text) rehearsals.push(text)
            break
          }
          default:
            break
        }
      }
    }
    for (const label of rehearsals) this.sections.push({ m: this.m, at, label, source: 'rehearsal' })
    const sound = child(c, 'sound')
    const soundTempo = sound ? this.readSound(sound, staff, { marks, tempoInDirection: true, pedalSeen }) : undefined
    if (!sound && marks.length > 0) this.pushMarkDynamics(at, staff, marks)
    if (metronome || soundTempo !== undefined) {
      const t: { -readonly [K in keyof RawTempo]: RawTempo[K] } = { partId: this.partId, m: this.m, at }
      if (soundTempo !== undefined) t.sound = soundTempo
      if (metronome) t.metronome = metronome
      this.tempos.push(t)
    }
    const withTempo = metronome !== undefined || soundTempo !== undefined
    if (onlyWords && heading && !withTempo && rehearsals.length === 0 && texts.length > 0) {
      this.sections.push({ m: this.m, at, label: texts.join(' '), source: 'words' })
    }
    for (const text of texts) {
      const w: { -readonly [K in keyof RawWords]: RawWords[K] } = { m: this.m, at, text, withTempo }
      if (staff !== undefined) w.staff = staff
      this.words.push(w)
    }
    this.readDirectionNav(c, at, texts, signs, sound)
    if (metricModulation && !withTempo) {
      const w: { -readonly [K in keyof RawWords]: RawWords[K] } = {
        m: this.m,
        at,
        text: 'metric modulation',
        withTempo: false,
        metricModulation: true,
      }
      if (staff !== undefined) w.staff = staff
      this.words.push(w)
    }
  }

  /**
   * Navigation marks of one direction: `<sound>` attributes first, then recognized words; the
   * direction's segno/coda signs only when it carries no instruction (a "To Coda ⊕" sign is the
   * jump point, not the coda).
   */
  private readDirectionNav(
    c: XmlElement,
    at: Rational,
    texts: readonly string[],
    signs: readonly NavKind[],
    sound: XmlElement | undefined,
  ): void {
    const text = texts.join(' ').replace(/\s+/g, ' ').trim()
    const kinds = new Map<NavKind, string | undefined>(sound ? soundNav(sound) : [])
    if (text) for (const k of classifyNavWords(text).kinds) if (!kinds.has(k)) kinds.set(k, undefined)
    if (![...kinds.keys()].some(isInstruction)) for (const k of signs) if (!kinds.has(k)) kinds.set(k, undefined)
    for (const [kind, token] of kinds) this.pushNav(kind, at, { token, text: text || undefined, el: c })
  }

  private pushNav(
    kind: NavKind,
    at: Rational,
    extra: { token?: string | undefined; text?: string | undefined; el?: XmlElement; endOfBar?: boolean },
  ): void {
    const mark: { -readonly [K in keyof RawNavMark]: RawNavMark[K] } = { m: this.m, at, kind }
    if (extra.token) mark.token = extra.token
    if (extra.text) mark.text = extra.text
    if (extra.el) mark.el = extra.el
    if (extra.endOfBar) mark.endOfBar = true
    this.navigation.push(mark)
  }

  private pushMarkDynamics(at: Rational, staff: number | undefined, marks: readonly string[]): void {
    for (const mark of marks) {
      const v = MARK_VELOCITY[mark]
      if (v === undefined) continue
      const d: { -readonly [K in keyof RawDynamics]: RawDynamics[K] } = { m: this.m, at, velocity: v, text: mark }
      if (staff !== undefined) d.staff = staff
      this.dynamics.push(d)
    }
  }

  /**
   * `<sound>` playback values. Returns the tempo (quarter notes per minute) when present; the
   * caller pairs it with a metronome mark from the same direction.
   */
  private readSound(
    s: XmlElement,
    staff: number | undefined,
    ctx: { marks: readonly string[]; tempoInDirection: boolean; pedalSeen?: boolean },
  ): number | undefined {
    const at = this.cursor
    const dyn = toNum(attr(s, 'dynamics'))
    if (dyn !== undefined && dyn >= 0) {
      const d: { -readonly [K in keyof RawDynamics]: RawDynamics[K] } = {
        m: this.m,
        at,
        velocity: clampVelocity(dyn * 0.9),
      }
      if (ctx.marks.length > 0) d.text = ctx.marks.join(' ')
      if (staff !== undefined) d.staff = staff
      this.dynamics.push(d)
    } else if (ctx.marks.length > 0) {
      this.pushMarkDynamics(at, staff, ctx.marks)
    }
    if (!ctx.pedalSeen) {
      this.soundPedal(attr(s, 'damper-pedal'), 'sustain', at, staff)
      this.soundPedal(attr(s, 'soft-pedal'), 'soft', at, staff)
      this.soundPedal(attr(s, 'sostenuto-pedal'), 'sostenuto', at, staff)
    }
    const tempo = toNum(attr(s, 'tempo'))
    if (tempo === undefined) return undefined
    if (!(tempo > 0)) {
      this.diag.warn(
        'tempo-invalid',
        `Bar ${this.number} has an invalid playback tempo “${attr(s, 'tempo') ?? ''}”.`,
        this.where(),
      )
      return undefined
    }
    if (!ctx.tempoInDirection) this.tempos.push({ partId: this.partId, m: this.m, at, sound: tempo })
    return tempo
  }

  private soundPedal(value: string | undefined, kind: PedalKind, at: Rational, staff: number | undefined): void {
    if (value === undefined) return
    let type: RawPedal['type']
    let v: number
    if (value === 'yes') {
      type = 'start'
      v = 127
    } else if (value === 'no') {
      type = 'stop'
      v = 0
    } else {
      const pct = toNum(value)
      if (pct === undefined) return
      v = Math.max(0, Math.min(127, Math.round((pct / 100) * 127)))
      type = v > 0 ? 'start' : 'stop'
    }
    const p: { -readonly [K in keyof RawPedal]: RawPedal[K] } = { m: this.m, at, kind, type, value: v }
    if (staff !== undefined) p.staff = staff
    this.pedals.push(p)
  }

  /** Returns true when a playable pedal mark was recorded. */
  private readPedal(x: XmlElement, at: Rational, staff: number | undefined): boolean {
    const raw = attr(x, 'type')
    const number = attr(x, 'number') ?? '1'
    let kind: PedalKind = this.openPedalKind.get(number) ?? 'sustain'
    let type: RawPedal['type']
    switch (raw) {
      case 'start':
      case 'resume':
        kind = 'sustain'
        type = 'start'
        this.openPedalKind.set(number, kind)
        break
      case 'sostenuto':
        kind = 'sostenuto'
        type = 'start'
        this.openPedalKind.set(number, kind)
        break
      case 'stop':
      case 'discontinue':
        type = 'stop'
        this.openPedalKind.delete(number)
        break
      case 'change':
        type = 'change'
        break
      case 'continue':
        type = 'continue'
        break
      default:
        return false
    }
    const p: { -readonly [K in keyof RawPedal]: RawPedal[K] } = { m: this.m, at, kind, type }
    if (staff !== undefined) p.staff = staff
    this.pedals.push(p)
    return true
  }

  private readOctaveShift(x: XmlElement, at: Rational, staff: number | undefined): void {
    const type = attr(x, 'type')
    if (type !== 'up' && type !== 'down' && type !== 'stop' && type !== 'continue') return
    this.ottavas.push({
      m: this.m,
      at,
      staff: staff ?? 1,
      type,
      size: toInt(attr(x, 'size')) ?? 8,
      number: attr(x, 'number') ?? '1',
      el: x,
    })
  }

  private readMetronome(x: XmlElement): RawMetronome | 'modulation' | undefined {
    const units = childrenNamed(x, 'beat-unit')
    const perMinuteText = childText(x, 'per-minute')
    if (units.length >= 2) return 'modulation'
    if (units.length !== 1 || perMinuteText === undefined) return undefined
    const dots = childrenNamed(x, 'beat-unit-dot').length
    const beatUnit = noteTypeValue(textOf(units[0]), dots)
    const m = /(\d+(?:\.\d+)?)/.exec(perMinuteText)
    const perMinute = m ? Number(m[1]) : Number.NaN
    if (!beatUnit || !(perMinute > 0)) {
      this.diag.info(
        'metronome-unreadable',
        `The metronome mark “${perMinuteText}” in bar ${this.number} has no usable number.`,
        this.where(),
      )
      return undefined
    }
    return { beatUnit, perMinute, printed: attr(x, 'print-object') !== 'no' }
  }

  // -------------------------------------------------------------------------------------------
  // Barlines

  private readBarline(c: XmlElement, out: { -readonly [K in keyof RawBarlines]: RawBarlines[K] }): void {
    const location = attr(c, 'location') ?? 'right'
    const repeat = child(c, 'repeat')
    if (repeat) {
      const direction = attr(repeat, 'direction')
      if (direction === 'forward') out.forwardRepeat = true
      else if (direction === 'backward') {
        const times = toInt(attr(repeat, 'times'))
        out.backwardRepeat = times !== undefined && times > 0 ? { times } : {}
      }
    }
    const ending = child(c, 'ending')
    if (ending) {
      const type = attr(ending, 'type')
      const text = attr(ending, 'number') ?? ''
      if (type === 'start') {
        const numbers = text
          .split(/[\s,]+/)
          .map((s) => toInt(s))
          .filter((n): n is number => n !== undefined && n > 0)
        out.endingStart = { numbers, text: text.replace(/\s+/g, ' ').trim() }
      } else if (type === 'stop' || type === 'discontinue') {
        out.endingStop = true
      }
    }
    if (child(c, 'fermata')) out.fermata = location === 'left' ? 'left' : 'right'
    for (const kind of ['segno', 'coda'] as const) {
      const token = attr(c, kind)
      if (child(c, kind) || token !== undefined) {
        this.pushNav(kind, location === 'left' ? ZERO : this.cursor, { token, endOfBar: location === 'right' })
      }
    }
  }
}

/** Navigation attributes of a `<sound>` element: kind → token ("yes" for dacapo/fine). */
function soundNav(s: XmlElement): [NavKind, string | undefined][] {
  const out: [NavKind, string | undefined][] = []
  for (const kind of SOUND_NAV) {
    const v = attr(s, kind)?.trim()
    if (v === undefined || v === 'no') continue
    out.push([kind, kind === 'dacapo' || kind === 'fine' || v === '' ? undefined : v])
  }
  return out
}

/** Read a `<part>` element (see module doc). */
export function readPart(
  part: XmlElement,
  partId: string,
  diag: DiagnosticSink,
  options: ReadPartOptions = {},
): PartData {
  return new PartReader(partId, diag, options).read(part)
}
