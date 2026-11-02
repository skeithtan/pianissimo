// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISABLED_RULE, TREBLE_PRESET } from '../../core/model/settings'
import { onBeforeApplyLabels, settings, updateSettings } from '../../app/state'
import { $, $$, byLabel, click, type, type Mounted } from '../shared/testing'
import { currentLabels, isLabelDraftDirty } from './labelDraft'
import { PICKER_OCTAVE_MAX, PICKER_OCTAVE_MIN, pickSpelling } from './PitchInput'
import { openOverlay, openTab, radio, resetSettingsTestState, toggle } from './testkit'

let view: Mounted | null = null
beforeEach(() => {
  resetSettingsTestState()
})
afterEach(() => {
  view?.unmount()
  view = null
})

/** Open Settings on the Score labels tab. */
function openLabels(): HTMLElement {
  const opened = openOverlay()
  view = opened.view
  return openTab(opened.root, 'Score labels')
}

const pitch = (panel: HTMLElement, name: string) => $(panel, `input[aria-label="${name}"]`) as HTMLInputElement
const trebleBelow = (panel: HTMLElement) => pitch(panel, 'Treble (G) show below pitch')
const trebleAbove = (panel: HTMLElement) => pitch(panel, 'Treble (G) show above pitch')
const bassBelow = (panel: HTMLElement) => pitch(panel, 'Bass (F) show below pitch')
const bassAbove = (panel: HTMLElement) => pitch(panel, 'Bass (F) show above pitch')
const apply = (panel: HTMLElement) => byLabel(panel, 'Apply label changes') as HTMLButtonElement
const summary = (panel: HTMLElement, clef: string) => $(panel, `[data-testid="summary-${clef}"]`)?.textContent ?? ''
const sampleLabels = (panel: HTMLElement, clef: string) =>
  $$(panel, `[aria-label="Sample notes for ${clef}"] li`).map((li) => ({
    text: li.textContent
      ?.replace(/[●○]/gu, '')
      .replace(/\s*(not )?labeled\s*$/u, '')
      .trim(),
    labeled: li.getAttribute('data-labeled') === 'true',
  }))
const labeledTexts = (panel: HTMLElement, clef: string) =>
  sampleLabels(panel, clef)
    .filter((s) => s.labeled)
    .map((s) => s.text)

describe('mode', () => {
  it('starts Off with no rule editors, per the spec default', () => {
    const panel = openLabels()
    expect(radio(panel, 'Persistent labels', 'Off').getAttribute('aria-checked')).toBe('true')
    expect($$(panel, '[role="group"][aria-label$="label rule"]')).toHaveLength(0)
    expect(apply(panel).disabled).toBe(true)
  })

  it('stages a mode change and applies only on Apply, calling the hook first', () => {
    const calls: string[] = []
    onBeforeApplyLabels((next) => calls.push(`hook ${settings.peek().labels.mode} -> ${next.mode}`))
    const panel = openLabels()
    click(radio(panel, 'Persistent labels', 'All notes'))
    expect(settings.value.labels.mode).toBe('off') // staged, not applied
    expect(calls).toEqual([])
    expect(apply(panel).disabled).toBe(false)
    expect(panel.textContent).toContain('not applied yet')
    click(apply(panel))
    expect(calls).toEqual(['hook off -> all'])
    expect(settings.value.labels.mode).toBe('all')
    expect(panel.textContent).toContain('Label settings applied')
    expect(apply(panel).disabled).toBe(true)
  })

  it('discarding returns to the applied settings without calling the hook', () => {
    const hook = vi.fn()
    onBeforeApplyLabels(hook)
    const panel = openLabels()
    click(radio(panel, 'Persistent labels', 'All notes'))
    click(byLabel(panel, 'Discard changes'))
    expect(radio(panel, 'Persistent labels', 'Off').getAttribute('aria-checked')).toBe('true')
    expect(isLabelDraftDirty()).toBe(false)
    expect(hook).not.toHaveBeenCalled()
    expect(settings.value.labels.mode).toBe('off')
  })

  it('switching back to the applied mode clears the staged state', () => {
    const panel = openLabels()
    click(radio(panel, 'Persistent labels', 'All notes'))
    click(radio(panel, 'Persistent labels', 'Off'))
    expect(isLabelDraftDirty()).toBe(false)
    expect(apply(panel).disabled).toBe(true)
  })
})

