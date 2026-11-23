// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import type { PianissimoStorage } from '../../core/storage'
import { $, $$, mount, type Mounted } from '../shared/testing'
import { useRecordingDialog } from './useRecordingDialog'

vi.mock('./History', () => ({ RecordingHistory: () => <div data-testid="history" /> }))

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

const storage = () => Promise.resolve({} as PianissimoStorage)

it('the header holds nothing of the recorder until it is opened, and never a Record button', async () => {
  let recorder!: ReturnType<typeof useRecordingDialog>
  function Header() {
    recorder = useRecordingDialog()
    return (
      <>
        <header>{recorder.controls(() => {})}</header>
        {recorder.dialog}
      </>
    )
  }
  view = mount(<Header />)
  const header = $(view.container, 'header')!
  expect(header.children).toHaveLength(0)

  await act(async () => {
    await recorder.open(storage)
  })
  // Open: the slot that receives a take's status and Stop, with nothing to focus by itself.
  const control = $(header, '[data-recording-control]')
  expect(control).not.toBeNull()
  expect($$(header, 'button')).toHaveLength(0)
  expect($(view.container, '[data-testid="history"]')).not.toBeNull()
})

it('a portrait phone keeps the take in its footer, not the header', async () => {
  let recorder!: ReturnType<typeof useRecordingDialog>
  function Phone() {
    recorder = useRecordingDialog()
    return (
      <>
        <header>{recorder.controls(() => {}, false)}</header>
        {recorder.phoneFooter}
      </>
    )
  }
  view = mount(<Phone />)
  expect($(view.container, 'footer')).toBeNull()
  await act(async () => {
    await recorder.open(storage)
  })
  expect($(view.container, 'header')!.children).toHaveLength(0)
  expect($(view.container, 'footer')).not.toBeNull()
})
