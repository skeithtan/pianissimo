#!/usr/bin/env node
/**
 * The check for one change: fast, and one line per step so its output stays small (DECISIONS D19).
 *
 *   npm run check                                types, formatting and the unit tests your changes reach
 *   npm run check -- practice-review             the same, then one browser spec in Chromium
 *   npm run check -- practice-review -g "title"  only the matching browser tests
 *   npm run check -- practice-review --webkit    in WebKit instead
 *   npm run check -- --since origin/main         every change since a ref, instead of uncommitted work
 *
 * The two slow microphone test files (about a minute) run only when a changed file is theirs. The
 * whole suite in both browsers is CI's job. Failures print a short excerpt; the rest is in the log folder.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_FAILURES = 3
const MAX_LINES = 12
const SLOW_TESTS = ['src/core/audio/follower.test.ts', 'src/core/audio/sampled.test.ts']
const AUDIO_FILES = /^(src\/core\/audio\/|src\/workers\/follower)/

const args = process.argv.slice(2)
const takeValue = (...names) => {
  const at = args.findIndex((arg) => names.includes(arg))
  return at < 0 ? undefined : args.splice(at, 2)[1]
}
const takeFlag = (name) => {
  const at = args.indexOf(name)
  if (at >= 0) args.splice(at, 1)
  return at >= 0
}
const grep = takeValue('-g', '--grep')
const since = takeValue('--since') ?? 'HEAD'
const project = takeFlag('--webkit') ? 'webkit' : 'chromium'
const specs = args

const unknown = specs.find((spec) => spec.startsWith('-'))
if (unknown) {
  console.log(`Unknown option ${unknown}`)
  process.exit(2)
}
if (grep !== undefined && specs.length === 0) {
  console.log('-g needs a browser spec name')
  process.exit(2)
}

const logs = mkdtempSync(join(tmpdir(), 'pianissimo-check-'))
const bin = (name) => join('node_modules', '.bin', name)
const git = (...params) => execFileSync('git', params, { encoding: 'utf8' }).split('\0').filter(Boolean)

function changedFiles() {
  const base =
    since === 'HEAD' ? 'HEAD' : execFileSync('git', ['merge-base', since, 'HEAD'], { encoding: 'utf8' }).trim()
  const tracked = git('diff', '--name-only', '--diff-filter=d', '-z', base)
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
  return [...new Set([...tracked, ...untracked])].filter((file) => existsSync(file))
}

function run(name, command, params, env = {}) {
  const started = Date.now()
  const path = join(logs, `${name}.log`)
  return new Promise((done) => {
    const log = createWriteStream(path)
    const child = spawn(command, params, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    const finish = (code) => log.end(() => done({ code, path, seconds: (Date.now() - started) / 1000 }))
    child.on('error', (error) => {
      log.write(`${error.message}\n`)
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

// eslint-disable-next-line no-control-regex
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '')
const excerpt = (text) => {
  const lines = plain(text)
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s+at (?!.*\/(src|tests)\/)/.test(line))
    .map((line) => line.replaceAll(`${process.cwd()}/`, ''))
  const shown = lines.slice(0, MAX_LINES).map((line) => `    ${line.slice(0, 180)}`)
  return lines.length > MAX_LINES ? [...shown, `    … ${lines.length - MAX_LINES} more lines`] : shown
}

function report(label, result, summary, failures = []) {
  const ok = result.code === 0
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${summary} (${result.seconds.toFixed(1)} s)`)
  if (ok) return true
  for (const { title, text } of failures.slice(0, MAX_FAILURES)) {
    console.log(`  ${title}`)
    for (const line of excerpt(text)) console.log(line)
  }
  if (failures.length > MAX_FAILURES) console.log(`  … ${failures.length - MAX_FAILURES} more failures`)
  console.log(`  log: ${result.path}`)
  return false
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function checkTypes() {
  const results = await Promise.all(
    ['app', 'worker', 'test'].map((name) =>
      run(`types-${name}`, bin('tsc'), ['-p', `tsconfig.${name}.json`, '--noEmit']),
    ),
  )
  const failed = results.filter((result) => result.code !== 0)
  const seconds = Math.max(...results.map((result) => result.seconds))
  const failures = failed.map((result) => ({ title: 'tsc', text: readFileSync(result.path, 'utf8') }))
  const summary = failed.length === 0 ? 'clean' : 'errors'
  return report('types', { code: failed.length, path: failed[0]?.path, seconds }, summary, failures)
}

async function checkFormat(files) {
  const formatted = files.filter((file) => /\.(tsx?|mjs)$/.test(file))
  if (formatted.length === 0) return true
  const result = await run('format', bin('prettier'), ['--list-different', ...formatted])
  const text = readFileSync(result.path, 'utf8')
  return report('format', result, `${formatted.length} changed files`, [{ title: 'run npm run format', text }])
}

async function checkUnit(files) {
  const sources = files.filter((file) => /\.tsx?$/.test(file) && !file.startsWith('tests/e2e/'))
  if (sources.length === 0) {
    console.log('ok   unit: no changed file has unit tests')
    return true
  }
  const audio = sources.some((file) => AUDIO_FILES.test(file))
  const json = join(logs, 'unit.json')
  const result = await run('unit', bin('vitest'), [
    'related',
    ...sources,
    '--run',
    '--passWithNoTests',
    '--reporter=json',
    `--outputFile=${json}`,
    ...(audio ? [] : SLOW_TESTS.map((test) => `--exclude=${test}`)),
  ])
  const data = readJson(json)
  const failures = (data?.testResults ?? []).flatMap((file) => {
    const failed = file.assertionResults.filter((test) => test.status === 'failed')
    if (failed.length === 0 && file.status === 'failed') return [{ title: file.name, text: file.message ?? '' }]
    return failed.map((test) => ({ title: test.fullName, text: test.failureMessages.join('\n') }))
  })
  if (result.code !== 0 && failures.length === 0) {
    failures.push({ title: 'vitest', text: readFileSync(result.path, 'utf8').slice(-2000) })
  }
  const summary = `${data?.numPassedTests ?? 0} passed, ${data?.numFailedTests ?? 0} failed${audio ? '' : ', slow audio skipped'}`
  return report('unit', result, summary, failures)
}

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer()
    server.on('error', fail)
    server.listen(0, () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

function browserTests(suite, titles = []) {
  const path = suite.file && suite.title === suite.file ? titles : [...titles, suite.title].filter(Boolean)
  return [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests.map((test) => ({
        title: [...path, spec.title].join(' › '),
        status: test.status,
        results: test.results,
      })),
    ),
    ...(suite.suites ?? []).flatMap((child) => browserTests(child, path)),
  ]
}

async function checkBrowser() {
  const json = join(logs, 'browser.json')
  // Fresh ports: never a preview server another checkout left running.
  const [app, harness] = [await freePort(), await freePort()]
  const result = await run(
    'browser',
    bin('playwright'),
    [
      'test',
      ...specs,
      `--project=${project}`,
      '--reporter=json',
      `--max-failures=${MAX_FAILURES}`,
      `--output=${join(logs, 'results')}`,
      ...(grep === undefined ? [] : ['-g', grep]),
    ],
    {
      APP_PORT: String(app),
      HARNESS_PORT: String(harness),
      PLAYWRIGHT_JSON_OUTPUT_NAME: json,
      PLAYWRIGHT_JSON_OUTPUT_FILE: json,
    },
  )
  const data = readJson(json)
  const tests = (data?.suites ?? []).flatMap((suite) => browserTests(suite))
  const failed = tests.filter((test) => test.status === 'unexpected')
  const failures = [
    ...failed.map((test) => ({
      title: test.title,
      text: test.results.flatMap((attempt) => attempt.errors.map((error) => error.message ?? '')).join('\n'),
    })),
    ...(data?.errors ?? []).map((error) => ({ title: 'playwright', text: error.message ?? '' })),
  ]
  if (result.code !== 0 && failures.length === 0) {
    failures.push({ title: 'playwright', text: readFileSync(result.path, 'utf8').slice(-2000) })
  }
  const passed = tests.filter((test) => test.status === 'expected').length
  return report(`${project} ${specs.join(' ')}`, result, `${passed} passed, ${failed.length} failed`, failures)
}

const files = changedFiles()
const quick = await Promise.all([checkTypes(), checkFormat(files), checkUnit(files)])
const passed = quick.every(Boolean) && (specs.length === 0 || (await checkBrowser()))
process.exit(passed ? 0 : 1)
