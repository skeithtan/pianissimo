/**
 * Shape checks for records read back from a backup (and for records handed to `putPiece`).
 * Each returns the first problem as readable text, or null when the record is usable. They
 * check structure the app relies on, not every field of the large score model.
 */
import { SCORE_PACKAGE_FORMAT } from '../model/score'

type Raw = Readonly<Record<string, unknown>>

export const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isStr = (v: unknown): v is string => typeof v === 'string'
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
export const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isOneOf = (v: unknown, list: readonly string[]): boolean => typeof v === 'string' && list.includes(v)

const HANDS = ['both', 'right', 'left', 'none']
const COMPLETIONS = ['completed', 'interrupted', 'abandoned']
const REASONS = [
  'pause',
  'seek',
  'disconnect',
  'suspend',
  'setting-change',
  'layout-change',
  'tempo-change',
  'hand-change',
  'range-change',
  'mode-change',
  'user-stop',
  'user-restart',
]

function rational(v: unknown): boolean {
  return isObj(v) && isInt(v['n']) && isInt(v['d']) && v['d'] !== 0
}

/** Whole bars, optionally with exact note-level edges (`start` / `end` rationals, U21). */
function passage(v: unknown): boolean {
  return (
    isObj(v) &&
    isInt(v['fromOcc']) &&
    isInt(v['toOcc']) &&
    (v['fromOcc'] as number) <= (v['toOcc'] as number) &&
    (v['start'] === undefined || rational(v['start'])) &&
    (v['end'] === undefined || rational(v['end']))
  )
}

/** A speed ladder: finite multipliers, goal in [0.05, 10], step in (0, 1]. */
export function ladderOk(v: unknown): boolean {
  if (!isObj(v)) return false
  const goal = v['goal']
  const step = v['step']
  return isNum(goal) && goal >= 0.05 && goal <= 10 && isNum(step) && step > 0 && step <= 1
}

/** First failing field among `[name, ok]` pairs, as "name is not valid". */
function firstBad(checks: ReadonlyArray<readonly [string, boolean]>): string | null {
  for (const [name, ok] of checks) if (!ok) return `${name} is missing or invalid`
  return null
}

export function pieceProblem(v: unknown): string | null {
  if (!isObj(v)) return 'is not an object'
  const tempo = v['userTempo']
  const resume = v['resume']
  return firstBad([
    ['id', isStr(v['id']) && v['id'] !== ''],
    ['title', isStr(v['title'])],
    ['composer', v['composer'] === undefined || isStr(v['composer'])],
    ['scoreVersionId', isStr(v['scoreVersionId']) && v['scoreVersionId'] !== ''],
    ['createdAt', isNum(v['createdAt'])],
    ['lastOpenedAt', isNum(v['lastOpenedAt'])],
    ['lastMultiplier', isNum(v['lastMultiplier']) && (v['lastMultiplier'] as number) > 0],
    [
      'userTempo',
      tempo === undefined ||
        (isObj(tempo) && isNum(tempo['beatBpm']) && (tempo['beatBpm'] as number) > 0 && rational(tempo['beatUnit'])),
    ],
    ['lastHands', isOneOf(v['lastHands'], HANDS)],
    [
      'resume',
      resume === null ||
        (isObj(resume) &&
          isInt(resume['occ']) &&
          rational(resume['position']) &&
          (resume['group'] === undefined || isInt(resume['group'])) &&
          isOneOf(resume['hands'], HANDS) &&
          isNum(resume['multiplier']) &&
          isNum(resume['savedAt'])),
    ],
    ['lastPassage', v['lastPassage'] === null || passage(v['lastPassage'])],
    ['repeatTarget', v['repeatTarget'] === null || (isInt(v['repeatTarget']) && (v['repeatTarget'] as number) >= 1)],
    ['ladder', v['ladder'] === undefined || v['ladder'] === null || ladderOk(v['ladder'])],
    ['rhythm', v['rhythm'] === undefined || isBool(v['rhythm'])],
  ])
}

