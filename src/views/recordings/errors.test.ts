import { afterEach, expect, it } from 'vitest'
import en from '../../i18n/locales/en-US.json'
import es from '../../i18n/locales/es-ES.json'
import { readMessagesWith } from '../../i18n/messages'
import { RecordingError } from '../../app/audio/performanceInput'
import { recorderErrorText } from './errors'

afterEach(() => readMessagesWith(() => ({ language: 'en-US', strings: {} })))

const browser = (name: string, message = 'Permission denied by system') => Object.assign(new Error(message), { name })

it('maps browser audio errors to messages for the player, never the raw browser text', () => {
  expect(recorderErrorText(browser('NotAllowedError'), 'open')).toMatch(/^Pianissimo is not allowed to use audio input/)
  expect(recorderErrorText(browser('NotFoundError'), 'open')).toMatch(/^No audio input was found/)
  expect(recorderErrorText(browser('OverconstrainedError'), 'open')).toMatch(/^The selected audio input/)
  expect(recorderErrorText(browser('NotReadableError'), 'open')).toMatch(/^The audio input could not be started/)
  expect(recorderErrorText(browser('AbortError'), 'open')).toBe('The audio input could not be opened. Try again.')
  expect(recorderErrorText(new TypeError('Failed to execute addModule'), 'start')).toBe(
    'The recording could not start. Try again.',
  )
  expect(recorderErrorText('weird', 'open')).not.toContain('weird')
  for (const name of ['NotAllowedError', 'NotFoundError', 'SecurityError']) {
    expect(recorderErrorText(browser(name), 'open')).not.toContain('Permission denied by system')
  }
})

it('shows our own messages as they are', () => {
  expect(recorderErrorText(new RecordingError('Audio input was interrupted.'), 'start')).toBe(
    'Audio input was interrupted.',
  )
})

it('speaks the interface language', () => {
  const strings = Object.fromEntries(Object.entries(es).map(([id, value]) => [en[id as keyof typeof en], value]))
  readMessagesWith(() => ({ language: 'es-ES', strings }))
  expect(recorderErrorText(browser('NotAllowedError'), 'open')).toMatch(/^Pianissimo no tiene permiso/)
})
