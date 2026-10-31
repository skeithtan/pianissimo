/** Small renderer fixtures (see builder.ts for the voice syntax). */
import { buildFixture, type BuiltFixture, type FxScore } from './builder';

/** Two staves, chords, a tie across the barline, unequal hand rhythms. */
export const basic: FxScore = {
  id: 'basic',
  measures: [
    {
      voices: [
        { voice: '1', staff: 0, music: 'C5:4 D5:4 E5:4 [C5 E5 G5]:4' },
        { voice: '5', staff: 1, music: 'C3:8 G2:8' },
      ],
    },
    {
      voices: [
        { voice: '1', staff: 0, music: 'F5:2 E5:2 D5:2 C5:2 B4:4 C5:4~' },
        { voice: '5', staff: 1, music: '[F2 C3 A3]:16' },
      ],
    },
    {
      voices: [
        { voice: '1', staff: 0, music: 'C5:8 r:4 G4:4' },
        { voice: '5', staff: 1, music: 'E3:4 G3:4 C3:8' },
      ],
    },
  ],
};

/** 8va on the upper staff (written C5 → C6 sounding), 8vb on the lower staff, then 15ma. */
export const ottava: FxScore = {
  id: 'ottava',
  measures: [
    { voices: [{ voice: '1', staff: 0, music: 'C5:4 D5:4 E5:4 F5:4' }, { voice: '5', staff: 1, music: 'C3:16' }] },
    { voices: [{ voice: '1', staff: 0, music: 'G5:4 A5:4 B5:4 C6:4' }, { voice: '5', staff: 1, music: 'C3:4 E3:4 G3:4 C3:4' }] },
    { voices: [{ voice: '1', staff: 0, music: 'C5:4 E5:4 G5:8' }, { voice: '5', staff: 1, music: 'C2:8 G2:8' }] },
    { voices: [{ voice: '1', staff: 0, music: 'C5:16' }, { voice: '5', staff: 1, music: 'C3:16' }] },
  ],
  ottavas: [
    { staff: 0, size: 8, sounds: 'up', from: [1, 0], to: [2, 0] },
    { staff: 1, size: 8, sounds: 'down', from: [2, 0], to: [3, 0] },
    { staff: 0, size: 15, sounds: 'up', from: [3, 0], to: [4, 0] },
  ],
};

/** Two voices on the upper staff with a shared unison, a cross-staff note, dense chords. */
export const voices: FxScore = {
  id: 'voices',
  measures: [
    {
      voices: [
        { voice: '1', staff: 0, music: 'E5:4 G5:4 A5:4 G5:4' },
        { voice: '2', staff: 0, music: 'C5:4 G5:4 E5:8' },
        { voice: '5', staff: 1, music: 'C3:4 G3:4 C4@0:4 G3:4' },
      ],
    },
    {
      voices: [
        { voice: '1', staff: 0, music: '[C#5 E5 G#5 B5]:4 [Db5 F5 Ab5 C6]:4 [B4 D5 F5 A5]:8' },
        { voice: '5', staff: 1, music: '[C2 G2 E3]:8 [F2 C3 A3]:8' },
      ],
    },
  ],
};

/** Clef change on the lower staff, key change, meter change, fast run with ledger lines. */
export const changes: FxScore = {
  id: 'changes',
  measures: [
    { voices: [{ voice: '1', staff: 0, music: 'C5:1 D5:1 E5:1 F5:1 G5:1 A5:1 B5:1 C6:1 D6:1 E6:1 F6:1 G6:1 A6:1 G6:1 F6:1 E6:1' }, { voice: '5', staff: 1, music: 'C3:16' }] },
    {
      clefs: [{ staff: 1, sign: 'G', line: 2 }],
      voices: [{ voice: '1', staff: 0, music: 'C6:8 G5:8' }, { voice: '5', staff: 1, music: 'C4:4 E4:4 G4:4 C5:4' }],
    },
    {
      key: 2,
      time: [3, 4],
      clefs: [{ staff: 1, sign: 'F', line: 4 }],
      voices: [{ voice: '1', staff: 0, music: 'D5:4 F#5:4 A5:4' }, { voice: '5', staff: 1, music: 'D3:12' }],
    },
    { voices: [{ voice: '1', staff: 0, music: 'A3:2 B3:2 C#4:2 D4:2 E4:2 F#4:2' }, { voice: '5', staff: 1, music: 'D2:12' }] },
  ],
};

export const FIXTURES = { basic, ottava, voices, changes } as const;
export type FixtureName = keyof typeof FIXTURES;

export function fixture(name: FixtureName): BuiltFixture {
  return buildFixture(FIXTURES[name]);
}
