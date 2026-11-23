import { msg } from '../../i18n/messages'
/**
 * The Settings overlay (spec "Main user journey": Settings open without losing the selected score
 * or passage). A full-height sheet over the current view, which stays mounted underneath.
 * Escape and the close button dismiss it; focus moves in and returns to the opener.
 *
 * Four tabs, each a column of sections (U143). Every panel stays mounted (hidden when inactive) so
 * typed text and staged label edits survive switching tabs; only the piano setup, a lazy chunk with
 * a live MIDI monitor, is mounted with its tab. Label edits are staged and applied explicitly;
 * closing with unapplied label edits discards them and says so.
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { closeSettings, noteRulesRequested, settingsOpen, settingsTab, type SettingsTab } from '../../app/navigation'
import { getFeatures, type FeatureReport } from '../../app/features'
import { LazyView } from '../../app/LazyView'
import { flushSettings, pushNotice } from '../../app/state'
import { Sheet } from '../../ui/controls'
import { AppSection } from './AppSection'
import { DataPanel } from './DataPanel'
import { HintsSection } from './HintsSection'
import { discardLabelDraft, isLabelDraftDirty, labelDraft } from './labelDraft'
import { LabelsSection, NOTE_RULES_ID } from './LabelsSection'
import { NamingSection } from './NamingSection'
import { Section } from './parts'
import { MetronomeSection, MicrophoneSection, RecordingSection, SoundSection } from './SoundSection'
import styles from './settings.module.css'

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'reading', label: 'Reading help' },
  { id: 'piano', label: 'Piano and sound' },
  { id: 'app', label: 'App' },
  { id: 'data', label: 'Data' },
]

/** Space above the Note names rules when Settings opens at them. */
const RULES_MARGIN_PX = 16

function ReadingPanel() {
  return (
    <>
      <Section title={msg('Note names')} intro={msg('Names written beside the notes throughout the score.')}>
        <LabelsSection />
      </Section>
      <Section
        title={msg('Naming style')}
        intro={msg('How notes are named on the score, in hints and on the keyboard guide.')}
      >
        <NamingSection />
      </Section>
      <Section title={msg('Hints')} intro={msg('When note names appear after mistakes, and how long they stay.')}>
        <HintsSection />
      </Section>
    </>
  )
}

function PianoPanel({ shown, features }: { shown: boolean; features: FeatureReport }) {
  return (
    <>
      <Section title={msg('Piano')}>
        <div class={styles.pianoSetup}>{shown ? <LazyView name="connection" /> : null}</div>
      </Section>
      <Section title={msg('Sound')} intro={msg('Where playback comes from, and how loud.')}>
        <SoundSection features={features} />
      </Section>
      <Section title={msg('Metronome')}>
        <MetronomeSection features={features} />
      </Section>
      <Section title={msg('Performance recording')}>
        <RecordingSection />
      </Section>
      <Section title={msg('Microphone')}>
        <MicrophoneSection />
      </Section>
    </>
  )
}

function Panel({ features }: { features: FeatureReport }) {
  const active = settingsTab.value
  const content = useRef<HTMLDivElement>(null)
  // Reading the draft here subscribes the panel, so the Reading help tab marks unapplied edits.
  const labelsDirty = labelDraft.value !== null && isLabelDraftDirty()

  // The panels share one scroll area: each tab starts at its top.
  useEffect(() => content.current?.scrollTo({ top: 0, behavior: 'instant' }), [active])

  // The score's menu asked for the Note names rules: after the sheet has opened and focused its tab.
  const rules = noteRulesRequested.value
  useEffect(() => {
    if (!rules) return
    const frame = requestAnimationFrame(() => {
      noteRulesRequested.value = false
      const area = content.current
      const group = document.getElementById(NOTE_RULES_ID)
      if (!area || !group) return
      group.focus({ preventScroll: true })
      // Only the scroll area: scrollIntoView would also move the sheet itself.
      const top = group.getBoundingClientRect().top - area.getBoundingClientRect().top - RULES_MARGIN_PX
      area.scrollTo({ top: area.scrollTop + top, behavior: 'instant' })
    })
    return () => cancelAnimationFrame(frame)
  }, [rules])

  const move = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + step + TABS.length) % TABS.length
    const tab = TABS[next]
    if (!tab) return
    settingsTab.value = tab.id
    ;(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  const body: Readonly<Record<SettingsTab, ComponentChildren>> = {
    reading: <ReadingPanel />,
    piano: <PianoPanel shown={active === 'piano'} features={features} />,
    app: (
      <div class={styles.part}>
        <AppSection />
      </div>
    ),
    data: <DataPanel features={features} />,
  }

  return (
    <div class={styles.panel}>
      <div class={styles.tabs} role="tablist" aria-label={msg('Settings sections')}>
        {TABS.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-selected={tab.id === active}
            aria-controls={`settings-panel-${tab.id}`}
            tabIndex={tab.id === active ? 0 : -1}
            autoFocus={tab.id === active}
            class={styles.tab}
            onClick={() => (settingsTab.value = tab.id)}
            onKeyDown={(e) => move(e, i)}
          >
            <span>{msg(tab.label)}</span>
            {tab.id === 'reading' && labelsDirty ? (
              <>
                <span class={styles.pending} aria-hidden="true" />
                <span class="visually-hidden"> {msg('(changes not applied)')}</span>
              </>
            ) : null}
          </button>
        ))}
      </div>
      <div class={styles.content} ref={content}>
        {TABS.map((tab) => (
          <section
            key={tab.id}
            role="tabpanel"
            id={`settings-panel-${tab.id}`}
            aria-labelledby={`settings-tab-${tab.id}`}
            hidden={tab.id !== active}
            class={styles.section}
          >
            {body[tab.id]}
          </section>
        ))}
      </div>
    </div>
  )
}

/** Drop staged label edits, telling the learner when there were any. */
function dropStagedLabelEdits(): void {
  if (isLabelDraftDirty()) {
    pushNotice({ kind: 'info', text: msg('Note name changes were not applied, so they were discarded.') })
  }
  discardLabelDraft()
}

/** Close the overlay, telling the learner when staged label edits were dropped. Safe to call twice. */
export function requestCloseSettings(): void {
  if (!settingsOpen.peek()) return
  dropStagedLabelEdits()
  void flushSettings()
  closeSettings()
}

export function SettingsOverlay({ features = getFeatures() }: { features?: FeatureReport }) {
  const open = settingsOpen.value
  // Settings can also close without the close button: the browser's Back button, or another
  // screen taking over. Staged label edits never outlive the overlay, and
  // debounced preferences are written however it closes.
  useEffect(() => {
    if (open) return
    dropStagedLabelEdits()
    void flushSettings()
  }, [open])
  return (
    <Sheet title={msg('Settings')} open={open} onClose={requestCloseSettings} className={styles.dialog} tall flush>
      <Panel features={features} />
    </Sheet>
  )
}
