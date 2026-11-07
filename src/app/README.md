# src/app — app shell, global state, feature detection

The shell the four main views plug into. Spec: "Main user journey", "Practice screen",
"Technical design" (Preact + signals, small controls), "Storage and recovery" (wake lock),
"Delivery and device compatibility" (what Safari lacks), "Performance targets" (shell budget).

## Files

| File | Role |
| --- | --- |
| `App.tsx` | Shell: current view, app bar (non-practice), capability banner (library), toasts, the Settings overlay and the Connection modal. Holds the wake lock while the Practice or Consult view is shown; moves focus into `<main>` and sets the tab title after navigation. |
| `views.ts` | **The view registry.** One entry per `ViewName` (`library`, `practice`, `results`, `consult`): `{ title, chrome, component | load }`, plus `overlayScreens` for screens shown in a modal (`connection`). |
| `LazyView.tsx` | Renders the registry entry; caches lazily loaded views; quiet "Loading…" after 250 ms; retry on load failure. `preloadView(name)` to prefetch. |
| `navigation.ts` | The signals views read: `currentView`, `practiceRequest`, `resultsRequest`, `consultRequest`, `settingsOpen`, `connectionOpen`, and `navigate`, `openPractice`, `openResults`, `openConsult`, `openSettings`/`closeSettings`, `openConnection`/`closeConnection`. At most one overlay is open; `navigate(view)` closes overlays. `navigate('connection')` is kept as an alias for `openConnection()`. |
| `routes.ts`, `router.ts` | URL hash routing (below): pure parse/format, and the two-way sync between the signals and `location.hash` / `history.state`, started by `boot.ts`. |
| `state.ts` | Global signals and actions (below). |
| `settingsMerge.ts` | Pure: `mergeSettings` (immutable deep merge), `deepEqual`, `normalizeSettings` / `settingsFromStored` (identity-preserving wrappers over the single normalizer in `core/storage/settings.ts`), `SettingsPatch<T>`. |
| `features.ts` | Pure feature detector with human explanations. |
| `wakeLock.ts` | Screen wake lock controller. |
| `theme.ts` | `data-theme` from `settings.view.theme`, cached in localStorage for a correct first paint. |
| `boot.ts` | `startShell()` from `main.tsx`: theme sync, initial MIDI status from detection, settings flush on `pagehide`/hidden, preload first view. |
| `AppBar`, `NoticeArea`, `CapabilityBanner` | Shell chrome. `ConnectionChip` lives in `views/shared` so Practice can reuse it. |
| `version.ts` | `APP_VERSION` from `package.json` (tree-shaken). |

The non-practice app bar uses the Olive page surface, a compact lowercase wordmark, and the
existing MIDI/Settings actions (U49). On narrow phones the music icon replaces the visible wordmark.

App-authored notices and practice explanations use periods, commas, or conjunctions instead of
semicolons. User-supplied piece and device names are unchanged.

## Routing (`routes.ts`, `router.ts`)

Hash routes (static Pages host, no rewrites). The signals in `navigation.ts` stay the source of
truth; `startRouter()` (from `boot.ts`, before the first render) reads the URL into them and
mirrors every change back.

| Hash | Screen |
| --- | --- |
| `#/` (or empty) | Library |
| `#/practice/<pieceId>` (`#/practice`: its empty state) | Practice |
| `#/results/<pieceId>[/<attemptId>]` | Results |
| `#/consult/<pieceId>` (`#/consult`: its empty state) | Consult (U72) |
| any of the above + `?settings` / `?connection` | that overlay over the screen |
| `#/connection`, `#/settings` | aliases: the overlay over the Library (rewritten to `#/?connection`) |

- Pages push an entry. Opening an overlay pushes one too (`history.state.overlayFrom`), and
  closing it (button, Escape or `closeX()`) calls `history.back()`, so Back and Escape are the
  same. Swapping overlays, closing a deep-linked overlay and changing a Practice preset in place
  use `replaceState`; leaving the page while an overlay is open takes over the overlay's entry.
- A Practice preset (passage, hands, speed) rides in `history.state.preset`, not the URL.
- Signal writes are coalesced per microtask, so `closeSettings(); openConnection()` is one swap.
  While our own `history.back()` is pending nothing else is written; its `popstate` re-syncs.
- Unknown hashes are the Library; unknown piece ids reach the view's own empty state.
- Tests: `routes.test.ts` (parse/format round trips), `router.test.ts` (fake session history
  with an asynchronous `back()`), `tests/e2e/routing.spec.ts`.

## `state.ts` API