describe('conditional rules', () => {
  function openConditional(): HTMLElement {
    const panel = openLabels()
    click(radio(panel, 'Persistent labels', 'Conditional'))
    return panel
  }

  it('shows treble and bass editors, with the treble preset and bass unset', () => {
    const panel = openConditional()
    expect(trebleBelow(panel).value).toBe('C4')
    expect(trebleAbove(panel).value).toBe('C5')
    expect(toggle(panel, 'Show below').checked).toBe(true)
    expect(bassBelow(panel).value).toBe('')
    expect(bassAbove(panel).value).toBe('')
    expect(panel.textContent).toContain('Bass thresholds stay unset')
    expect(summary(panel, 'G2')).toMatch(/^Treble clef: label notes below C4 or above C5\./u)
    expect(summary(panel, 'F4')).toMatch(/both conditions are off/u)
  })

  it('uses strict wording: below C4 means lower than C4', () => {
    const panel = openConditional()
    expect(panel.textContent).toContain('Notes lower than C4 are labeled. C4 itself is not.')
    expect(panel.textContent).toContain('Notes higher than C5 are labeled. C5 itself is not.')
  })

  it('shows a live sample matching the spec example: B3 and C♯5 labeled, C4 E4 C5 not', () => {
    const panel = openConditional()
    const labeled = labeledTexts(panel, 'Treble (G)')
    expect(labeled).toContain('B3')
    expect(labeled).toContain('C♯5')
    expect(labeled).not.toContain('C4')
    expect(labeled).not.toContain('E4')
    expect(labeled).not.toContain('C5')
    const sample = sampleLabels(panel, 'Treble (G)')
    expect(sample.find((s) => s.text === 'C4')?.labeled).toBe(false)
    expect(sample.find((s) => s.text === 'C5')?.labeled).toBe(false)
  })

  it('updates the summary and sample live while editing, before applying', () => {
    const panel = openConditional()
    type(trebleBelow(panel), 'A3')
    expect(summary(panel, 'G2')).toMatch(/below A3 or above C5/u)
    const labeled = labeledTexts(panel, 'Treble (G)')
    expect(labeled).toContain('G3')
    expect(labeled).not.toContain('B3')
    expect(settings.value.labels.rules['G2']).toBe(TREBLE_PRESET) // nothing applied yet
  })

  it('accepts accidentals typed with # and b, and fixed-do names', () => {
    const panel = openConditional()
    type(trebleBelow(panel), 'Bb3')
    expect(summary(panel, 'G2')).toMatch(/below B♭3/u)
    type(trebleAbove(panel), 'do#5')
    expect(summary(panel, 'G2')).toMatch(/above C♯5/u)
  })

  it('offers a button picker (no keyboard needed): note, ♭ ♮ ♯ and octave edit the field', () => {
    const panel = openConditional()
    const pickToggle = byLabel(panel, 'Choose treble (G) show below pitch with buttons') as HTMLButtonElement
    expect(pickToggle.getAttribute('aria-expanded')).toBe('false')
    click(pickToggle)
    expect(pickToggle.getAttribute('aria-expanded')).toBe('true')
    const picker = $(panel, '[role="group"][aria-label="Treble (G) show below pitch: picker"]')!
    // Starts from the field's pitch (the preset's C4).
    expect($(picker, '[role="radiogroup"][aria-label="Note"] [aria-checked="true"]')?.textContent).toBe('C')
    click(radio(picker, 'Note', 'B'))
    click(radio(picker, 'Accidental', '♭'))
    click(byLabel(picker, 'Octave lower'))
    expect(trebleBelow(panel).value).toBe('B♭3')
    expect(summary(panel, 'G2')).toMatch(/below B♭3/u)
    click(radio(picker, 'Accidental', '♯'))
    click(byLabel(picker, 'Octave higher'))
    expect(trebleBelow(panel).value).toBe('B♯4')
    // Typed text still works and the picker follows it.
    type(trebleBelow(panel), 'F#3')
    expect($(picker, '[role="radiogroup"][aria-label="Note"] [aria-checked="true"]')?.textContent).toBe('F')
    expect($(picker, '[role="radiogroup"][aria-label="Accidental"] [aria-checked="true"]')?.textContent).toBe('♯')
    click(pickToggle)
    expect($(panel, '[aria-label="Treble (G) show below pitch: picker"]')).toBeNull()
  })

  it('the picker starts from middle C when the field is empty or invalid, and closes when the condition is off', () => {
    const panel = openConditional()
    type(trebleBelow(panel), 'zz')
    click(byLabel(panel, 'Choose treble (G) show below pitch with buttons'))
    const picker = $(panel, '[aria-label="Treble (G) show below pitch: picker"]')!
    click(radio(picker, 'Accidental', '♯'))
    expect(trebleBelow(panel).value).toBe('C♯4')
    expect($(panel, '[role="alert"]')).toBeNull()
    click(toggle(panel, 'Show below'))
    expect($(panel, '[aria-label="Treble (G) show below pitch: picker"]')).toBeNull()
  })

  it('rejects an invalid pitch, shows why and blocks Apply', () => {
    const panel = openConditional()
    type(trebleBelow(panel), 'Q9')
    expect($(panel, '[role="alert"]')?.textContent).toMatch(/not a note name/u)
    expect(trebleBelow(panel).getAttribute('aria-invalid')).toBe('true')
    expect(apply(panel).disabled).toBe(true)
    expect(panel.textContent).toContain('Fix the highlighted problems')
    type(trebleBelow(panel), 'C')
    expect($(panel, '[role="alert"]')?.textContent).toMatch(/Add the octave/u)
    expect(apply(panel).disabled).toBe(true)
    type(trebleBelow(panel), 'C4')
    expect($(panel, '[role="alert"]')).toBeNull()
    expect(apply(panel).disabled).toBe(false) // valid again; the staged mode change can be applied
  })

  it('rejects a lower boundary above the upper boundary', () => {
    const panel = openConditional()
    type(trebleBelow(panel), 'E5')
    const alert = $$(panel, '[role="alert"]')
      .map((a) => a.textContent)
      .join(' ')
    expect(alert).toMatch(/Show below E5 is higher than Show above C5/u)
    expect(summary(panel, 'G2')).toMatch(/overlap/u)
    expect(apply(panel).disabled).toBe(true)
    type(trebleBelow(panel), 'B3')
    expect($(panel, '[role="alert"]')).toBeNull()
    expect(apply(panel).disabled).toBe(false)
  })

  it('allows a reversed pair when one condition is off', () => {
    const panel = openConditional()
    type(trebleBelow(panel), 'E5')
    click(toggle(panel, 'Show above'))
    expect($(panel, '[role="alert"]')).toBeNull()
    expect(summary(panel, 'G2')).toMatch(/label notes below E5\./u)
    expect(apply(panel).disabled).toBe(false)
  })

  it('rejects an enabled condition with no pitch', () => {
    const panel = openConditional()
    type(trebleAbove(panel), '')
    expect($(panel, '[role="alert"]')?.textContent).toMatch(/Show above is on but has no pitch/u)
    expect(apply(panel).disabled).toBe(true)
  })

  it('does not block on a disabled condition with bad text', () => {
    const panel = openConditional()
    type(trebleAbove(panel), 'zzz')
    expect(apply(panel).disabled).toBe(true)
    click(toggle(panel, 'Show above'))
    expect(apply(panel).disabled).toBe(false) // above is off, below is unchanged but the draft differs
  })

  it('applies edited rules through the hook, keeping other clefs independent', () => {
    const order: string[] = []
    onBeforeApplyLabels(() => order.push('hook'))
    const panel = openConditional()
    type(bassBelow(panel), 'E2')
    const toggles = $$(panel, 'input[role="switch"]')
    // Bass "Show below" is the third switch (treble below, treble above, bass below, bass above).
    click(toggles[2]!)
    expect(apply(panel).disabled).toBe(false)
    click(apply(panel))
    expect(order).toEqual(['hook'])
    expect(settings.value.labels.mode).toBe('conditional')
    expect(settings.value.labels.rules['F4']?.below).toEqual({
      enabled: true,
      threshold: { step: 'E', alter: 0, octave: 2 },
    })
    expect(settings.value.labels.rules['F4']?.above).toEqual(DISABLED_RULE.above)
    expect(settings.value.labels.rules['G2']).toEqual(TREBLE_PRESET) // treble untouched
  })

  it('never copies treble thresholds into the bass rule', () => {
    const panel = openConditional()
    const toggles = $$(panel, 'input[role="switch"]')
    click(toggles[2]!) // bass below on, no pitch yet
    expect(bassBelow(panel).value).toBe('')
    expect(
      $$(panel, '[role="alert"]')
        .map((a) => a.textContent)
        .join(),
    ).toMatch(/Show below is on but has no pitch/u)
  })

  it('offers the treble preset and restores it', () => {
    const panel = openConditional()
    expect(byLabel(panel, 'Use preset: below C4 or above C5')).toBeNull() // already the preset
    type(trebleBelow(panel), 'A3')
    type(trebleAbove(panel), 'G5')
    click(byLabel(panel, 'Use preset: below C4 or above C5'))
    expect(trebleBelow(panel).value).toBe('C4')
    expect(trebleAbove(panel).value).toBe('C5')
    expect(currentLabels().rules['G2']).toEqual(TREBLE_PRESET)
  })

  it('lists any other clef present in settings, starting disabled', () => {
    updateSettings({ labels: { rules: { C3: DISABLED_RULE } } })
    const panel = openConditional()
    expect(pitch(panel, 'Alto (C3) show below pitch')).not.toBeNull()
    expect(summary(panel, 'C3')).toMatch(/both conditions are off/u)
  })

  it('keeps typed text and staged edits when switching tabs', () => {
    const opened = openOverlay()
    view = opened.view
    const panel = openTab(opened.root, 'Score labels')
    click(radio(panel, 'Persistent labels', 'Conditional'))
    type(trebleBelow(panel), 'A3')
    openTab(opened.root, 'Hints')
    const back = openTab(opened.root, 'Score labels')
    expect(trebleBelow(back).value).toBe('A3')
    expect(isLabelDraftDirty()).toBe(true)
  })

  it('only validates rules in Conditional mode, and ignores text of a disabled condition', () => {
    const panel = openConditional()
    type(bassAbove(panel), 'xx')
    click(radio(panel, 'Persistent labels', 'All notes'))
    expect(apply(panel).disabled).toBe(false) // rules do not matter outside Conditional
    click(radio(panel, 'Persistent labels', 'Conditional'))
    expect(apply(panel).disabled).toBe(false) // the bass condition is off, so its text is ignored
  })
})

describe('pickSpelling (threshold pitch picker)', () => {
  it('changes one part of the pitch, starting from middle C when there is none', () => {
    expect(pickSpelling(null, { step: 'A' })).toEqual({ step: 'A', alter: 0, octave: 4 })
    expect(pickSpelling({ step: 'E', alter: 0, octave: 3 }, { alter: -1 })).toEqual({ step: 'E', alter: -1, octave: 3 })
    expect(pickSpelling({ step: 'E', alter: -2, octave: 3 }, { octaveBy: 1 })).toEqual({
      step: 'E',
      alter: -2,
      octave: 4,
    })
  })

  it('keeps the octave inside the piano range', () => {
    expect(pickSpelling({ step: 'C', alter: 0, octave: PICKER_OCTAVE_MAX }, { octaveBy: 1 }).octave).toBe(
      PICKER_OCTAVE_MAX,
    )
    expect(pickSpelling({ step: 'A', alter: 0, octave: PICKER_OCTAVE_MIN }, { octaveBy: -1 }).octave).toBe(
      PICKER_OCTAVE_MIN,
    )
  })
})
