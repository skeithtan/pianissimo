interface Finishable {
  readonly done: Promise<void>
  abort(): void
}

/**
 * Mark a request as observed. When several writes are collected before awaiting them, a
 * later `put` can throw synchronously (a structured-clone error); the transaction is then
 * aborted and the earlier, never-awaited requests would reject unobserved.
 */
export function observed<T>(request: Promise<T>): Promise<T> {
  request.catch(() => undefined)
  return request
}

/**
 * Run `work` inside an open transaction and wait for it to commit. Any failure (a rejected
 * request, a structured-clone error thrown synchronously, a validation error) aborts the
 * whole transaction, so nothing is half-written, and the abort is observed so it cannot
 * surface as an unhandled rejection. Only IndexedDB requests may be awaited inside `work`.
 */
export async function runTx<T>(tx: Finishable, work: () => Promise<T>): Promise<T> {
  try {
    const result = await work()
    await tx.done
    return result
  } catch (error) {
    tx.done.catch(() => undefined)
    try {
      tx.abort()
    } catch {
      // Already finished or aborted.
    }
    throw error
  }
}
