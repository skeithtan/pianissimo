import { describe, expect, it } from 'vitest'
import { NO_RECORDING_INPUT, hasRememberedInput, isRememberedInput, rememberInput } from './input'

const USB = { deviceId: 'usb', label: 'Fake Piano' }

describe('the remembered recording input', () => {
  it('is nothing until one is chosen', () => {
    expect(hasRememberedInput(NO_RECORDING_INPUT)).toBe(false)
    expect(isRememberedInput(NO_RECORDING_INPUT, USB)).toBe(false)
    expect(isRememberedInput(NO_RECORDING_INPUT, { deviceId: '', label: '' })).toBe(false)
  })

  it('keeps the ID and the name', () => {
    expect(rememberInput(USB)).toEqual({ inputId: 'usb', inputLabel: 'Fake Piano' })
    expect(rememberInput({ deviceId: 'usb', label: '' })).toEqual({ inputId: 'usb', inputLabel: null })
    expect(rememberInput({ deviceId: '', label: ' Fake Piano ' })).toEqual({ inputId: null, inputLabel: 'Fake Piano' })
  })

  it('remembers nothing that could not recognize the input again', () => {
    expect(rememberInput({ deviceId: '', label: ' ' })).toEqual(NO_RECORDING_INPUT)
    expect(rememberInput({ deviceId: 'default', label: '' })).toEqual(NO_RECORDING_INPUT)
  })

  it('recognizes it by its ID, whatever the browser calls it now', () => {
    const saved = rememberInput(USB)
    expect(isRememberedInput(saved, USB)).toBe(true)
    expect(isRememberedInput(saved, { deviceId: 'usb', label: 'Fake Piano (2)' })).toBe(true)
  })

  it('recognizes it by its name when the browser has given out new IDs', () => {
    const saved = rememberInput(USB)
    expect(isRememberedInput(saved, { deviceId: 'new-id', label: 'Fake Piano ' })).toBe(true)
    expect(isRememberedInput(saved, { deviceId: 'new-id', label: 'Tablet microphone' })).toBe(false)
    expect(isRememberedInput({ inputId: 'usb', inputLabel: null }, { deviceId: 'new-id', label: '' })).toBe(false)
  })

  it('never takes the system’s current choice for the remembered device by its ID alone', () => {
    const saved = rememberInput({ deviceId: 'default', label: 'Default - Fake Piano' })
    expect(isRememberedInput(saved, { deviceId: 'default', label: 'Default - Fake Piano' })).toBe(true)
    expect(isRememberedInput(saved, { deviceId: 'default', label: 'Default - Webcam' })).toBe(false)
  })
})
