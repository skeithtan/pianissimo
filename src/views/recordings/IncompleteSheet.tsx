import { useEffect, useState } from 'preact/hooks'
import { noteAccuracy } from '../../core/recording/performance'
import type { RecordingInfo } from '../../core/recording/records'
import { timeOfDay } from '../../i18n/dates'
import { msg, percentage } from '../../i18n/messages'
import { Button, Sheet } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { dayText, handName, lengthText } from './takeText'
import styles from './recordings.module.css'

/**
 * Before the incomplete takes go (U164): each with its time and length, all chosen. A tap on one keeps it.
 */
export function IncompleteSheet({
  open,
  takes,
  passageOf,
  titled,
  onCancel,
  onDelete,
}: {
  open: boolean
  takes: readonly RecordingInfo[]
  passageOf: (info: RecordingInfo) => string
  /** Takes of several pieces are listed: each says which. */
  titled: boolean
  onCancel: () => void
  onDelete: (ids: readonly string[]) => void
}) {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (open) setKept(new Set())
  }, [open])
  const chosen = takes.filter((t) => !kept.has(t.id)).map((t) => t.id)
  function toggle(id: string) {
    setKept((old) => {
      const next = new Set(old)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  return (
    <Sheet
      open={open}
      title={msg('Delete incomplete recordings?')}
      onClose={onCancel}
      className={styles.confirm}
      flush
      floating
    >
      <p class={styles.question}>
        {takes.length === 1
          ? msg('Are you sure you want to delete this recording?')
          : msg('Are you sure you want to delete these recordings? Tap any you want to keep.')}
      </p>
      <ul class={styles.choices}>
        {takes.map((t) => {
          const keep = kept.has(t.id)
          return (
            <li key={t.id}>
              <button type="button" class={styles.choice} aria-pressed={!keep} onClick={() => toggle(t.id)}>
                <span class={styles.mark}>{keep ? null : <Icon name="check" size={16} />}</span>
                <span class={styles.words}>
                  <strong>
                    {titled ? t.title : timeOfDay(t.createdAt)}{' '}
                    {titled ? null : <span class={styles.length}>{lengthText(t.durationMs)}</span>}
                  </strong>
                  <small>
                    {dayText(t.createdAt, 'short')}
                    {titled ? ` · ${timeOfDay(t.createdAt)} · ${lengthText(t.durationMs)}` : ''}
                  </small>
                  <small>
                    {passageOf(t)} · {handName(t.hands)}
                  </small>
                </span>
                <span class={styles.result}>
                  <strong>{percentage(noteAccuracy(t.score))}</strong>
                  {keep ? <small class={styles.keep}>{msg('Keep')}</small> : null}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <div class={styles.answer}>
        <Button class={styles.tool} onClick={onCancel}>
          {msg('Cancel')}
        </Button>
        <Button class={`${styles.tool} ${styles.sure}`} disabled={chosen.length === 0} onClick={() => onDelete(chosen)}>
          {chosen.length === 1 ? msg('Delete 1 recording') : msg('Delete {0} recordings', chosen.length)}
        </Button>
      </div>
    </Sheet>
  )
}
