import { render } from 'preact'
import { App } from './app/App'
import { startShell } from './app/boot'
import { languageReady } from './app/language'
import { startPwa } from './app/pwa'
import './ui/global.css'

/** The longest the first render waits for a returning player's language (normally precached). */
const LANGUAGE_WAIT_MS = 300

function start(): void {
  startShell()
  const show = () => render(<App />, document.getElementById('app')!)
  const ready = languageReady(LANGUAGE_WAIT_MS)
  if (ready) void ready.then(show)
  else show()
  startPwa()
}

if (import.meta.env.DEV) {
  // Development only: the Preact DevTools extension needs `preact/debug` loaded before the first
  // render (it also adds dev warnings). `import.meta.env.DEV` is a build-time constant, so this
  // branch and the import are removed from the production bundle (`npm run size` shows no change).
  import('preact/debug').then(start, start)
} else {
  start()
}
