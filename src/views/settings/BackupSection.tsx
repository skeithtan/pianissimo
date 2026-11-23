import { msg } from '../../i18n/messages'
/**
 * Backup (spec "Storage and recovery": export and restore so browser storage is not the only
 * copy, and to move between computer and iPad), plus the storage status line. Kept in Settings
 * rather than the Library: it is rarely needed. The restore confirmation and its report show in
 * place, not in a second sheet over Settings. The Library refreshes its list when Settings close.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { pushNotice } from '../../app/state'
import { BackupError } from '../../core/storage/errors'
import { Button, Notice, Toggle } from '../../ui/controls'
import { useLibraryDeps } from '../library/deps'
import { BACKUP_ACCEPT, FileButton } from '../library/FileButton'
import { formatBytes } from '../library/format'
import { StorageStatusLine } from '../library/ImportSheet'
import { describeRestore, LibraryModel, type RestoreOutcome } from '../library/libraryModel'
import { Group, Help } from './parts'
import styles from './settings.module.css'

export function BackupSection() {
  const deps = useLibraryDeps()
  const model = useMemo(() => new LibraryModel(deps), [deps])
  const [exporting, setExporting] = useState(false)
  const [includeRecordings, setIncludeRecordings] = useState(true)
  const [pending, setPending] = useState<File | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null)

  useEffect(() => {
    void model.refresh()
    void model.refreshStorageStatus()
    void model.refreshRecordings()
  }, [model])

  const disabled = model.state.value.status === 'unavailable'
  const recordings = model.recordings.value

  const runExport = async () => {
    setExporting(true)
    try {
      const name = await model.exportBackup({ includeRecordings })
      pushNotice({ kind: 'success', text: msg('Backup saved as {0}.', name) })
    } catch (e) {
      pushNotice({
        kind: 'error',
        // A refused backup (too large to restore) explains itself and what to do.
        text:
          e instanceof BackupError
            ? e.message
            : msg('The backup could not be created: {0}', e instanceof Error ? e.message : String(e)),
      })
    } finally {
      setExporting(false)
    }
  }

  const runRestore = async () => {
    if (!pending) return
    setRestoring(true)
    const result = await model.restore(pending)
    setRestoring(false)
    setOutcome(result)
  }

  const finish = () => {
    if (restoring) return
    setPending(null)
    setOutcome(null)
  }

  return (
    <>
      <Group title={msg('Export')}>
        <Help>
          {msg(
            'Your scores, results and settings live only in this browser. Export a backup to keep a copy or to move your library between your computer and your iPad.',
          )}
        </Help>
        {recordings && recordings.count > 0 ? (
          <Toggle
            label={msg('Include recordings')}
            checked={includeRecordings}
            disabled={disabled || exporting}
            onChange={setIncludeRecordings}
            description={
              recordings.count === 1
                ? msg('1 recording on this device ({0}).', formatBytes(recordings.bytes))
                : msg('{0} recordings on this device ({1}).', recordings.count, formatBytes(recordings.bytes))
            }
          />
        ) : null}
        <div class={styles.backupActions}>
          <Button icon="download" disabled={disabled || exporting} onClick={() => void runExport()}>
            {exporting ? msg('Preparing backup…') : msg('Export backup')}
          </Button>
        </div>
        <StorageStatusLine status={model.storageStatus.value} />
      </Group>

      <Group title={msg('Restore')}>
        {pending === null ? (
          <>
            <Help>
              {msg(
                "Pieces, results and practice history from the backup are added to this device. Nothing here is deleted, and where both have the same piece the more recent one is kept. Settings are replaced by the backup's, except this device's piano connection and metronome output.",
              )}
            </Help>
            <div class={styles.backupActions}>
              <FileButton
                icon="upload"
                accept={deps.isAppleMobile() ? undefined : BACKUP_ACCEPT}
                disabled={disabled}
                onFile={(file) => {
                  setOutcome(null)
                  setPending(file)
                }}
              >
                {msg('Restore from backup…')}
              </FileButton>
            </div>
          </>
        ) : (
          <div class={styles.restore} data-testid="restore">
            <p class={styles.fileName}>{pending.name}</p>
            {outcome === null ? (
              <>
                <Help>{msg('Restore this backup? Nothing on this device is deleted.')}</Help>
                <div class={styles.backupActions}>
                  <Button onClick={finish} disabled={restoring}>
                    {msg('Cancel')}
                  </Button>
                  <Button variant="primary" icon="upload" disabled={restoring} onClick={() => void runRestore()}>
                    {restoring ? msg('Restoring…') : msg('Restore')}
                  </Button>
                </div>
              </>
            ) : outcome.ok ? (
              <>
                <Notice tone="success">
                  <strong>{msg('Backup restored.')}</strong>
                  <ul class={styles.reportList}>
                    {describeRestore(outcome.report).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Notice>
                {outcome.report.warnings.length ? (
                  <Notice tone="warning">
                    <ul class={styles.reportList}>
                      {outcome.report.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : null}
                <div class={styles.backupActions}>
                  <Button variant="primary" onClick={finish}>
                    {msg('Done')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Notice tone="danger">
                  <strong>{msg('This backup could not be restored. Nothing was changed.')}</strong> {outcome.message}
                  {outcome.problems.length ? (
                    <ul class={styles.reportList}>
                      {outcome.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  ) : null}
                </Notice>
                <div class={styles.backupActions}>
                  <Button onClick={finish}>{msg('Close')}</Button>
                </div>
              </>
            )}
          </div>
        )}
      </Group>
    </>
  )
}
