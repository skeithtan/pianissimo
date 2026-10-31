/**
 * Deferred loaders (spec "Execution and rendering architecture": piano samples load only when
 * browser audio or monitoring is selected; "MIDI-only resource use"). These dynamic imports
 * are the only references to the browser-audio and metronome modules from the playback index,
 * so the bundler emits them as separate chunks.
 */
export type BrowserAudioModule = typeof import('./browserAudio')
export type MetronomeModule = typeof import('./webaudio/metronome')

export function loadBrowserAudio(): Promise<BrowserAudioModule> {
  return import('./browserAudio')
}

/** The Web Audio click; load when the metronome is enabled. */
export function loadWebAudioMetronome(): Promise<MetronomeModule> {
  return import('./webaudio/metronome')
}
