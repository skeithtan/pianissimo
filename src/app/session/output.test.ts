import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { humanGuardEnabled } from './output'
import { testSettings } from './testkit'

describe('humanGuardEnabled', () => {
  const withEcho = (echo: 'untested' | 'none' | 'echo-detected') =>
    testSettings({ route: { ...DEFAULT_SETTINGS.route, outputId: 'out-1', outputVerified: true, echo } })

  it('is on only on a route verified echo-free', () => {
    expect(humanGuardEnabled(withEcho('none'))).toBe(true)
  })

  it('is off on an untested route: echoed app notes would look held and never be released', () => {
    expect(humanGuardEnabled(withEcho('untested'))).toBe(false)
  })

  it('is off on an echoing route', () => {
    expect(humanGuardEnabled(withEcho('echo-detected'))).toBe(false)
  })
})
