import { render } from 'preact'
import { App } from './app/App'
import { startShell } from './app/boot'
import './ui/global.css'

function start(): void {
  startShell()
  render(<App />, document.getElementById('app')!)
}

if (import.meta.env.DEV) {
  // Development only: the Preact DevTools extension needs `preact/debug` loaded before the first
  // render (it also adds dev warnings). `import.meta.env.DEV` is a build-time constant, so this
  // branch and the import are removed from the production bundle (`npm run size` shows no change).
  import('preact/debug').then(start, start)
} else {
  start()
}
