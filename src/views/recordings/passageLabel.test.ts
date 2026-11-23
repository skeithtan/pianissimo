import { afterEach, expect, it } from 'vitest'
import en from '../../i18n/locales/en-US.json'
import es from '../../i18n/locales/es-ES.json'
import { readMessagesWith } from '../../i18n/messages'
import type { RecordingInfo } from '../../core/recording/records'
import { makePackage } from '../../core/storage/testkit'
import { passageFields, takePassageLabel, takeScoreVersion } from './passageLabel'

afterEach(() => readMessagesWith(() => ({ language: 'en-US', strings: {} })))

const spanish = () => {
  const strings = Object.fromEntries(Object.entries(es).map(([id, value]) => [en[id as keyof typeof en], value]))
  readMessagesWith(() => ({ language: 'es-ES', strings }))
}
const english = () => readMessagesWith(() => ({ language: 'en-US', strings: {} }))
const model = makePackage('v7').model

function take(fields: Pick<RecordingInfo, 'passage' | 'passageRange'>): RecordingInfo {
  return {
    id: 't',
    pieceId: 'p',
    title: 'Etude',
    context: JSON.stringify(['p', 'v7', 'h', 'both', '1-2']),
    hands: 'both',
    createdAt: 1,
    durationMs: 1,
    input: 'Piano',
    score: { expected: 1, played: 1, matched: 1 },
    interrupted: false,
    ...fields,
  }
}

it('a take recorded in Spanish shows its passage in English after switching to English', () => {
  spanish()
  const info = take(passageFields(model, { fromOcc: 1, toOcc: 2 }, 'both'))
  expect(info.passage).toBe('Compases 2–3')
  expect(takePassageLabel(info, model)).toBe('Compases 2–3')
  english()
  expect(takePassageLabel(info, model)).toBe('Bars 2–3')
  expect(takeScoreVersion(info)).toBe('v7')
})

it('the whole piece needs no score to be named', () => {
  spanish()
  const info = take(passageFields(model, null, 'both'))
  english()
  expect(takePassageLabel(info, undefined)).toBe('Whole piece')
})

it('a take saved before ranges were stored keeps showing its stored text', () => {
  english()
  const old = take({ passage: 'Compases 2–3' })
  expect(takePassageLabel(old, model)).toBe('Compases 2–3')
  // Without its score (the piece was deleted) a new take falls back to its stored text too.
  expect(takePassageLabel(take({ passage: 'Compases 2–3', passageRange: { fromOcc: 1, toOcc: 2 } }), undefined)).toBe(
    'Compases 2–3',
  )
})
