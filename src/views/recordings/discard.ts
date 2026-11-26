/**
 * Discarding recordings, with Undo (DECISIONS U164). Stored takes are taken out of every list at once
 * and removed once Undo is gone; a take that was still recording is held in memory for that long. One
 * toast stands for everything discarded while it shows. The time to undo is kept here, not by the toast.
 */
import { signal } from '@preact/signals'
import { dismissNotice, pushNotice } from '../../app/state'
import { msg } from '../../i18n/messages'
import type { RecordingStorage } from './History'

/** Long enough to read the toast and reach it from the keyboard of a piano. */
export const UNDO_MS = 10_000
/** More for several at once: there is more to lose. */
export const UNDO_MANY_MS = 20_000

/** Discarded on this screen: no list shows them, and the saved take's pill goes. */
export const discarded = signal<ReadonlySet<string>>(new Set())
/** Counts what brought takes back: lists read them again. */
export const restored = signal(0)

interface Batch {
  readonly storage: RecordingStorage
  readonly ids: readonly string[]
  /** Saves a take that was discarded while it was recording. */
  readonly held: readonly (() => Promise<unknown>)[]
}

/** The last Undo's toast: it goes when something else is discarded. */
let said = 0
let batch: (Batch & { notice: number; timer: ReturnType<typeof setTimeout> }) | null = null

/** Discard stored takes. Rejects, with nothing discarded, when that could not be written. */
export async function discardTakes(storage: RecordingStorage, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  discarded.value = new Set([...discarded.peek(), ...ids])
  try {
    await (await storage()).discardRecordings(ids)
  } catch (error) {
    forget(ids)
    throw error
  }
  offerUndo({ storage, ids, held: [] })
}

/** Offer Undo for a take discarded while it was recording: `keep` saves it after all. */
export function discardHeld(storage: RecordingStorage, keep: () => Promise<unknown>): void {
  offerUndo({ storage, ids: [], held: [keep] })
}

function forget(ids: readonly string[]): void {
  const next = new Set(discarded.peek())
  for (const id of ids) next.delete(id)
  discarded.value = next
}

function offerUndo({ storage, ids, held }: Batch): void {
  const all: Batch = { storage, ids: [...(batch?.ids ?? []), ...ids], held: [...(batch?.held ?? []), ...held] }
  dismissNotice(said)
  if (batch) {
    clearTimeout(batch.timer)
    dismissNotice(batch.notice)
  }
  const count = all.ids.length + all.held.length
  const ms = count === 1 ? UNDO_MS : UNDO_MANY_MS
  batch = {
    ...all,
    notice: pushNotice({
      kind: 'info',
      icon: 'trash',
      text: count === 1 ? msg('Recording discarded') : msg('{0} recordings discarded', count),
      action: { label: msg('Undo'), icon: 'undo', run: () => void undo() },
      timeoutMs: ms,
    }),
    timer: setTimeout(() => void commit(), ms),
  }
}

/** Undo is gone. A removal that fails, or that a closed page cuts short, is done on a later open. */
async function commit(): Promise<void> {
  const gone = batch
  batch = null
  if (!gone || gone.ids.length === 0) return
  try {
    await (await gone.storage()).removeDiscardedRecordings(gone.ids)
  } catch {
    // They are out of every list already.
  }
}

async function undo(): Promise<void> {
  const back = batch
  if (!back) return
  batch = null
  clearTimeout(back.timer)
  dismissNotice(back.notice)
  try {
    if (back.ids.length > 0) await (await back.storage()).restoreRecordings(back.ids)
    forget(back.ids)
  } catch {
    pushNotice({ kind: 'warning', text: msg('Could not undo. Try again.') })
    offerUndo(back)
    return
  }
  let kept = back.ids.length
  for (const keep of back.held) {
    try {
      await keep()
      kept += 1
    } catch {
      pushNotice({
        kind: 'warning',
        text: msg('Recording could not be saved. Open Recordings to download it or retry.'),
      })
    }
  }
  restored.value += 1
  if (kept > 0)
    said = pushNotice({
      kind: 'success',
      text: kept === 1 ? msg('Recording restored') : msg('{0} recordings restored', kept),
    })
}

/** Tests only. */
export function resetDiscardForTests(): void {
  if (batch) clearTimeout(batch.timer)
  batch = null
  discarded.value = new Set()
}
