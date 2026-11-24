/**
 * Where a browser without Web MIDI can send its user (DECISIONS U159). Safari, and every browser on
 * iPad and iPhone, has no Web MIDI; Firefox has it on computers only (since 108).
 */
export interface NavigatorLike {
  readonly userAgent?: string
  readonly vendor?: string
  readonly platform?: string
  readonly maxTouchPoints?: number
}

export interface PianoBrowser {
  readonly name: string
  readonly url: string
}

export interface PianoBrowsers {
  /** Apple's phones and tablets need an app, not just another browser. */
  readonly app: boolean
  /** In the order they are recommended. */
  readonly browsers: readonly PianoBrowser[]
}

const MIDIWEB: PianoBrowser = {
  name: 'MIDIWeb Browser',
  url: 'https://apps.apple.com/app/midiweb-browser/id6757226617',
}
const FIREFOX: PianoBrowser = { name: 'Firefox', url: 'https://www.firefox.com/' }
const CHROME: PianoBrowser = { name: 'Chrome', url: 'https://www.google.com/chrome/' }

export function detectAppleMobile(nav: NavigatorLike | undefined = globalThis.navigator): boolean {
  if (!nav) return false
  if (/iPad|iPhone|iPod/.test(nav.userAgent ?? '')) return true
  // iPadOS 13+ reports a Mac platform; touch points tell it apart from a real Mac.
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1
}

/**
 * Safari itself, or the app installed from it. Other browsers on iPad and iPhone have Apple's vendor
 * too and name themselves.
 */
export function isSafari(nav: NavigatorLike | undefined = globalThis.navigator): boolean {
  if (!/^Apple/.test(nav?.vendor ?? '')) return false
  return !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|Brave|GSA\//.test(nav?.userAgent ?? '')
}

/** The browsers on this device that can connect a piano. */
export function pianoBrowsers(nav: NavigatorLike | undefined = globalThis.navigator): PianoBrowsers {
  if (detectAppleMobile(nav)) return { app: true, browsers: [MIDIWEB] }
  return { app: false, browsers: /Android/.test(nav?.userAgent ?? '') ? [CHROME] : [FIREFOX, CHROME] }
}
