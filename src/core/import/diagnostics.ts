/**
 * Diagnostic collection. Repeated findings of one code are capped so a systematically odd file
 * produces a readable list instead of thousands of rows; the cap note keeps the total visible.
 */
import type { Diagnostic, DiagnosticSeverity } from '../model/score'

const DEFAULT_CAP = 25

export class DiagnosticSink {
  private readonly items: Diagnostic[] = []
  private readonly counts = new Map<string, number>()
  private readonly cap: number

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap
  }

  add(severity: DiagnosticSeverity, code: string, message: string, where?: { measure?: string; occ?: number }): void {
    const n = (this.counts.get(code) ?? 0) + 1
    this.counts.set(code, n)
    if (n > this.cap) return
    const d: { -readonly [K in keyof Diagnostic]: Diagnostic[K] } = { severity, code, message }
    if (where?.measure !== undefined) d.measure = where.measure
    if (where?.occ !== undefined) d.occ = where.occ
    this.items.push(d)
  }

  error(code: string, message: string, where?: { measure?: string; occ?: number }): void {
    this.add('error', code, message, where)
  }

  warn(code: string, message: string, where?: { measure?: string; occ?: number }): void {
    this.add('warning', code, message, where)
  }

  info(code: string, message: string, where?: { measure?: string; occ?: number }): void {
    this.add('info', code, message, where)
  }

  count(code: string): number {
    return this.counts.get(code) ?? 0
  }

  has(code: string): boolean {
    return this.counts.has(code)
  }

  /** All diagnostics, with one summary row per code whose findings exceeded the cap. */
  list(): Diagnostic[] {
    const out = [...this.items]
    for (const [code, n] of this.counts) {
      if (n > this.cap) {
        const first = this.items.find((d) => d.code === code)
        out.push({
          severity: first?.severity ?? 'info',
          code,
          message: `${n - this.cap} more “${code}” findings not listed (${n} in total).`,
        })
      }
    }
    return out
  }
}