```ts
settings: Signal<AppSettings>                       // never assign; use updateSettings
updateSettings(patch: SettingsPatch<AppSettings>)   // immutable deep merge, no-op if unchanged
setSettingsPersistence({ load, save } | null): Promise<void>
settingsLoading: Signal<boolean>                    // true while stored settings are being read
flushSettings(): Promise<void>                      // write now (also done on pagehide)
SETTINGS_SAVE_DEBOUNCE_MS = 400

onBeforeApplyLabels(hook: (next) => void): () => void   // returns unregister
applyLabelSettings(next: PersistentLabelSettings): boolean // hook first, then settings; false if unchanged

connectionStatus: Signal<ConnectionStatus>          // { state, inputName?, outputName?, detail? }
setConnectionStatus(status)

notices: Signal<AppNotice[]>
pushNotice({ kind: 'info'|'success'|'warning'|'error', text, timeoutMs? }): number
dismissNotice(id)
```

- **Merge rules.** Nested objects merge; `labels.rules` merges per clef key; nullable fields
  (`threshold`, `hintPedal`, route ids) and arrays are replaced whole (the patch type enforces it).
  A patch that changes nothing returns the same object, so nothing re-renders or saves.
  `__proto__`/`constructor` keys are ignored (storage and restored backups are untrusted).
- **Persistence.** In memory until `setSettingsPersistence` is called. It loads, merges over
  `DEFAULT_SETTINGS` (`settingsFromStored`: unknown/partial/older data is repaired, new settings
  get defaults) and replays any `updateSettings` made while loading. Saves are debounced, run
  one at a time, and a failure raises one warning toast until a save succeeds. Storage wiring:
  `await setSettingsPersistence({ load: () => store.getSettings(), save: (s) => store.putSettings(s) })`.
- **Labels hook.** `applyLabelSettings` is the only path that changes `labels` from the UI
  (Settings Apply, and the Practice header's Off / All / Conditional control should use it too).
  The session registers `onBeforeApplyLabels(() => engine.interrupt('settings'))`; hooks run
  synchronously before the new labels exist. Naming-only changes use `updateSettings` and never
  run the hook (spec: naming never interrupts).
- **Connection status.** The MIDI adapter owner calls `setConnectionStatus`; at boot it is set to
  `unsupported` when Web MIDI is absent, else `disconnected`.
- Signals are coarse by design: nothing here is per note or per MIDI event.

## `features.ts`

`detectFeatures(env = globalThis)` returns `{ features: Record<FeatureId, FeatureStatus>, missing }`;
`getFeatures()` memoizes it for the page. Ids: `webMidi`, `webAudio`, `moduleWorkers`, `indexedDb`,
`persistentStorage`, `wakeLock`. Each status has `supported`, `severity` (`required` /
`important` / `optional`) and, when missing, a short `explanation` (Safari has no Web MIDI: score
viewing and browser-sound reference playback only; use MIDIWeb on iPad or Chrome on a computer).
Module workers are detected by constructing a throwaway worker whose options getter records whether
the engine reads `type` (WebIDL reads it before the constructor can fail). Every probe is wrapped,
so a throwing getter counts as missing.

## `wakeLock.ts`

`wakeLock.hold(owner)` / `wakeLock.drop(owner)`: reference-counted by owner, so the practice view
and a playing session can both ask. Requests when the page is visible, re-requests on
`visibilitychange` (browsers drop the lock when hidden), releases when the last owner drops,
tolerates refusal (one retry per visibility event, never a loop) and missing support.
`WakeLockController` takes an injectable environment for tests.

## Extension points for the later views

1. **Register the view** in `views.ts`. Library: `component: Library` (static, first screen).
   Connection/Practice/Results: `load: () => import('../views/practice/PracticeView').then(m => ({ default: m.PracticeView }))`
   so the library shell stays small (`npm run size`). `chrome: 'none'` gives Practice the whole
   viewport (no app bar, no scrolling `<main>`); `'bar'` views scroll inside `<main>`.
2. **Navigation**: `navigate('practice')`, and `preloadView('practice')` when a score is chosen.
3. **Settings and Connection from anywhere**: `openSettings()` / `openConnection()` (overlays; the view stays mounted underneath).
4. **Connection status**: `ConnectionChip` (`views/shared`) for the Practice header; it opens the Connection modal.
5. **Toasts**: `pushNotice(...)`. Do not use them for the wrong-note feedback (use `ui/WrongNoteFlash`).
6. **Settings persistence** and **label hook**: see above.
7. **Library banner**: the shell shows `CapabilityBanner` on the library view for missing
   required/important features; views should not duplicate it. Detailed MIDI help belongs in
   Connection, driven by `getFeatures().features.webMidi`.

## Tests

`state.test.ts`, `settingsMerge.test.ts`, `features.test.ts`, `wakeLock.test.ts` (unit, node);
`App.test.tsx` (happy-dom: navigation, lazy loading, chip states, toasts fading, banner, theme).
Component tests use `src/views/shared/testing.ts` (`mount`, `click`, `type`, `press`, `byLabel`).

## Spec coverage

Done: shell, view registry with lazy loading, app bar, status chip, toasts, Settings overlay
(see `views/settings`), feature detection, wake lock, theme, settings state and persistence hook.
Left for the session wiring: registering `onBeforeApplyLabels`, driving `connectionStatus` from the
MIDI adapter, `setSettingsPersistence` with the storage module.
