/** About: version, what Pianissimo reads, where data lives, credits and this browser's capabilities. */
import { APP_VERSION } from '../../app/version'
import type { FeatureReport } from '../../app/features'
import { Icon } from '../../ui/icons'
import { Group, Help } from './parts'
import styles from './settings.module.css'

export const SALAMANDER_LICENSE_URL = 'https://creativecommons.org/licenses/by/3.0/'

export function AboutSection({ features }: { features: FeatureReport }) {
  return (
    <>
      <Group>
        <p class={styles.aboutTitle}>
          Pianissimo <span class={styles.version}>version {APP_VERSION}</span>
        </p>
        <Help>
          Learn to read piano notation by playing a connected MIDI piano. MusicXML is the only score format it imports
          (.musicxml, .mxl, or an .xml file that contains a MusicXML score).
        </Help>
        <Help>
          Everything stays on this device: your scores, settings and practice history are stored in this browser and
          never uploaded. Use Backup in Settings to keep a copy or move them between devices.
        </Help>
      </Group>

      <Group title="Credits">
        <p class={styles.credit}>
          Browser piano sound: Salamander Grand Piano V3 by Alexander Holm, licensed{' '}
          <a href={SALAMANDER_LICENSE_URL} target="_blank" rel="noopener noreferrer">
            CC-BY 3.0
          </a>
          .
        </p>
      </Group>

      <Group title="This browser">
        <ul class={styles.features}>
          {Object.values(features.features).map((f) => (
            <li key={f.id} class={styles.feature} data-supported={f.supported}>
              <Icon name={f.supported ? 'check' : 'alert'} size={20} />
              <div>
                <strong>{f.label}</strong>
                <span class="visually-hidden">{f.supported ? ' available' : ' unavailable'}</span>
                {f.explanation ? <p class={styles.featureNote}>{f.explanation}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </Group>
    </>
  )
}
