import { msg } from '../../i18n/messages'
/** Data: backup and restore, the list of every recording, and About. */
import type { FeatureReport } from '../../app/features'
import { Button } from '../../ui/controls'
import { useLibraryDeps } from '../library/deps'
import { useRecordingDialog } from '../recordings/useRecordingDialog'
import { AboutSection } from './AboutSection'
import { BackupSection } from './BackupSection'
import { Group, Section } from './parts'

export function DataPanel({ features }: { features: FeatureReport }) {
  const deps = useLibraryDeps()
  const recordings = useRecordingDialog()
  return (
    <>
      <Section
        title={msg('Backup and restore')}
        intro={msg('Keep a copy of your library, or move it to another device.')}
      >
        <BackupSection recordingsOpen={recordings.isOpen} />
      </Section>
      <Section title={msg('Recordings')}>
        <Group>
          <div>
            <Button onClick={() => void recordings.open(deps.getStorage)}>{msg('All recordings')}</Button>
          </div>
        </Group>
      </Section>
      <Section title={msg('About')} intro={msg('Version, credits and what this browser supports.')}>
        <AboutSection features={features} />
      </Section>
      {recordings.dialog}
    </>
  )
}
