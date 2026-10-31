/**
 * Renderer-only fixture builder: writes a small two-staff MusicXML score together with the
 * `RenderInput` the importer would produce for it (one part, no repeats, so occurrence =
 * measure). Used by renderer tests while they must not depend on the importer.
 *
 * Voice syntax (durations in divisions, 4 per quarter):
 *   `C5:4`  note · `F#4:2` / `Bb3:8` accidentals · `r:4` rest · `[C4 E4 G4]:4` chord ·
 *   `C5:4~` tie to the next note of the voice · `C4@1:4` drawn on staff index 1 (cross-staff).
 * Pitches are *written*; inside an ottava span the sounding pitch (MusicXML `<pitch>`, M1) is
 * shifted by the span.
 */
import { add, rat, type Rational } from '../../../src/core/music/rational';
import { spellingToMidi, type Step } from '../../../src/core/music/pitch';
import type { Hand } from '../../../src/core/model/score';
import type { MappingNote, RenderInput } from '../../../src/render/types';

export const DIVISIONS = 4;

export interface FxVoice {
  readonly voice: string;
  /** Home staff index (0 = treble/right hand, 1 = bass/left hand). */
  readonly staff: number;
  readonly music: string;
}

export interface FxClef {
  readonly staff: number;
  readonly sign: 'G' | 'F' | 'C';
  readonly line: number;
}

export interface FxMeasure {
  readonly number?: string;
  readonly time?: readonly [number, number];
  readonly key?: number;
  readonly clefs?: readonly FxClef[];
  readonly voices: readonly FxVoice[];
}

export interface FxOttava {
  readonly staff: number;
  readonly size: 8 | 15;
  readonly sounds: 'up' | 'down';
  /** [measure, offset in divisions], half-open. */
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
}

export interface FxScore {
  readonly id: string;
  readonly measures: readonly FxMeasure[];
  readonly ottavas?: readonly FxOttava[];
}

interface Ev {
  readonly rest: boolean;
  readonly pitches: readonly { step: Step; alter: number; octave: number }[];
  readonly dur: number;
  readonly tie: boolean;
  readonly staff?: number;
}

