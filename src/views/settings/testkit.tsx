/** Shared helpers for the Settings component tests (happy-dom). Not imported by production code. */
import { act } from 'preact/test-utils'
import { connectionOpen, currentView, openSettings, settingsOpen } from '../../app/navigation'
import { resetAppStateForTests } from '../../app/state'
import { detectFeatures, type FeatureReport } from '../../app/features'
import { $, $$, byLabel, click, mount, type Mounted } from '../shared/testing'
import { discardLabelDraft } from './labelDraft'
import { SettingsOverlay } from './SettingsOverlay'

export const ALL_FEATURES: FeatureReport = detectFeatures({
  navigator: { requestMIDIAccess: () => undefined, wakeLock: {}, storage: { persist: () => undefined } },
  AudioContext: class {},
  Worker: class {
    constructor(_url: string, options?: { type?: string }) {
      void options?.type
    }
    terminate(): void {}
  },
  indexedDB: {},
})

export function resetSettingsTestState(): void {
  resetAppStateForTests()
  discardLabelDraft()
  settingsOpen.value = false
  connectionOpen.value = false
  currentView.value = 'library'
}

/** Mount the overlay and open it. */
export function openOverlay(features: FeatureReport = ALL_FEATURES): { view: Mounted; root: HTMLElement } {
  const view = mount(<SettingsOverlay features={features} />)
  act(() => openSettings())
  return { view, root: view.container }
}

export function tab(root: ParentNode, name: string): HTMLElement {
  const found = $$(root, '[role="tab"]').find((t) => t.textContent?.trim().startsWith(name))
  if (!found) throw new Error(`No settings tab "${name}"`)
  return found
}

export function openTab(root: ParentNode, name: string): HTMLElement {
  click(tab(root, name))
  const panel = $(root, `#${tab(root, name).getAttribute('aria-controls')}`)
  if (!panel) throw new Error(`No panel for tab "${name}"`)
  return panel
}

/** A radio option inside a labeled segmented control. */
export function radio(root: ParentNode, group: string, option: string): HTMLElement {
  const container = $$(root, '[role="radiogroup"]').find((g) => g.getAttribute('aria-label') === group)
  const found = container && $$(container, '[role="radio"]').find((r) => r.textContent?.trim() === option)
  if (!found) throw new Error(`No option "${option}" in "${group}"`)
  return found
}

/** The switch input of a toggle row, found by its label text. */
export function toggle(root: ParentNode, label: string): HTMLInputElement {
  const row = $$(root, 'label').find((l) => l.textContent?.trim().startsWith(label))
  const input = row && $(row, 'input[type="checkbox"]')
  if (!input) throw new Error(`No toggle "${label}"`)
  return input as HTMLInputElement
}

export { byLabel }
