import { msg, messageLanguage } from '../../i18n/messages'
/**
 * What this browser cannot do, first thing in the Library's own column (DECISIONS U159). Without Web
 * MIDI: where a piano can be connected instead. Optional features are listed in Settings > About only.
 */
import { signal } from '@preact/signals'
import { getFeatures, type FeatureId, type FeatureStatus } from '../../app/features'
import { isSafari, pianoBrowsers } from '../../app/pianoBrowsers'
import { Fade } from '../../ui/fade'
import { Icon } from '../../ui/icons'
import { PianoBrowserLinks } from '../shared/PianoBrowserLinks'
import styles from './BrowserNotices.module.css'

/** Closed for this visit only; the limitation is still there on the next launch. */
const closed = signal<ReadonlySet<FeatureId>>(new Set())

export function resetBrowserNoticesForTests(): void {
  closed.value = new Set()
}

export function BrowserNotices() {
  return (
    <>
      {getFeatures()
        .missing.filter((f) => f.severity !== 'optional')
        .map((f) => (
          <Fade key={f.id} show={!closed.value.has(f.id)} ms={250}>
            <BrowserNotice feature={f} />
          </Fade>
        ))}
    </>
  )
}

function BrowserNotice({ feature }: { feature: FeatureStatus }) {
  const piano = feature.id === 'webMidi'
  const heading = `browser-notice-${feature.id}`
  return (
    <section class={styles.notice} data-quiet={!piano || undefined} data-testid={heading} aria-labelledby={heading}>
      {piano ? <Keys /> : null}
      <div class={styles.text}>
        <h2 id={heading}>{piano ? pianoHeading() : feature.label}</h2>
        <p>{piano ? pianoText() : feature.explanation}</p>
      </div>
      {piano ? (
        <div class={styles.actions}>
          <PianoBrowserLinks />
        </div>
      ) : null}
      <button
        type="button"
        class={styles.close}
        aria-label={msg('Dismiss')}
        title={msg('Dismiss')}
        onClick={() => (closed.value = new Set([...closed.value, feature.id]))}
      >
        <Icon name="close" size={20} />
      </button>
    </section>
  )
}

function pianoHeading(): string {
  const names = pianoBrowsers().browsers.map((b) => b.name)
  const list = new Intl.ListFormat(messageLanguage(), { type: 'disjunction' }).format(names)
  return msg('To connect your piano, use {0}', list)
}

function pianoText(): string {
  const { app } = pianoBrowsers()
  if (isSafari())
    return app
      ? msg('Safari cannot connect to a digital piano. Install the free app, then open this same address in it.')
      : msg('Safari cannot connect to a digital piano. Open this same address there instead.')
  return app
    ? msg('This browser cannot connect to a digital piano. Install the free app, then open this same address in it.')
    : msg('This browser cannot connect to a digital piano. Open this same address there instead.')
}

/** An octave and a half standing on the card's lower edge. */
function Keys() {
  return (
    <svg class={styles.keys} viewBox="0 0 220 112" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <rect key={i} class={styles.white} x={i * 22 + 1} y="0" width="20" height="124" rx="6" />
      ))}
      {[0, 1, 3, 4, 5, 7, 8].map((i) => (
        <rect key={i} class={styles.black} x={i * 22 + 15} y="-8" width="14" height="76" rx="5" />
      ))}
    </svg>
  )
}
