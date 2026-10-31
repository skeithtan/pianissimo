/**
 * Deterministic long MusicXML score for renderer, performance and e2e tests (spec "Performance
 * targets": "a 500-measure score works with all-note labels enabled").
 *
 * Two staves (one part), 4/4 at quarter = 96, cycling four right-hand patterns — quarters with an
 * accidental, eighths, a triplet with a quarter and a half, and a tied half-note chord that ties
 * across the barline into the next bar — over left-hand half-note chords and quarter notes.
 * Every 16 bars an 8va bracket covers two bars; every 50 bars the lower staff switches to treble
 * clef for four bars; at the middle the key changes to D major and the tempo to quarter = 80.
 * Dynamics alternate p / f every 32 bars and the sustain pedal is pressed for every 4-bar group.
 * Pure string building (no Node APIs), so browser harnesses can import it too.
 */

type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

interface NoteSpec {
  readonly step: Step;
  readonly octave: number;
  readonly alter?: number;
  readonly duration: number;
  readonly type: string;
  readonly dot?: boolean;
  readonly voice: number;
  readonly staff: number;
  readonly chord?: boolean;
  readonly tie?: 'start' | 'stop';
  readonly triplet?: 'start' | 'mid' | 'stop';
  readonly accidental?: string;
}

/** Divisions per quarter: 12 makes eighths (6), triplet eighths (4) and sixteenths (3) exact. */
const DIV = 12;

function note(n: NoteSpec): string {
  const parts: string[] = ['<note>'];
  if (n.chord) parts.push('<chord/>');
  parts.push(`<pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ''}<octave>${n.octave}</octave></pitch>`);
  parts.push(`<duration>${n.duration}</duration>`);
  if (n.tie) parts.push(`<tie type="${n.tie}"/>`);
  parts.push(`<voice>${n.voice}</voice><type>${n.type}</type>`);
  if (n.dot) parts.push('<dot/>');
  if (n.accidental) parts.push(`<accidental>${n.accidental}</accidental>`);
  if (n.triplet) parts.push('<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>');
  parts.push(`<staff>${n.staff}</staff>`);
  const notations: string[] = [];
  if (n.tie) notations.push(`<tied type="${n.tie}"/>`);
  if (n.triplet === 'start') notations.push('<tuplet type="start" bracket="yes"/>');
  if (n.triplet === 'stop') notations.push('<tuplet type="stop"/>');
  if (notations.length > 0) parts.push(`<notations>${notations.join('')}</notations>`);
  parts.push('</note>');
  return parts.join('');
}

function direction(content: string, staff: number, sound = '', placement: 'above' | 'below' = 'above'): string {
  return `<direction placement="${placement}"><direction-type>${content}</direction-type><staff>${staff}</staff>${sound}</direction>`;
}

/** Right-hand bar (voice 1, staff 1). `up` = sounding octave offset under an 8va. */
function rightHand(i: number, up: number, inD: boolean, last: boolean): string[] {
  const o = 5 + up;
  const v = { voice: 1, staff: 1 };
  switch (i % 4) {
    case 0: {
      const tieStop = i > 0;
      return [
        note({ step: 'C', octave: o, duration: DIV, type: 'quarter', ...v, ...(tieStop ? { tie: 'stop' as const } : {}) }),
        note({ step: 'D', octave: o, duration: DIV, type: 'quarter', ...v }),
        note({ step: 'E', octave: o, duration: DIV, type: 'quarter', ...v }),
        note({ step: 'F', octave: o, alter: 1, duration: DIV, type: 'quarter', ...v, ...(inD ? {} : { accidental: 'sharp' }) }),
      ];
    }
    case 1: {
      const steps: Step[] = ['G', 'A', 'B', 'C', 'D', 'C', 'B', 'A'];
      return steps.map((step, k) => note({ step, octave: k >= 3 && k <= 5 ? o + 1 : o, duration: DIV / 2, type: 'eighth', ...v }));
    }
    case 2:
      return [
        note({ step: 'G', octave: o, duration: DIV / 3, type: 'eighth', triplet: 'start', ...v }),
        note({ step: 'A', octave: o, duration: DIV / 3, type: 'eighth', triplet: 'mid', ...v }),
        note({ step: 'B', octave: o, alter: -1, duration: DIV / 3, type: 'eighth', triplet: 'stop', accidental: 'flat', ...v }),
        note({ step: 'A', octave: o, duration: DIV, type: 'quarter', ...v }),
        note({ step: 'G', octave: o, duration: 2 * DIV, type: 'half', ...v }),
      ];
    default:
      return [
        note({ step: 'E', octave: o - 1, duration: 2 * DIV, type: 'half', ...v }),
        note({ step: 'G', octave: o - 1, duration: 2 * DIV, type: 'half', chord: true, ...v }),
        note({ step: 'C', octave: o, duration: 2 * DIV, type: 'half', chord: true, ...v }),
        note({ step: 'C', octave: o, duration: 2 * DIV, type: 'half', ...(last ? {} : { tie: 'start' as const }), ...v }),
      ];
  }
}

