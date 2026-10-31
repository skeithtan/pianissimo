/** Compact app bar for the non-practice views: app name, MIDI status chip and Settings. */
import { Button } from '../ui/controls'
import { Icon } from '../ui/icons'
import { ConnectionChip } from '../views/shared/ConnectionChip'
import { navigate, openSettings } from './navigation'
import styles from './AppBar.module.css'

export function AppBar() {
  return (
    <header class={styles.bar}>
      <button
        type="button"
        class={styles.brand}
        onClick={() => navigate('library')}
        aria-label="Pianissimo, go to the library"
      >
        <Icon name="music" size={24} />
        <span class={styles.brandText}>Pianissimo</span>
      </button>
      <div class={styles.actions}>
        <ConnectionChip />
        <Button icon="settings" variant="ghost" onClick={openSettings} aria-label="Settings">
          <span class={styles.settingsText}>Settings</span>
        </Button>
      </div>
    </header>
  )
}