const TOKEN = /^(\[[^\]]+\]|r|[A-G][#b]*-?\d+)(?:@(\d))?:(\d+)(~?)$/;

function parsePitch(s: string): { step: Step; alter: number; octave: number } {
  const m = /^([A-G])([#b]*)(-?\d+)$/.exec(s);
  if (!m) throw new Error(`Bad pitch ${s}`);
  const acc = m[2]!;
  const alter = [...acc].reduce((n, c) => n + (c === '#' ? 1 : -1), 0);
  return { step: m[1] as Step, alter, octave: Number(m[3]) };
}

export function parseVoice(music: string): Ev[] {
  const tokens = music.match(/\[[^\]]+\][^\s]*|[^\s]+/g) ?? [];
  return tokens.map((t) => {
    const m = TOKEN.exec(t);
    if (!m) throw new Error(`Bad token ${t}`);
    const head = m[1]!;
    const dur = Number(m[3]);
    const tie = m[4] === '~';
    const staff = m[2] === undefined ? undefined : Number(m[2]);
    if (head === 'r') return { rest: true, pitches: [], dur, tie: false };
    const pitches = head.startsWith('[') ? head.slice(1, -1).trim().split(/\s+/).map(parsePitch) : [parsePitch(head)];
    return staff === undefined ? { rest: false, pitches, dur, tie } : { rest: false, pitches, dur, tie, staff };
  });
}

export interface BuiltFixture {
  readonly xml: string;
  readonly input: RenderInput;
}

/** Builds the MusicXML and the matching `RenderInput`. */
export function buildFixture(score: FxScore): BuiltFixture {
  const notes: (Omit<MappingNote, 'index'> & { onset: number })[] = [];
  const occurrences: RenderInput['occurrences'][number][] = [];
  const clefs: RenderInput['clefs'][number][] = [];
  const keys: RenderInput['keys'][number][] = [];
  const meters: RenderInput['meters'][number][] = [];
  const ottavas = score.ottavas ?? [];
  let time: readonly [number, number] = [4, 4];
  let start = 0;
  const xmlMeasures: string[] = [];
  const openTies = new Map<string, Set<number>>();

  const shiftAt = (staff: number, m: number, off: number): number => {
    for (const o of ottavas) {
      if (o.staff !== staff) continue;
      const after = m > o.from[0] || (m === o.from[0] && off >= o.from[1]);
      const before = m < o.to[0] || (m === o.to[0] && off < o.to[1]);
      if (after && before) return (o.size === 8 ? 1 : 2) * (o.sounds === 'up' ? 1 : -1);
    }
    return 0;
  };

  score.measures.forEach((meas, mi) => {
    if (meas.time) time = meas.time;
    const length = (time[0] * 4 * DIVISIONS) / time[1];
    const at = rat(start, 4 * DIVISIONS);
    const parts: string[] = [];
    const attrs: string[] = [];
    if (mi === 0) attrs.push(`<divisions>${DIVISIONS}</divisions>`);
    if (meas.key !== undefined || mi === 0) {
      const fifths = meas.key ?? 0;
      attrs.push(`<key><fifths>${fifths}</fifths></key>`);
      keys.push({ at, occ: mi, fifths });
    }
    if (meas.time || mi === 0) {
      attrs.push(`<time><beats>${time[0]}</beats><beat-type>${time[1]}</beat-type></time>`);
      meters.push({ at, occ: mi, beats: time[0], beatType: time[1], beatsText: String(time[0]) });
    }
    if (mi === 0) attrs.push('<staves>2</staves>');
    const clefList = meas.clefs ?? (mi === 0 ? [{ staff: 0, sign: 'G', line: 2 }, { staff: 1, sign: 'F', line: 4 }] : []);
    for (const c of clefList) {
      attrs.push(`<clef number="${c.staff + 1}"><sign>${c.sign}</sign><line>${c.line}</line></clef>`);
      clefs.push({ at, occ: mi, staff: c.staff, clef: { sign: c.sign, line: c.line, octaveChange: 0 }, key: `${c.sign}${c.line}` });
    }
    if (attrs.length) parts.push(`<attributes>${attrs.join('')}</attributes>`);

    for (const o of ottavas) {
      for (const [edge, type] of [
        [o.from, o.sounds === 'up' ? 'down' : 'up'],
        [o.to, 'stop'],
      ] as const) {
        if (edge[0] !== mi) continue;
        const off = edge[1];
        if (off > 0) parts.push(`<forward><duration>${off}</duration></forward>`);
        parts.push(
          `<direction placement="${o.sounds === 'up' ? 'above' : 'below'}"><direction-type>` +
            `<octave-shift type="${type}" size="${o.size}" number="1"/></direction-type><staff>${o.staff + 1}</staff></direction>`,
        );
        if (off > 0) parts.push(`<backup><duration>${off}</duration></backup>`);
      }
    }

    meas.voices.forEach((v, vi) => {
      if (vi > 0) parts.push(`<backup><duration>${length}</duration></backup>`);
      let off = 0;
      const evs = parseVoice(v.music);
      const tieKey = `${v.staff}:${v.voice}`;
      const prevTie = openTies.get(tieKey) ?? new Set<number>();
      openTies.set(tieKey, prevTie);
      for (const ev of evs) {
        const drawStaff = ev.staff ?? v.staff;
        const type = noteType(ev.dur);
        ev.pitches.forEach((p, pi) => {
          const shift = shiftAt(drawStaff, mi, off);
          const sounding = { ...p, octave: p.octave + shift };
          const midi = spellingToMidi(sounding);
          const tieStop = prevTie.has(spellingToMidi(p));
          const tieXml = `${tieStop ? '<tie type="stop"/>' : ''}${ev.tie ? '<tie type="start"/>' : ''}`;
          const tiedXml = `${tieStop ? '<tied type="stop"/>' : ''}${ev.tie ? '<tied type="start"/>' : ''}`;
          parts.push(
            `<note>${pi > 0 ? '<chord/>' : ''}<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}` +
              `<octave>${sounding.octave}</octave></pitch><duration>${ev.dur}</duration>${tieXml}<voice>${v.voice}</voice>` +
              `<type>${type.type}</type>${type.dot ? '<dot/>' : ''}${accidentalXml(p.alter)}<staff>${drawStaff + 1}</staff>` +
              `${tiedXml ? `<notations>${tiedXml}</notations>` : ''}</note>`,
          );
          notes.push({
            occ: mi,
            staff: drawStaff,
            voice: v.voice,
            onsetInMeasure: rat(off, 4 * DIVISIONS),
            midi,
            grace: false,
            hand: (v.staff === 0 ? 'R' : 'L') as Hand,
            onset: start + off,
          });
        });
        prevTie.clear();
        if (ev.tie) for (const p of ev.pitches) prevTie.add(spellingToMidi(p));
        if (ev.rest) {
          parts.push(`<note><rest/><duration>${ev.dur}</duration><voice>${v.voice}</voice><type>${noteType(ev.dur).type}</type><staff>${v.staff + 1}</staff></note>`);
        }
        off += ev.dur;
      }
      if (off !== length) throw new Error(`Measure ${mi + 1} voice ${v.voice} fills ${off}/${length}`);
    });

    const number = meas.number ?? String(mi + 1);
    xmlMeasures.push(`<measure number="${number}">${parts.join('')}</measure>`);
    occurrences.push({ index: mi, number, pass: 1, start: at, duration: rat(length, 4 * DIVISIONS) });
    start += length;
  });

  const sorted = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.onset - b.n.onset || a.n.staff - b.n.staff || a.n.midi - b.n.midi || a.i - b.i)
    .map(({ n }, index): MappingNote => ({
      index,
      occ: n.occ,
      staff: n.staff,
      voice: n.voice,
      onsetInMeasure: n.onsetInMeasure,
      midi: n.midi,
      grace: n.grace,
      hand: n.hand,
    }));

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>' +
    `<part id="P1">${xmlMeasures.join('')}</part></score-partwise>`;
  return {
    xml,
    input: {
      renderXml: xml,
      scoreVersionId: `fixture-${score.id}`,
      notes: sorted,
      occurrences,
      staves: [{ index: 0 }, { index: 1 }],
      ottavas: ottavas.map((o, index) => {
        const posOf = ([m, off]: readonly [number, number]): Rational =>
          add(occurrences[m]?.start ?? rat(start, 4 * DIVISIONS), rat(off, 4 * DIVISIONS));
        return {
          index,
          staff: o.staff,
          size: o.size,
          sounds: o.sounds,
          start: posOf(o.from),
          end: posOf(o.to),
          startOcc: o.from[0],
          endOcc: o.to[0],
        };
      }),
      clefs,
      keys,
      meters,
    },
  };
}

function noteType(dur: number): { type: string; dot: boolean } {
  const table: Record<number, [string, boolean]> = {
    1: ['16th', false],
    2: ['eighth', false],
    3: ['eighth', true],
    4: ['quarter', false],
    6: ['quarter', true],
    8: ['half', false],
    12: ['half', true],
    16: ['whole', false],
  };
  const t = table[dur];
  if (!t) throw new Error(`No note type for ${dur} divisions`);
  return { type: t[0], dot: t[1] };
}

function accidentalXml(alter: number): string {
  if (alter === 1) return '<accidental>sharp</accidental>';
  if (alter === -1) return '<accidental>flat</accidental>';
  return '';
}
