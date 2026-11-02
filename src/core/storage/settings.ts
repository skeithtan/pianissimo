import type { ClefKey } from '../model/score'
import { DEFAULT_SETTINGS, DISABLED_RULE, SETTINGS_VERSION } from '../model/settings'
import type {
  AppSettings,
  ClefLabelRule,
  HintPedalMapping,
  LabelCondition,
  PersistentLabelMode,
  SoundDestination,
} from '../model/settings'
import { STEPS } from '../music/pitch'
import type { Spelling } from '../music/pitch'

type Raw = Readonly<Record<string, unknown>>

function obj(v: unknown): Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {}
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback
}

function strOrNull(v: unknown, fallback: string | null): string | null {
  if (v === null) return null
  return typeof v === 'string' ? v : fallback
}

/** A stored `null` is a deliberate value (cleared threshold, unset pedal); only wrong types fall back. */
function spellingOrNull(v: unknown, fallback: Spelling | null): Spelling | null {
  if (v === null) return null
  const r = obj(v)
  const step = r['step']
  const alter = r['alter']
  const octave = r['octave']
  if (
    typeof step === 'string' &&
    (STEPS as readonly string[]).includes(step) &&
    typeof alter === 'number' &&
    Number.isInteger(alter) &&
    Math.abs(alter) <= 2 &&
    typeof octave === 'number' &&
    Number.isInteger(octave) &&
    octave >= -1 &&
    octave <= 9
  ) {
    return { step: step as Spelling['step'], alter, octave }
  }
  return fallback
}

function condition(v: unknown, base: LabelCondition): LabelCondition {
  const r = obj(v)
  return {
    enabled: bool(r['enabled'], base.enabled),
    threshold: 'threshold' in r ? spellingOrNull(r['threshold'], base.threshold) : base.threshold,
  }
}

function rule(v: unknown, base: ClefLabelRule): ClefLabelRule {
  const r = obj(v)
  return { below: condition(r['below'], base.below), above: condition(r['above'], base.above) }
}

/** Rules merge per clef: stored clefs override the defaults, clefs only in defaults keep them. */
function rules(v: unknown, base: Readonly<Record<ClefKey, ClefLabelRule>>): Record<ClefKey, ClefLabelRule> {
  const stored = obj(v)
  const out: Record<ClefKey, ClefLabelRule> = {}
  for (const [clef, defaultRule] of Object.entries(base)) out[clef] = rule(stored[clef], defaultRule)
  for (const clef of Object.keys(stored)) {
    if (!(clef in out)) out[clef] = rule(stored[clef], DISABLED_RULE)
  }
  return out
}

function hintPedal(v: unknown, fallback: HintPedalMapping | null): HintPedalMapping | null {
  if (v === null) return null
  const r = obj(v)
  const controller = r['controller']
  if (typeof controller !== 'number' || !Number.isInteger(controller) || controller < 0 || controller > 127) {
    return fallback
  }
  const channel = r['channel'] === null ? null : int(r['channel'], -1, 0, 15)
  if (channel === -1) return fallback
  return {
    channel,
    controller,
    threshold: num(r['threshold'], 64, 0, 127),
    inverted: bool(r['inverted'], false),
    observedMin: num(r['observedMin'], 0, 0, 127),
    observedMax: num(r['observedMax'], 127, 0, 127),
    verified: bool(r['verified'], false),
  }
}

function controllers(v: unknown, fallback: readonly number[]): number[] {
  if (!Array.isArray(v)) return [...fallback]
  return [...new Set(v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 127))]
}

const MODES: readonly PersistentLabelMode[] = ['off', 'all', 'conditional']
const DESTINATIONS: readonly SoundDestination[] = ['auto', 'midi', 'browser']

/** The settings version that introduced the 'auto' sound destination. */
const AUTO_DESTINATION_VERSION = 2

/**
 * Before version 2, 'midi' was the default and the only alternative to browser sound, so a stored
 * 'midi' becomes 'auto' once (DECISIONS S4). Saved settings carry the current version, so a
 * 'midi' chosen afterwards is kept.
 */
function soundDestination(v: unknown, storedVersion: number, fallback: SoundDestination): SoundDestination {
  const destination = oneOf(v, DESTINATIONS, fallback)
  return destination === 'midi' && storedVersion < AUTO_DESTINATION_VERSION ? 'auto' : destination
}

/** The settings version that made one wrong attack the automatic-hint default. */
const ONE_MISTAKE_HINT_VERSION = 3
/** The automatic-hint threshold default before `ONE_MISTAKE_HINT_VERSION`. */
const OLD_DEFAULT_HINT_THRESHOLD = 2

/**
 * Before version 3 the automatic hint appeared after two wrong attacks by default, so a stored 2
 * becomes 1 (the new default) once. Saved settings carry the current version, so a 2 chosen
 * afterwards is kept, as is any other stored value.
 */
