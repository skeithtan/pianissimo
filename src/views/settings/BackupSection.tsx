/**
 * Backup (spec "Storage and recovery": export and restore so browser storage is not the only
 * copy, and to move between computer and iPad), plus the storage status line. Kept in Settings
 * rather than the Library: it is rarely needed. The restore confirmation and its report show in
 * place, not in a second sheet over Settings. The Library refreshes its list when Settings close.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { pushNotice } from '../../app/state'
import { Button, Notice } from '../../ui/controls'
import { useLibraryDeps } from '../library/deps'
import { BACKUP_ACCEPT, FileButton } from '../library/FileButton'
import { StorageStatusLine } from '../library/ImportSheet'
import { describeRestore, LibraryModel, type RestoreOutcome } from '../library/libraryModel'
import { Group, Help } from './parts'
import styles from './settings.module.css'

export function BackupSection() {
  const deps = useLibraryDeps()
  const model = useMemo(() => new LibraryModel(deps), [deps])
  const [exporting, setExporting] = useState(false)
  const [pending, setPending] = useState<File | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null)

  useEffect(() => {
    void model.refresh()
    void model.refreshStorageStatus()
  }, [model])

  const disabled = model.state.value.status === 'unavailable'

  const runExport = async () => {
    setExporting(true)
    try {
      const name = await model.exportBackup()
      pushNotice({ kind: 'success', text: `Backup saved as ${name}.` })
    } catch (e) {
      pushNotice({
        kind: 'error',
        text: `The backup could not be created: ${e instanceof Error ? e.message : String(e)}`,
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
      <Group title="Export">
        <Help>
          Your scores, results and settings live only in this browser. Export a backup to keep a copy or to move your
          library between your computer and your iPad.
        </Help>
        <div class={styles.backupActions}>
          <Button icon="download" disabled={disabled || exporting} onClick={() => void runExport()}>
            {exporting ? 'Preparing backup…' : 'Export backup'}
          </Button>
        </div>
        <StorageStatusLine status={model.storageStatus.value} />
      </Group>

      <Group title="Restore">
        {pending === null ? (
          <>
            <Help>
              Pieces, results and practice history from the backup are added to this device; nothing here is deleted,
              and where both have the same piece the more recent one is kept. Settings are replaced by the backup's,
              except this device's piano connection.
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
                Restore from backup…
              </FileButton>
            </div>
          </>
        ) : (
          <div class={styles.restore} data-testid="restore">
            <p class={styles.fileName}>{pending.name}</p>
            {outcome === null ? (
              <>
                <Help>Restore this backup? Nothing on this device is deleted.</Help>
                <div class={styles.backupActions}>
                  <Button onClick={finish} disabled={restoring}>
                    Cancel
                  </Button>
                  <Button variant="primary" icon="upload" disabled={restoring} onClick={() => void runRestore()}>
                    {restoring ? 'Restoring…' : 'Restore'}
                  </Button>
                </div>
              </>
            ) : outcome.ok ? (
              <>
                <Notice tone="success">
                  <strong>Backup restored.</strong>
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
                    Done
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Notice tone="danger">
                  <strong>This backup could not be restored. Nothing was changed.</strong> {outcome.message}
                  {outcome.problems.length ? (
                    <ul class={styles.reportList}>
                      {outcome.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  ) : null}
                </Notice>
                <div class={styles.backupActions}>
                  <Button onClick={finish}>Close</Button>
                </div>
              </>
            )}
          </div>
        )}
      </Group>
    </>
  )
}
