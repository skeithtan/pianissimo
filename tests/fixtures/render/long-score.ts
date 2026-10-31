/**
 * Renderer-only long score: `measures` bars of varied two-hand piano writing (runs, chords,
 * ties across bars, ottava spans, clef and key changes) with its matching `RenderInput`, for
 * bounded-rendering and timing measurements independent of the importer.
 */
import { buildFixture, type BuiltFixture, type FxMeasure, type FxOttava } from './builder';

const RH = [
  'C5:2 D5:2 E5:2 F5:2 G5:2 A5:2 B5:2 C6:2',
  '[C5 E5 G5]:4 [D5 F5 A5]:4 [E5 G5 B5]:4 [C5 E5 G5 C6]:4',
  'E5:1 D5:1 C5:1 D5:1 E5:1 F5:1 G5:1 A5:1 G5:4 E5:4',
  'G5:6 F5:2 E5:4 D5:4',
  'C6:4 B5:2 A5:2 G5:4 F#5:4',
  'A4:2 C5:2 E5:2 A5:2 [A4 C5 E5]:8',
];
const LH = [
  'C3:4 G3:4 E3:4 G3:4',
  'C2:8 [G2 D3]:8',
  'A2:2 E3:2 A3:2 E3:2 F2:2 C3:2 F3:2 C3:2',
  '[C3 E3 G3]:16',
  'G2:4 D3:4 B3:4 D3:4',
  'F2:4 C3:4 [F2 A2 C3]:8',
];
const TIE_FROM = 'E5:4 F5:4 G5:8~';
const TIE_TO = 'G5:8 E5:4 C5:4';
const LH_TREBLE = 'C4:4 E4:4 G4:4 E4:4';

export function longScoreFixture(measures = 500): BuiltFixture {
  const bars: FxMeasure[] = [];
  const ottavas: FxOttava[] = [];
  for (let i = 0; i < measures; i++) {
    let rh = RH[i % RH.length]!;
    if (i % 10 === 4 && i + 1 < measures) rh = TIE_FROM;
    if (i % 10 === 5 && i > 0) rh = TIE_TO;
    const trebleLh = i % 50 === 20 || i % 50 === 21;
    const lh = trebleLh ? LH_TREBLE : LH[(i * 7) % LH.length]!;
    const bar: { -readonly [K in keyof FxMeasure]: FxMeasure[K] } = {
      voices: [
        { voice: '1', staff: 0, music: rh },
        { voice: '5', staff: 1, music: lh },
      ],
    };
    if (i % 50 === 20) bar.clefs = [{ staff: 1, sign: 'G', line: 2 }];
    if (i % 50 === 22) bar.clefs = [{ staff: 1, sign: 'F', line: 4 }];
    if (i > 0 && i % 100 === 0) bar.key = (i / 100) % 2 === 1 ? -2 : 0;
    bars.push(bar);
    if (i % 40 === 10 && i + 2 < measures) {
      ottavas.push({ staff: 0, size: 8, sounds: 'up', from: [i, 0], to: [i + 2, 0] });
    }
  }
  return buildFixture({ id: `long-${measures}`, measures: bars, ottavas });
}
