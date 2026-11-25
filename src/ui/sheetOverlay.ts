/**
 * The topmost open sheet. Everything outside a modal dialog is inert and under its backdrop, toasts
 * included, so the topmost sheet draws them itself (`sheetOverlay`, set by the app's notice area).
 */
import { signal } from '@preact/signals'
import type { ComponentType } from 'preact'

const open: HTMLDialogElement[] = []

export const topSheet = signal<HTMLDialogElement | null>(null)
export const sheetOverlay = signal<ComponentType | null>(null)

/** A sheet opens over the others. Returns its leaving. */
export function enterSheet(dialog: HTMLDialogElement): () => void {
  open.push(dialog)
  topSheet.value = dialog
  return () => {
    open.splice(open.indexOf(dialog), 1)
    topSheet.value = open.at(-1) ?? null
  }
}