function contextProblem(v: unknown): string | null {
  if (!isObj(v)) return 'context is not an object'
  return firstBad([
    ['context.scoreVersionId', isStr(v['scoreVersionId'])],
    ['context.passage', passage(v['passage'])],
    ['context.hands', isOneOf(v['hands'], HANDS)],
    ['context.handsId', isStr(v['handsId'])],
    ['context.tempoMapId', isStr(v['tempoMapId'])],
    ['context.multiplier', isNum(v['multiplier']) && (v['multiplier'] as number) > 0],
    ['context.rollPolicy', isStr(v['rollPolicy'])],
    ['context.transport', isOneOf(v['transport'], ['free', 'accompaniment', 'strict'])],
    ['context.matchingRules', isStr(v['matchingRules'])],
  ])
}

function traversalOk(t: unknown): boolean {
  return (
    isObj(t) &&
    isInt(t['occ']) &&
    isBool(t['complete']) &&
    isNum(t['wrongAttacks']) &&
    isNum(t['wrongAttacksExcludingBoundary']) &&
    isNum(t['groupsWithErrors']) &&
    isBool(t['tempHint']) &&
    isBool(t['persistentLabel']) &&
    isBool(t['keyboard'])
  )
}

const numArray = (v: unknown): boolean => Array.isArray(v) && v.every(isNum)

export function attemptProblem(v: unknown): string | null {
  if (!isObj(v)) return 'is not an object'
  const a = v['assistance']
  const base = firstBad([
    ['id', isStr(v['id']) && v['id'] !== ''],
    ['pieceId', isStr(v['pieceId']) && v['pieceId'] !== ''],
    ['createdAt', isNum(v['createdAt'])],
    ['kind', isOneOf(v['kind'], ['scored', 'reading'])],
    ['contextKey', isStr(v['contextKey'])],
    ['completion', isOneOf(v['completion'], COMPLETIONS)],
    ['interruptReason', v['interruptReason'] === undefined || isOneOf(v['interruptReason'], REASONS)],
    ['wrongAttacks', isNum(v['wrongAttacks'])],
    ['earlyAttacks', v['earlyAttacks'] === undefined || isNum(v['earlyAttacks'])],
    ['groupsTotal', isNum(v['groupsTotal'])],
    ['groupsFirstPass', isNum(v['groupsFirstPass'])],
    ['completionTimeSec', v['completionTimeSec'] === undefined || isNum(v['completionTimeSec'])],
    ['expectedTimeSec', v['expectedTimeSec'] === null || isNum(v['expectedTimeSec'])],
    ['notatedDurationSec', v['notatedDurationSec'] === null || isNum(v['notatedDurationSec'])],
    ['passed', isBool(v['passed'])],
    ['onsets', Array.isArray(v['onsets']) && v['onsets'].every((o) => isObj(o) && isNum(o['group']) && isNum(o['t']))],
    ['measures', Array.isArray(v['measures']) && v['measures'].every(traversalOk)],
    [
      'assistance',
      isObj(a) &&
        isOneOf(a['level'], ['none', 'names', 'keyboard']) &&
        numArray(a['persistentLabelNotes']) &&
        numArray(a['persistentLabelGroups']) &&
        isNum(a['hintRequests']) &&
        isNum(a['autoHints']) &&
        numArray(a['hintGroups']) &&
        isBool(a['keyboardShown']) &&
        isObj(a['labelSettings']),
    ],
  ])
  return base ?? contextProblem(v['context'])
}

export function barProblem(v: unknown): string | null {
  if (!isObj(v)) return 'is not an object'
  return firstBad([
    ['pieceId', isStr(v['pieceId'])],
    ['measureContextKey', isStr(v['measureContextKey'])],
    ['occ', isInt(v['occ'])],
    [
      'recent',
      Array.isArray(v['recent']) &&
        v['recent'].length <= 5 &&
        v['recent'].every(
          (s) =>
            isObj(s) && isNum(s['at']) && isStr(s['attemptId']) && isBool(s['errorBearing']) && isBool(s['assisted']),
        ),
    ],
    ['cleanStreak', isInt(v['cleanStreak']) && (v['cleanStreak'] as number) >= 0],
    ['lastAttemptId', isStr(v['lastAttemptId'])],
    ['updatedAt', isNum(v['updatedAt'])],
  ])
}