/** Left-hand bar (voice 5, staff 2); `treble` raises it an octave for the treble-clef bars. */
function leftHand(i: number, treble: boolean): string[] {
  const o = treble ? 4 : 3;
  const v = { voice: 5, staff: 2 };
  if (i % 2 === 0) {
    return [
      note({ step: 'C', octave: o, duration: 2 * DIV, type: 'half', ...v }),
      note({ step: 'G', octave: o, duration: 2 * DIV, type: 'half', chord: true, ...v }),
      note({ step: 'F', octave: o - 1, duration: 2 * DIV, type: 'half', ...v }),
      note({ step: 'C', octave: o, duration: 2 * DIV, type: 'half', chord: true, ...v }),
    ];
  }
  return [
    note({ step: 'A', octave: o - 1, duration: DIV, type: 'quarter', ...v }),
    note({ step: 'E', octave: o, duration: DIV, type: 'quarter', ...v }),
    note({ step: 'G', octave: o - 1, duration: DIV / 2, type: 'eighth', ...v }),
    note({ step: 'B', octave: o - 1, duration: DIV / 2, type: 'eighth', ...v }),
    note({ step: 'D', octave: o, duration: DIV, type: 'quarter', ...v }),
  ];
}

/** MusicXML (score-partwise 4.0) for a long two-staff piano piece; see the module doc. */
export function generateLongScore(measures = 500): string {
  if (!Number.isInteger(measures) || measures < 1) throw new RangeError(`Invalid measure count ${measures}`);
  const middle = Math.floor(measures / 2);
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    `<work><work-title>Long Score (${measures} bars)</work-title></work>`,
    '<identification><creator type="composer">Pianissimo generator</creator></identification>',
    '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>',
    '<part id="P1">',
  ];
  for (let i = 0; i < measures; i++) {
    const inD = i >= middle;
    const inOttava = i % 16 === 9 || i % 16 === 10;
    const treble = i % 50 >= 20 && i % 50 < 24;
    const body: string[] = [`<measure number="${i + 1}">`];
    const attrs: string[] = [];
    if (i === 0) {
      attrs.push(`<divisions>${DIV}</divisions>`, '<key><fifths>0</fifths><mode>major</mode></key>', '<time><beats>4</beats><beat-type>4</beat-type></time>', '<staves>2</staves>');
      attrs.push('<clef number="1"><sign>G</sign><line>2</line></clef>', '<clef number="2"><sign>F</sign><line>4</line></clef>');
    }
    if (i === middle && i > 0) attrs.push('<key><fifths>2</fifths><mode>major</mode></key>');
    if (i % 50 === 20) attrs.push('<clef number="2"><sign>G</sign><line>2</line></clef>');
    if (i % 50 === 24) attrs.push('<clef number="2"><sign>F</sign><line>4</line></clef>');
    if (attrs.length > 0) body.push(`<attributes>${attrs.join('')}</attributes>`);
    if (i === 0) body.push(direction('<metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome>', 1, '<sound tempo="96"/>'));
    if (i === middle && i > 0) body.push(direction('<metronome><beat-unit>quarter</beat-unit><per-minute>80</per-minute></metronome>', 1, '<sound tempo="80"/>'));
    if (i % 32 === 0) {
      const loud = (i / 32) % 2 === 1;
      body.push(direction(`<dynamics><${loud ? 'f' : 'p'}/></dynamics>`, 1, `<sound dynamics="${loud ? 106.67 : 54.44}"/>`, 'below'));
    }
    if (i % 16 === 9) body.push(direction('<octave-shift type="down" size="8" number="1"/>', 1));
    if (i % 16 === 11) body.push(direction('<octave-shift type="stop" size="8" number="1"/>', 1));
    if (i % 4 === 0) body.push(direction('<pedal type="start" line="yes"/>', 2, '', 'below'));
    body.push(...rightHand(i, inOttava ? 1 : 0, inD, i === measures - 1));
    body.push(`<backup><duration>${4 * DIV}</duration></backup>`);
    body.push(...leftHand(i, treble));
    if (i % 4 === 3 || i === measures - 1) body.push(direction('<pedal type="stop" line="yes"/>', 2, '', 'below'));
    if (i === measures - 1 && inOttava) body.push(direction('<octave-shift type="stop" size="8" number="1"/>', 1));
    if (i === measures - 1) body.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
    body.push('</measure>');
    out.push(body.join(''));
  }
  out.push('</part>', '</score-partwise>', '');
  return out.join('\n');
}
