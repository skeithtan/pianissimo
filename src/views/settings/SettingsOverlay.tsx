/**
 * The Settings overlay (spec "Main user journey": Settings open without losing the selected score
 * or passage). A full-height sheet over the current view, which stays mounted underneath.
 * Escape and the close button dismiss it; focus moves in and returns to the opener.
 *
 * Sections are tabs. Every panel stays mounted (hidden when inactive) so typed text and staged
 * label edits survive switching tabs. Label edits are staged and applied explicitly; closing
 * with unapplied label edits discards them and says so.
 */
import { useEffect, useState } from 'preact/hooks'
import { closeSettings, settingsOpen } from '../../app/navigation'
import { getFeatures, type FeatureReport } from '../../app/features'
import { pushNotice } from '../../app/state'
import { Sheet } from '../../ui/controls'
import { AboutSection } from './AboutSection'
import { BackupSection } from './BackupSection'
import { GeneralSection } from './GeneralSection'
import { HintsSection } from './HintsSection'
import { discardLabelDraft, isLabelDraftDirty, labelDraft } from './labelDraft'
import { LabelsSection } from './LabelsSection'
import { NamingSection } from './NamingSection'
import { PedalSection } from './PedalSection'
import { SoundSection } from './SoundSection'
import styles from './settings.module.css'

type TabId = 'names' | 'labels' | 'hints' | 'pedal' | 'sound' | 'general' | 'backup' | 'about'

const TABS: readonly { id: TabId; label: string; intro: string }[] = [
  { id: 'names', label: 'Note names', intro: 'How notes are named in hints, labels and the keyboard guide.' },
  { id: 'labels', label: 'Score labels', intro: 'Names written beside the notes throughout the score.' },
  { id: 'hints', label: 'Hints', intro: 'When note names appear after mistakes, and how long they stay.' },
  { id: 'pedal', label: 'Pedal', intro: 'The pedal that reveals hints.' },
  { id: 'sound', label: 'Sound', intro: 'Where playback comes from, and how loud.' },
  { id: 'general', label: 'General', intro: 'Suggestions and appearance.' },
  { id: 'backup', label: 'Backup', intro: 'Keep a copy of your library, or move it to another device.' },
  { id: 'about', label: 'About', intro: 'Version, credits and what this browser supports.' },
]

function Panel({ features }: { features: FeatureReport }) {
  const [active, setActive] = useState<TabId>('names')
  // Reading the draft here subscribes the panel, so the Score labels tab marks unapplied edits.
  const labelsDirty = labelDraft.value !== null && isLabelDraftDirty()

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
    setActive(tab.id)
    ;(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  const body = (id: TabId) => {
    switch (id) {
      case 'names':
        return <NamingSection />
      case 'labels':
        return <LabelsSection />
      case 'hints':
        return <HintsSection />
      case 'pedal':
        return <PedalSection />
      case 'sound':
        return <SoundSection features={features} />
      case 'general':
        return <GeneralSection />
      case 'backup':
        return <BackupSection />
      case 'about':
        return <AboutSection features={features} />
    }
  }

  return (
    <div class={styles.panel}>
      <div class={styles.tabs} role="tablist" aria-label="Settings sections">
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
            onClick={() => setActive(tab.id)}
            onKeyDown={(e) => move(e, i)}
          >
            <span>{tab.label}</span>
            {tab.id === 'labels' && labelsDirty ? (
              <>
                <span class={styles.pending} aria-hidden="true" />
                <span class="visually-hidden"> (changes not applied)</span>
              </>
            ) : null}
          </button>
        ))}
      </div>
      <div class={styles.content}>
        {TABS.map((tab) => (
          <section
            key={tab.id}
            role="tabpanel"
            id={`settings-panel-${tab.id}`}
            aria-labelledby={`settings-tab-${tab.id}`}
            hidden={tab.id !== active}
            class={styles.section}
          >
            <header class={styles.sectionHead}>
              <h3>{tab.label}</h3>
              <p>{tab.intro}</p>
            </header>
            {body(tab.id)}
          </section>
        ))}
      </div>
    </div>
  )
}

/** Drop staged label edits, telling the learner when there were any. */
function dropStagedLabelEdits(): void {
  if (isLabelDraftDirty()) {
    pushNotice({ kind: 'info', text: 'Label changes were not applied, so they were discarded.' })
  }
  discardLabelDraft()
}

/** Close the overlay, telling the learner when staged label edits were dropped. Safe to call twice. */
export function requestCloseSettings(): void {
  if (!settingsOpen.peek()) return
  dropStagedLabelEdits()
  closeSettings()
}

export function SettingsOverlay({ features = getFeatures() }: { features?: FeatureReport }) {
  const open = settingsOpen.value
  // Settings can also close without the close button: the browser's Back button, or another
  // screen taking over (Set up in Connection). Staged label edits never outlive the overlay.
  useEffect(() => {
    if (!open) dropStagedLabelEdits()
  }, [open])
  return (
    <Sheet title="Settings" open={open} onClose={requestCloseSettings} wide tall flush>
      <Panel features={features} />
    </Sheet>
  )
}