function suggestionOk(s: unknown): boolean {
  return (
    isObj(s) &&
    isStr(s['id']) &&
    isOneOf(s['kind'], ['traversal', 'restart']) &&
    isOneOf(s['status'], ['active', 'improved']) &&
    isStr(s['measureContextKey']) &&
    isObj(s['context']) &&
    isStr(s['context']['scoreVersionId']) &&
    isOneOf(s['context']['hands'], HANDS) &&
    isNum(s['context']['multiplier']) &&
    isInt(s['coreFrom']) &&
    isInt(s['coreTo']) &&
    (s['coreFrom'] as number) <= (s['coreTo'] as number) &&
    isNum(s['createdAt']) &&
    isNum(s['updatedAt']) &&
    (s['improvedAt'] === undefined || isNum(s['improvedAt']))
  )
}

export function suggestionStateProblem(v: unknown): string | null {
  if (!isObj(v)) return 'is not an object'
  return firstBad([
    ['pieceId', isStr(v['pieceId'])],
    ['disabled', isBool(v['disabled'])],
    ['suggestions', Array.isArray(v['suggestions']) && v['suggestions'].every(suggestionOk)],
  ])
}

export function abandonProblem(v: unknown): string | null {
  if (!isObj(v)) return 'is not an object'
  return firstBad([
    ['pieceId', isStr(v['pieceId'])],
    ['measureContextKey', isStr(v['measureContextKey'])],
    ['occ', isInt(v['occ'])],
    [
      'events',
      Array.isArray(v['events']) &&
        v['events'].every(
          (e) =>
            isObj(e) &&
            isStr(e['pieceId']) &&
            isStr(e['measureContextKey']) &&
            isInt(e['occ']) &&
            isNum(e['at']) &&
            isOneOf(e['reason'], REASONS),
        ),
    ],
  ])
}

/** A package must be a `ScorePackage` of the format this app reads. */
export function packageProblem(v: unknown): string | null {
  if (!isObj(v)) return 'is not an object'
  const m = v['model']
  if (!isObj(m)) return 'model is missing'
  if (m['format'] !== SCORE_PACKAGE_FORMAT) {
    return `score package format ${String(m['format'])} is not supported (this app reads format ${SCORE_PACKAGE_FORMAT})`
  }
  return (
    firstBad([
      ['model.scoreVersionId', isStr(m['scoreVersionId']) && m['scoreVersionId'] !== ''],
      ['model.meta', isObj(m['meta']) && isStr(m['meta']['title'])],
      ['model.occurrences', Array.isArray(m['occurrences'])],
      ['model.notes', Array.isArray(m['notes'])],
      ['model.tempo', isObj(m['tempo']) && Array.isArray(m['tempo']['segments'])],
      ['model.hands', isObj(m['hands'])],
      ['renderXml', isStr(v['renderXml'])],
    ]) ?? null
  )
}

export function sourceMetaProblem(v: unknown): string | null {
  if (!isObj(v)) return 'is not an object'
  return firstBad([
    ['scoreVersionId', isStr(v['scoreVersionId']) && v['scoreVersionId'] !== ''],
    ['fileName', isStr(v['fileName'])],
    ['packaging', isOneOf(v['packaging'], ['musicxml', 'mxl', 'xml'])],
    ['sha256', isStr(v['sha256'])],
    ['file', isStr(v['file'])],
    ['size', isInt(v['size']) && (v['size'] as number) >= 0],
    ['bytesSha256', v['bytesSha256'] === undefined || isStr(v['bytesSha256'])],
  ])
}
