/**
 * Library-screen notice for missing browser capabilities that matter (spec "Delivery and device
 * compatibility": Safari has no Web MIDI, so say so plainly and point to MIDIWeb or Chrome).
 * Optional features (persistent storage, wake lock) are listed in Settings > About only.
 */
import { signal } from '@preact/signals'
import { Button, Notice } from '../ui/controls'
import { Fade } from '../ui/fade'
import type { FeatureReport } from './features'
import styles from './CapabilityBanner.module.css'

/** Dismissed for this visit only; the limitation is still there on the next launch. */
const dismissed = signal(false)

export function resetCapabilityBannerForTests(): void {
  dismissed.value = false
}

export function CapabilityBanner({ report }: { report: FeatureReport }) {
  const issues = report.missing.filter((f) => f.severity !== 'optional')
  const show = issues.length > 0 && !dismissed.value
  return (
    <Fade show={show} ms={250} class={styles.wrap}>
      <Notice tone="warning">
        <div class={styles.body}>
          <ul class={styles.list}>
            {issues.map((f) => (
              <li key={f.id}>
                <strong>{f.label}.</strong> {f.explanation}
              </li>
            ))}
          </ul>
          <Button variant="ghost" onClick={() => (dismissed.value = true)}>
            Dismiss
          </Button>
        </div>
      </Notice>
    </Fade>
  )
}
