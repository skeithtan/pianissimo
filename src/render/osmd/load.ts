import type { OsmdModule } from './osmd-types'

let pending: Promise<OsmdModule> | undefined

/**
 * Loads OSMD on first use through a dynamic import, so the library view never fetches the
 * notation engine (spec "Deferred assets"). OSMD keeps its bundled VexFlow (spec stack table).
 */
export function loadOsmd(): Promise<OsmdModule> {
  pending ??= import('opensheetmusicdisplay').then((mod: unknown) => {
    const m = mod as Partial<OsmdModule> & { default?: Partial<OsmdModule> }
    const ctor = m.OpenSheetMusicDisplay ?? m.default?.OpenSheetMusicDisplay
    if (!ctor) throw new Error('OpenSheetMusicDisplay export not found')
    return { OpenSheetMusicDisplay: ctor }
  })
  pending.catch(() => {
    pending = undefined
  })
  return pending
}

/** True once the module promise has settled successfully (for load-time accounting). */
export function osmdRequested(): boolean {
  return pending !== undefined
}
