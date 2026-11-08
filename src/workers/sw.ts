/**
 * The service worker (DECISIONS U84): the app installs, relaunches offline, and runs the latest
 * deploy whenever the network answers. `scripts/pwa.ts` builds it at the end of `vite build`: it
 * strips the types, prepends `BUILD` and `ASSETS` (every file of the build except source maps)
 * and writes `dist/sw.js`. A classic script: no imports.
 *
 * - **Install**: precache `ASSETS` into this build's cache. A file that another build's cache
 *   already holds with the same SHA-256 is copied instead of downloaded, so a deploy downloads
 *   only what changed, and every download is checked against its hash (`integrity`). Then the
 *   worker takes over at once (`skipWaiting`, `clients.claim`); the page decides when to reload.
 * - **Pages** (navigations): network first, so an online launch or reload runs the latest
 *   deploy. This build's `index.html` answers when the network fails, refuses or takes longer
 *   than `NAVIGATION_TIMEOUT_MS`.
 * - **Everything else in scope**: the cache first (this build's, then any other build's, so a
 *   page still running an older build finds its lazily imported chunks), else the network. A
 *   hashed file under `assets/` fetched from the network is kept: a newer page's chunk, loaded
 *   before that page's own worker has installed.
 * - **Old caches** go only when no open page runs their build and they are older than this
 *   worker's own. Each page says which build it runs (`pn-hello`, `app/pwa.ts`); while any open
 *   page has not said so, nothing is deleted. A newer worker may be filling its cache while this
 *   one prunes, hence the install stamp.
 */
export {}

declare const self: ServiceWorkerGlobalScope
/** Content hash of the build, the suffix of its cache name (prepended by `scripts/pwa.ts`). */
declare const BUILD: string
/** `[path relative to the scope, SRI integrity]` for every precached file (prepended likewise). */
declare const ASSETS: readonly (readonly [string, string])[]

const NAVIGATION_TIMEOUT_MS = 3000
const scope = self.registration.scope
/** The scope is part of the name, so two copies of the app on one origin keep their caches apart. */
const PREFIX = `pianissimo:${scope}:`
const CACHE = PREFIX + BUILD
const SHELL = new URL('index.html', scope).href
/** When a cache was filled: an entry no page ever requests. */
const STAMP = new URL('__pianissimo-installed', scope).href
/** The build each open page runs, by client id. Lost when the worker stops; pages repeat it. */
const pageBuilds = new Map<string, string>()
/**
 * A build's files never vary. Servers may still send `Vary: Origin` (Vite's preview does), and
 * the `crossorigin` module scripts carry an `Origin` header the precache requests lack.
 */
const MATCH: CacheQueryOptions = { ignoreVary: true }

self.addEventListener('install', (event) => {
  void self.skipWaiting()
  event.waitUntil(precache())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim().then(prune))
})

self.addEventListener('message', (event) => {
  const data = event.data as { type?: unknown; build?: unknown } | null
  if (data?.type !== 'pn-hello' || typeof data.build !== 'string') return
  if (event.source instanceof Client) pageBuilds.set(event.source.id, data.build)
  event.ports[0]?.postMessage({ current: data.build === BUILD })
  event.waitUntil(prune())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || !request.url.startsWith(scope)) return
  event.respondWith(request.mode === 'navigate' ? page(request) : asset(event))
})

async function precache(): Promise<void> {
  const cache = await caches.open(CACHE)
  await cache.put(STAMP, new Response(String(Date.now())))
  await Promise.all(
    ASSETS.map(async ([path, integrity]) => {
      const url = new URL(path, scope).href
      const kept = await caches.match(url, MATCH)
      if (kept && (await sri(kept.clone())) === integrity) return cache.put(url, kept)
      // `no-cache` revalidates, so the HTTP cache never stands in for this deploy's file.
      const response = await fetch(url, { cache: 'no-cache', integrity })
      if (!response.ok) throw new Error(`Precaching ${path} failed: HTTP ${response.status}`)
      return cache.put(url, response)
    }),
  )
}

async function page(request: Request): Promise<Response> {
  const network = fetch(request.url, { cache: 'no-cache', redirect: 'manual' })
  void network.catch(() => undefined)
  const late = new Promise<undefined>((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS))
  const answer = await Promise.race([network, late]).catch(() => undefined)
  if (answer && (answer.ok || answer.type === 'opaqueredirect')) return answer
  const shell = (await (await caches.open(CACHE)).match(SHELL, MATCH)) ?? (await caches.match(SHELL, MATCH))
  return shell ?? answer ?? network
}

async function asset(event: FetchEvent): Promise<Response> {
  const { request } = event
  const cache = await caches.open(CACHE)
  const cached = (await cache.match(request, MATCH)) ?? (await caches.match(request, MATCH))
  if (cached) return cached
  const response = await fetch(request)
  const hashed = request.url.startsWith(`${scope}assets/`) && !request.url.endsWith('.map')
  if (hashed && response.ok && response.type === 'basic') {
    event.waitUntil(cache.put(request, response.clone()).catch(() => undefined))
  }
  return response
}

async function prune(): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const pages = windows.filter((client) => client.url.startsWith(scope))
  for (const id of pageBuilds.keys()) if (!pages.some((client) => client.id === id)) pageBuilds.delete(id)
  const needed = new Set([BUILD])
  for (const client of pages) {
    const build = pageBuilds.get(client.id)
    if (build === undefined) return // An open page has not said which build it runs: keep everything.
    needed.add(build)
  }
  const mine = await installedAt(CACHE)
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX) || needed.has(name.slice(PREFIX.length))) continue
    if ((await installedAt(name)) < mine) await caches.delete(name)
  }
}

/** When a cache was filled; a cache without a stamp counts as the newest (it may be filling). */
async function installedAt(name: string): Promise<number> {
  const stamp = await (await caches.open(name)).match(STAMP)
  return stamp ? Number(await stamp.text()) : Infinity
}

/** Subresource Integrity string (`sha256-…`) of a response's body. */
async function sri(response: Response): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return `sha256-${btoa(binary)}`
}
