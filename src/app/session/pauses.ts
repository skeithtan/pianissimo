/**
 * Tempo-dependent pause detection for gated (waiting) practice: shared by the "Too late"
 * correction mark and the speed ladder.
 */
import type { OnsetGroup, Timeline } from '../../core/engine/timeline'
import type { AttemptRecord } from '../../core/model/practice'
import { effectiveTempoAt, hasTempo, isValidMultiplier } from '../../core/music/tempo'

/**
 * Fallback "Too late" / pause threshold when the tempo at a group is unknown (ms).
 * Re-exported from `corrections.ts`.
 */
export const LATE_MARK_MS = 350

/** Bounds of the pause threshold (ms). */
export const PAUSE_MIN_MS = 250
export const PAUSE_MAX_MS = 600

/**
 * How long after the music reached `group` a completion counts as a pause: half a beat at the
 * practice speed, clamped to [PAUSE_MIN_MS, PAUSE_MAX_MS]. `LATE_MARK_MS` when the tempo is
 * unknown there.
 *
 * `effectiveTempoAt` returns `beatBpm` (displayed beats per minute for the segment's `beatUnit` —
 * e.g. quarter notes in 4/4, dotted quarters in 6/8 — already scaled by `multiplier`), so one beat
 * is `60_000 / beatBpm` ms and half a beat is `30_000 / beatBpm` ms.
 */
export function pauseThresholdMs(
  timeline: Pick<Timeline, 'tempo' | 'multiplier'>,
  group: Pick<OnsetGroup, 'position'>,
): number {
  if (!timeline.tempo || !hasTempo(timeline.tempo) || !group.position || !isValidMultiplier(timeline.multiplier)) {
    return LATE_MARK_MS
  }
  const { beatBpm } = effectiveTempoAt(timeline.tempo, group.position, timeline.multiplier)
  if (!Number.isFinite(beatBpm) || beatBpm <= 0) return LATE_MARK_MS
  return Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, 30_000 / beatBpm))
}

/**
 * The groups of a gated record where the player paused: `lateMs` at or above the group's
 * threshold and no wrong key there (a wrong key's recovery time is not a pause). Empty for
 * strict (Keep time) records and records without per-group outcomes. Ascending.
 */
export function pausedGroups(record: AttemptRecord, timeline: Timeline): number[] {
  if (record.context?.transport === 'strict' || record.rhythm !== undefined) return []
  if (!record.groups?.length) return []
  const paused: number[] = []
  for (const g of record.groups) {
    if (g.wrongAttacks !== 0) continue
    const group = timeline.groups[g.group]
    if (!group) continue
    if (g.lateMs >= pauseThresholdMs(timeline, group)) paused.push(g.group)
  }
  return paused.sort((a, b) => a - b)
}