function autoThreshold(v: unknown, storedVersion: number, fallback: number | null): number | null {
  if (v === null) return null
  const threshold = int(v, fallback ?? 1, 1, 1000)
  return threshold === OLD_DEFAULT_HINT_THRESHOLD && storedVersion < ONE_MISTAKE_HINT_VERSION ? 1 : threshold
}

/**
 * Interpret a stored (or restored) settings value: every field is validated and falls back to
 * its `DEFAULT_SETTINGS` value when absent or malformed, so settings added in later versions
 * get defaults and a damaged value never throws. Label rules merge per clef (spec "Persistent
 * score labels": persisted with settings and included in export/restore).
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS
  const s = obj(raw)
  const naming = obj(s['naming'])
  const labels = obj(s['labels'])
  const hints = obj(s['hints'])
  const pedal = obj(s['pedal'])
  const route = obj(s['route'])
  const sound = obj(s['sound'])
  const metronome = obj(s['metronome'])
  const view = obj(s['view'])
  const suggestions = obj(s['suggestions'])
  const storedVersion = typeof s['version'] === 'number' ? s['version'] : 0

  return {
    version: SETTINGS_VERSION,
    naming: {
      system: oneOf(naming['system'], ['letter', 'fixed-do'], d.naming.system),
      seventh: oneOf(naming['seventh'], ['si', 'ti'], d.naming.seventh),
      showOctave: bool(naming['showOctave'], d.naming.showOctave),
      alwaysShowEffectiveAccidentals: bool(
        naming['alwaysShowEffectiveAccidentals'],
        d.naming.alwaysShowEffectiveAccidentals,
      ),
      simplifyEnharmonics: bool(naming['simplifyEnharmonics'], d.naming.simplifyEnharmonics),
    },
    labels: {
      mode: oneOf(labels['mode'], MODES, d.labels.mode),
      rules: rules(labels['rules'], d.labels.rules),
      tiedContinuations: bool(labels['tiedContinuations'], d.labels.tiedContinuations),
    },
    hints: {
      autoThreshold: autoThreshold(hints['autoThreshold'], storedVersion, d.hints.autoThreshold),
      lifetime:
        hints['lifetime'] === 'until-correct'
          ? 'until-correct'
          : num(hints['lifetime'], typeof d.hints.lifetime === 'number' ? d.hints.lifetime : 30, 0.1),
      fadeMs: num(hints['fadeMs'], d.hints.fadeMs, 0, 10_000),
      damageFlash: bool(hints['damageFlash'], d.hints.damageFlash),
    },
    pedal: {
      hintPedal: 'hintPedal' in pedal ? hintPedal(pedal['hintPedal'], d.pedal.hintPedal) : d.pedal.hintPedal,
      hintPedalAction: oneOf(pedal['hintPedalAction'], ['names', 'keys'], d.pedal.hintPedalAction),
      observedControllers: controllers(pedal['observedControllers'], d.pedal.observedControllers),
    },
    route: {
      inputId: strOrNull(route['inputId'], d.route.inputId),
      inputName: strOrNull(route['inputName'], d.route.inputName),
      outputId: strOrNull(route['outputId'], d.route.outputId),
      outputName: strOrNull(route['outputName'], d.route.outputName),
      outputChannel: int(route['outputChannel'], d.route.outputChannel, 0, 15),
      outputVerified: bool(route['outputVerified'], d.route.outputVerified),
      echo: oneOf(route['echo'], ['untested', 'none', 'echo-detected'], d.route.echo),
      automaticPedalsInHandPractice: bool(
        route['automaticPedalsInHandPractice'],
        d.route.automaticPedalsInHandPractice,
      ),
      accompanimentLevel: num(route['accompanimentLevel'], d.route.accompanimentLevel, 0, 1),
      connection: oneOf(route['connection'], ['usb', 'bluetooth', 'unknown'], d.route.connection),
    },
    sound: {
      destination: soundDestination(sound['destination'], storedVersion, d.sound.destination),
      browserVolume: num(sound['browserVolume'], d.sound.browserVolume, 0, 1),
      monitorInput: bool(sound['monitorInput'], d.sound.monitorInput),
    },
    metronome: {
      enabled: bool(metronome['enabled'], d.metronome.enabled),
      volume: num(metronome['volume'], d.metronome.volume, 0, 1),
    },
    view: {
      zoom: num(view['zoom'], d.view.zoom, 0.1, 20),
      pageZoom: num(view['pageZoom'], d.view.pageZoom, 0.1, 20),
      theme: oneOf(view['theme'], ['system', 'light', 'dark'], d.view.theme),
      scorePaper: oneOf(view['scorePaper'], ['theme', 'light'], d.view.scorePaper),
    },
    suggestions: { enabled: bool(suggestions['enabled'], d.suggestions.enabled) },
  }
}
