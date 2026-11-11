/**
 * Play-through through the microphone (DECISIONS P15, P16), end to end in the browser: the real
 * AudioWorklet, follower worker and session, with no MIDI at all. Only the microphone is
 * replaced: `getUserMedia` returns a stream that plays a synthesized performance of the seeded
 * piece, with a stop in the middle, so the cursor has both something to follow and something to
 * wait for.
 */
import { expect, test, type Page } from '@playwright/test'
import { perform } from '../../src/core/audio/evaluate'
import { attackGroups } from '../../src/core/audio/templates'
import { renderNotes } from '../../src/core/audio/testkit'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { importFixture } from '../unit/import/fixtures'
import { openFooterMenu, openSeededPractice, seedPiece } from './practice-helpers'

const SAMPLE_RATE = 48000
/** Seconds of silence before the first note, and of the stop before the fourth group. */
const LEAD = 3
const STOP = 4

declare global {
  interface Window {
    /** `performance.now()` when the fake microphone began to play. */
    __micStartedAt?: number
  }
}

/** The performance as base64 16-bit PCM, the pitches of each onset group and when each is struck. */
async function playing(): Promise<{ pcm: string; groups: number[][]; times: number[]; pitches: number[] }> {
  const { model } = (await importFixture('two-hands.musicxml')).package
  const perf = perform(model, model.tempo, {
    factor: 1,
    lead: LEAD,
    jitter: 0,
    hesitations: [{ at: 0.5, seconds: STOP, held: true }],
  })
  const audio = renderNotes(perf.notes, { sampleRate: SAMPLE_RATE })
  const pcm = new Int16Array(audio.length)
  for (let i = 0; i < audio.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i]! * 32767)))
  return {
    pcm: Buffer.from(pcm.buffer).toString('base64'),
    groups: attackGroups(model).map((g) => [...g.pitches]),
    times: perf.onsets.map((o) => o.time),
    pitches: model.notes.map((n) => n.midi),
  }
}

/**
 * Replaces the microphone with a stream playing `pcm` from the moment it is asked for. The audio
 * context behind it is started at the first click or key press, as browsers that only start
 * audio on a user gesture require.
 */
async function installFakeMicrophone(page: Page, pcm: string): Promise<void> {
  await page.addInitScript(
    ({ pcm, sampleRate }) => {
      const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0))
      const samples = new Int16Array(bytes.buffer)
      let ctx: AudioContext | null = null
      const wake = (): AudioContext => {
        ctx ??= new AudioContext({ sampleRate })
        void ctx.resume().catch(() => undefined)
        return ctx
      }
      for (const type of ['pointerdown', 'mousedown', 'click', 'keydown']) document.addEventListener(type, wake, true)
      const getUserMedia = async (): Promise<MediaStream> => {
        const ctx = wake()
        const buffer = ctx.createBuffer(1, samples.length, sampleRate)
        const channel = buffer.getChannelData(0)
        for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 32768
        const source = ctx.createBufferSource()
        source.buffer = buffer
        const out = ctx.createMediaStreamDestination()
        source.connect(out)
        source.start()
        window.__micStartedAt = performance.now()
        return out.stream
      }
      // On the prototype and on the object: engines differ in where the method is looked up.
      for (const target of [MediaDevices.prototype, navigator.mediaDevices]) {
        Object.defineProperty(target, 'getUserMedia', { configurable: true, writable: true, value: getUserMedia })
      }
    },
    { pcm, sampleRate: SAMPLE_RATE },
  )
}

interface Snapshot {
  /** Seconds of the performance the fake microphone has played. */
  heard: number
  /** Pitches of the notes at the cursor (the group expected next), ascending. */
  targets: number[]
}

/** Both readings in one task of the page, so `heard` says when the cursor was where `targets` has it. */
function snapshot(page: Page, pitches: readonly number[]): Promise<Snapshot> {
  return page.evaluate(
    (pitches) => ({
      heard: window.__micStartedAt === undefined ? -1 : (performance.now() - window.__micStartedAt) / 1000,
      targets: [
        ...new Set(
          [...document.querySelectorAll('.pn-music .pn-target:not(.pn-acc)')].flatMap((el) =>
            (el.getAttribute('data-n') ?? '')
              .split(' ')
              .filter(Boolean)
              .map((n) => pitches[Number(n)]!),
          ),
        ),
      ].sort((a, b) => a - b),
    }),
    pitches,
  )
}

/**
 * For polls whose sample time matters: every 100 ms, not Playwright's default back-off to one
 * poll a second, which is coarser than the windows below.
 */
const OFTEN = { timeout: 20_000, intervals: [100] }

test('the cursor follows an acoustic piano through the microphone and waits while the player stops', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { pcm, groups, times, pitches } = await playing()
  expect(groups.length).toBe(6)
  await installFakeMicrophone(page, pcm)
  // No MIDI anywhere: the microphone stands in for the piano.
  await seedPiece(page, { mic: { follow: true }, metronome: { ...DEFAULT_SETTINGS.metronome, enabled: true } })
  await openSeededPractice(page)
  const menu = await openFooterMenu(page)
  await menu.getByRole('switch', { name: 'Play through' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByTestId('mic-status')).toContainText('Following through the microphone.')

  // Each poll keeps the snapshot it took, so the checks after it look at the sample that ended it
  // (time and cursor read together) rather than at a later read.
  let now = await snapshot(page, pitches)
  const take = async (): Promise<Snapshot> => (now = await snapshot(page, pitches))

  // Before the first note the cursor stays at the first group.
  await expect.poll(async () => (await take()).heard, OFTEN).toBeGreaterThan(0.5)
  expect(now.heard).toBeLessThan(times[0]!)
  expect(now.targets).toEqual(groups[0])

  // The first three groups are played a second apart: after each the cursor is at the next. The
  // poll that first sees it at the fourth group comes at most 100 ms (plus a round trip) after.
  await expect.poll(async () => (await take()).targets, OFTEN).toEqual(groups[3])
  expect(now.heard).toBeGreaterThan(times[2]!)
  expect(now.heard).toBeLessThan(times[2]! + 1)

  // The player stops with the keys held: the cursor waits, however long the chord rings. The
  // sample that ends this poll falls in the last half second before the player resumes.
  await expect.poll(async () => (await take()).heard, OFTEN).toBeGreaterThan(times[3]! - 0.5)
  expect(now.heard).toBeLessThan(times[3]!)
  expect(now.targets).toEqual(groups[3])

  // And goes on with the player to the end of the piece.
  await expect.poll(async () => (await take()).targets, { timeout: 20_000 }).toEqual(groups[5])
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible({ timeout: 20_000 })
  expect((await take()).heard).toBeGreaterThan(times[5]!)
})
