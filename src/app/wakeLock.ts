/**
 * Screen wake lock (spec "Storage and recovery": prefer device wake prevention where the browser
 * supports it, but recover from screen locking and app switching). A MIDI piano never touches the
 * screen, so without a lock the tablet would dim mid-piece.
 *
 * Feature-detected and failure-tolerant: an unsupported browser, a refusal (low battery, hidden
 * page) or a released sentinel never throws and never retries in a loop. The browser drops the
 * lock whenever the page is hidden, so it is requested again when the page becomes visible.
 */

interface SentinelLike {
  readonly released?: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

/** The slice of `navigator` + `document` the controller uses. */
export interface WakeLockEnvironment {
  readonly navigator?: { readonly wakeLock?: { request(type: 'screen'): Promise<SentinelLike> } | undefined }
  readonly document?: {
    readonly visibilityState: string
    addEventListener(type: 'visibilitychange', listener: () => void): void
    removeEventListener(type: 'visibilitychange', listener: () => void): void
  }
}

export type WakeLockState = 'unsupported' | 'idle' | 'requesting' | 'held' | 'failed'

/**
 * Reference-counted by owner so independent callers (the practice view, a playing session) can
 * each ask to keep the screen awake without releasing each other's lock.
 */
export class WakeLockController {
  private readonly env: WakeLockEnvironment
  private readonly owners = new Set<string>()
  private sentinel: SentinelLike | null = null
  private requesting = false
  private failed = false
  private listening = false
  private readonly onVisibility = (): void => {
    if (this.env.document?.visibilityState === 'visible') {
      this.failed = false
      this.acquire()
    }
  }

  constructor(env: WakeLockEnvironment = globalThis as WakeLockEnvironment) {
    this.env = env
  }

  get state(): WakeLockState {
    if (!this.env.navigator?.wakeLock) return 'unsupported'
    if (this.sentinel) return 'held'
    if (this.requesting) return 'requesting'
    return this.failed ? 'failed' : 'idle'
  }

  /** Keep the screen awake on behalf of `owner` until every owner has called `drop`. */
  hold(owner: string): void {
    this.owners.add(owner)
    if (!this.listening && this.env.document) {
      this.env.document.addEventListener('visibilitychange', this.onVisibility)
      this.listening = true
    }
    this.failed = false
    this.acquire()
  }

  /** Release `owner`'s claim; the lock itself is released once nobody wants it. */
  drop(owner: string): void {
    this.owners.delete(owner)
    if (this.owners.size > 0) return
    if (this.listening) {
      this.env.document?.removeEventListener('visibilitychange', this.onVisibility)
      this.listening = false
    }
    this.releaseSentinel()
  }

  private acquire(): void {
    const api = this.env.navigator?.wakeLock
    if (!api || this.owners.size === 0 || this.sentinel || this.requesting) return
    // A hidden page is always refused; wait for the visibilitychange that re-enters here.
    if (this.env.document && this.env.document.visibilityState !== 'visible') return
    this.requesting = true
    let request: Promise<SentinelLike>
    try {
      request = api.request('screen')
    } catch {
      this.requesting = false
      this.failed = true
      return
    }
    request.then(
      (sentinel) => {
        this.requesting = false
        if (this.owners.size === 0) {
          void sentinel.release().catch(() => undefined)
          return
        }
        this.sentinel = sentinel
        sentinel.addEventListener('release', () => {
          if (this.sentinel === sentinel) this.sentinel = null
        })
      },
      () => {
        this.requesting = false
        this.failed = true
      },
    )
  }

  private releaseSentinel(): void {
    const sentinel = this.sentinel
    this.sentinel = null
    if (sentinel) void sentinel.release().catch(() => undefined)
  }
}

/** The app's single controller over the real browser globals. */
export const wakeLock = new WakeLockController()
