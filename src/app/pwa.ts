/**
 * Installed app and offline support, the page's side (DECISIONS U84). A production build
 * registers the service worker that `scripts/pwa.ts` writes from `src/workers/sw.ts`, scoped to
 * the base path, once the page has loaded.
 *
 * Staying current: the worker serves pages network first, so an online launch or reload already
 * runs the latest deploy. A page that stays open asks for a newer worker at launch, when the
 * network comes back and whenever it is shown again (an installed app can sit in the background
 * for days). A newer worker takes over at once, and when this page runs an older build it
 * reloads, but only where that interrupts nothing: never on the Practice or Study screen (it
 * waits until the learner leaves it) and never while a sheet is open (an import, a restore,
 * Settings). Settings and practice records are written before the reload.
 */
import { effect } from '@preact/signals'
import { requestPersistentStorage } from '../core/storage/persist'
import { connectionOpen, currentView, settingsOpen } from './navigation'
import { getStorage } from './services'
import { flushSettings } from './state'

/**
 * The wait before a reload checks whether it is safe: a screen that was just left queues its
 * records, a sheet that was just closed finishes fading out (200 ms) and leaves the DOM.
 */
export const SETTLE_MS = 400
/** The reload goes ahead even if writing the records hangs this long. */
export const SAVE_TIMEOUT_MS = 2000
/** A worker that does not answer `pn-hello` in this time is treated as not knowing the page. */
const HELLO_TIMEOUT_MS = 5000

export interface ReloaderDeps {
  /** True while a reload would interrupt something. */
  readonly busy: () => boolean
  /** Write what is pending (settings, practice records). */
  readonly save: () => Promise<unknown>
  readonly reload: () => void
  readonly wait?: (ms: number) => Promise<void>
}

export interface Reloader {
  /** A newer build has taken over: reload as soon as nothing would be interrupted. */
  readonly stale: () => void
  /** Something changed that may make the reload safe (navigation, the page shown again). */
  readonly poke: () => void
}

/** The reload policy, apart from the browser so that it can be tested. */
export function createReloader(deps: ReloaderDeps): Reloader {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let stale = false
  let pending = false
  const attempt = async (): Promise<void> => {
    await wait(SETTLE_MS)
    if (!deps.busy()) {
      await Promise.race([deps.save().catch(() => undefined), wait(SAVE_TIMEOUT_MS)])
      if (!deps.busy()) return deps.reload()
    }
    pending = false
  }
  const poke = (): void => {
    if (!stale || pending) return
    pending = true
    void attempt()
  }
  return {
    stale: () => {
      stale = true
      poke()
    },
    poke,
  }
}

function busy(): boolean {
  const view = currentView.peek()
  return view === 'practice' || view === 'study' || document.querySelector('dialog[open]') !== null
}

function save(): Promise<unknown> {
  return Promise.all([flushSettings(), getStorage().then((storage) => storage.history.flush())])
}

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

/** Register the service worker and keep this page on the latest build (production only). */
export function startPwa(): void {
  const build = document.querySelector<HTMLMetaElement>('meta[name="pianissimo-build"]')?.content
  if (!import.meta.env.PROD || !build || !('serviceWorker' in navigator)) return
  const container = navigator.serviceWorker
  const reloader = createReloader({ busy, save, reload: () => location.reload() })

  /** Tell a worker which build this page runs; resolves with whether it is the worker's own. */
  const hello = (worker: ServiceWorker | null): Promise<boolean | undefined> =>
    new Promise((resolve) => {
      if (!worker) return resolve(undefined)
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => resolve((event.data as { current?: boolean }).current)
      worker.postMessage({ type: 'pn-hello', build }, [channel.port2])
      setTimeout(() => resolve(undefined), HELLO_TIMEOUT_MS)
    })
  const introduce = (): void => void container.ready.then((registration) => hello(registration.active))

  // A worker took over: the first install (this page's own build), or a newer deploy. Only a
  // takeover can make this page stale; a page newer than the worker (loaded from the network
  // before its worker installed) is current, and its worker is about to be replaced.
  container.addEventListener('controllerchange', () => {
    void hello(container.controller).then((current) => {
      if (current === false) reloader.stale()
    })
  })
  // Leaving a screen or closing an overlay may make the reload safe.
  effect(() => {
    void currentView.value
    void settingsOpen.value
    void connectionOpen.value
    reloader.poke()
  })

  const start = async (): Promise<void> => {
    const base = import.meta.env.BASE_URL
    const registration = await container.register(`${base}sw.js`, { scope: base, updateViaCache: 'none' })
    const check = (): void => void registration.update().catch(() => undefined)
    if (registration.active) check()
    introduce()
    addEventListener('online', check)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      reloader.poke()
      check()
      introduce()
    })
    // An installed app is a strong sign the library is worth keeping (the import flow also asks).
    if (isStandalone()) void requestPersistentStorage()
  }
  const go = (): void => void start().catch(() => undefined)
  if (document.readyState === 'complete') go()
  else addEventListener('load', go, { once: true })
}
