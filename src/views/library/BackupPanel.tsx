/**
 * Backup and restore (spec "Storage and recovery": export and restore so browser storage is not
 * the only copy, and to move between computer and iPad), plus the storage status line.
 */
import { useState } from 'preact/hooks'
import { pushNotice } from '../../app/state'
import { Button, Notice, Sheet } from '../../ui/controls'
import { BACKUP_ACCEPT, FileButton } from './FileButton'
import { StorageStatusLine } from './ImportSheet'
import { describeRestore, type LibraryModel, type RestoreOutcome } from './libraryModel'
import { useLibraryDeps } from './deps'
import styles from './library.module.css'

export function BackupPanel({ model, disabled }: { model: LibraryModel; disabled?: boolean }) {
  const deps = useLibraryDeps()
  const [exporting, setExporting] = useState(false)
  const [pending, setPending] = useState<File | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null)

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

  const closeSheet = () => {
    if (restoring) return
    setPending(null)
    setOutcome(null)
  }

  return (
    <section class={styles.backup} aria-labelledby="library-backup">
      <h2 id="library-backup">Backup and restore</h2>
      <p class={styles.muted}>
        Your scores, results and settings live only in this browser. Export a backup to keep a copy or to move your
        library between your computer and your iPad.
      </p>
      <div class={styles.backupActions}>
        <Button icon="download" disabled={disabled || exporting} onClick={() => void runExport()}>
          {exporting ? 'Preparing backup…' : 'Export backup'}
        </Button>
        <FileButton
          icon="upload"
          accept={deps.isAppleMobile() ? undefined : BACKUP_ACCEPT}
          disabled={disabled ?? false}
          onFile={(file) => {
            setOutcome(null)
            setPending(file)
          }}
        >
          Restore from backup…
        </FileButton>
      </div>
      <StorageStatusLine status={model.storageStatus.value} />

      <Sheet title="Restore from backup" open={pending !== null} onClose={closeSheet}>
        <div class={styles.flow}>
          {pending ? <p class={styles.fileName}>{pending.name}</p> : null}
          {outcome === null ? (
            <>
              <p>
                Pieces, results and practice history from the backup are added to this device; nothing here is deleted,
                and where both have the same piece the more recent one is kept. Settings are replaced by the backup's,
                except this device's piano connection.
              </p>
              <div class={styles.flowActions}>
                <Button onClick={closeSheet} disabled={restoring}>
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
              <div class={styles.flowActions}>
                <span />
                <Button variant="primary" onClick={closeSheet}>
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
              <div class={styles.flowActions}>
                <span />
                <Button onClick={closeSheet}>Close</Button>
              </div>
            </>
          )}
        </div>
      </Sheet>
    </section>
  )
}
