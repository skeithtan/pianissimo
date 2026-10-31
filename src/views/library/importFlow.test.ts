import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { fixtureBytes } from '../../../tests/unit/import/fixtures'
import { hasTempo } from '../../core/music/tempo'
import type { PieceRecord } from '../../core/storage/records'
import {
  ImportFlow,
  resetPersistenceRequestForTests,
  type FlowMode,
  type FlowPhase,
  type StorageStatus,
} from './importFlow'
import { initialDraft } from './review'
import { bytesFile, testDeps, tick, type TestDeps } from './testkit'

const file = (name: string) => bytesFile(name, fixtureBytes(name))

let deps: TestDeps
beforeEach(async () => {
  resetPersistenceRequestForTests()
  deps = await testDeps()
})

function review(flow: ImportFlow): Extract<FlowPhase, { kind: 'review' }> {
  const p = flow.phase.value
  if (p.kind !== 'review') throw new Error(`expected review, got ${p.kind}`)
  return p
}

/** The saves a flow reported through `onSaved`. */
interface Saved {
  piece: PieceRecord
  replaced: boolean
  storage: Promise<StorageStatus>
}
function savingFlow(mode: FlowMode = { kind: 'new' }): { flow: ImportFlow; saved: Saved[] } {
  const saved: Saved[] = []
  const flow = new ImportFlow(deps, mode, (piece, info) => saved.push({ piece, ...info }))
  return { flow, saved }
}

/** Record every phase the flow shows. */
function trace(flow: ImportFlow): string[] {
  const seen: string[] = []
  flow.phase.subscribe((p) => seen.push(p.kind))
  return seen
}

describe('ImportFlow', () => {
  it('goes straight from a single piano part to the summary, then saves in one commit', async () => {
    const { flow, saved } = savingFlow()
    const phases = trace(flow)
    await flow.openFile(file('two-hands.musicxml'))
    expect(deps.client.calls).toEqual(['inspect', 'build:P1'])
    const r = review(flow)
    expect(r.choiceOffered).toBe(false)
    expect(r.result.summary.readiness.scoredPractice).toBe(true)
    expect(phases).toContain('working')

    await flow.save(initialDraft(r.result.summary, r.result.package.model))
    // Saved: the sheet closes (idle) and the save is reported once, with no confirmation screen (L6).
    expect(flow.phase.value.kind).toBe('idle')
    expect(phases.at(-1)).toBe('idle')
    expect(saved).toHaveLength(1)
    const done = saved[0]!
    expect(done.replaced).toBe(false)
    expect(done.piece.title).toBe(r.result.summary.title)
    expect(done.piece.lastOpenedAt).toBe(deps.clock)
    // Persistence is requested once, after the first import, and the quota is reported.
    expect(deps.manager.persistCalls).toBe(1)
    expect(await done.storage).toEqual({
      persistence: 'granted',
      estimate: { usageBytes: 1_500_000, quotaBytes: 2_000_000_000, fraction: 0.00075 },
    })

    const pieces = await deps.storage.listPieces()
    expect(pieces.map((p) => p.id)).toEqual([done.piece.id])
    const pkg = await deps.storage.getPackage(done.piece.scoreVersionId)
    expect(pkg?.model.scoreVersionId).toBe(done.piece.scoreVersionId)
    const source = await deps.storage.getSource(done.piece.scoreVersionId)
    expect(source?.bytes.byteLength).toBe(fixtureBytes('two-hands.musicxml').byteLength)
    // The worker client is released after saving.
    expect(deps.client.disposed).toBe(1)

    // A second import does not ask again.
    const again = savingFlow()
    await again.flow.openFile(file('ties.musicxml'))
    await again.flow.save(initialDraft(review(again.flow).result.summary, review(again.flow).result.package.model))
    expect(deps.manager.persistCalls).toBe(1)
    expect(again.saved).toHaveLength(1)
    expect((await again.saved[0]!.storage).persistence).toBe('granted')
  })

  it('offers the part choice when there is one, and validates it before building', async () => {
    const flow = new ImportFlow(deps, { kind: 'new' })
    await flow.openFile(file('two-parts.musicxml'))
    let p = flow.phase.value
    expect(p.kind).toBe('choose')
    if (p.kind !== 'choose') return
    expect(p.partIds).toEqual(['P2', 'P3'])
    flow.togglePart('P1')
    expect(flow.choiceProblem()).toMatch(/one two-staff piano part/)
    await flow.confirmChoice()
    p = flow.phase.value
    expect(p.kind === 'choose' && p.error).toMatch(/one two-staff piano part/)
    expect(deps.client.calls).toEqual(['inspect']) // nothing built

    flow.togglePart('P1')
    await flow.confirmChoice()
    const r = review(flow)
    expect(r.choiceOffered).toBe(true)
    expect(r.result.summary.parts.map((x) => x.id)).toEqual(['P2', 'P3'])

    flow.backToChoice()
    p = flow.phase.value
    expect(p.kind === 'choose' && p.partIds).toEqual(['P2', 'P3'])
  })

  it('a canceled inspect never updates the flow again, even if the client answers late', async () => {
    deps.client.hold = true
    deps.client.lateResults = true
    const flow = new ImportFlow(deps, { kind: 'new' })
    const phases = trace(flow)
    const running = flow.openFile(file('two-hands.musicxml'))
    await tick()
    expect(flow.phase.value.kind).toBe('working')
    flow.cancel()
    expect(flow.phase.value).toEqual({ kind: 'idle' })
    const before = phases.length
    deps.client.releaseAll()
    await running
    await tick(5)
    expect(flow.phase.value).toEqual({ kind: 'idle' })
    expect(phases.length).toBe(before)
    expect(deps.client.calls).toEqual(['inspect']) // no build followed
  })

  it('a canceled build never shows its summary', async () => {
    const flow = new ImportFlow(deps, { kind: 'new' })
    await flow.openFile(file('two-parts.musicxml'))
    deps.client.hold = true
    deps.client.lateResults = true
    const building = flow.confirmChoice()
    await tick()
    const p = flow.phase.value
    expect(p.kind === 'working' && p.step).toBe('building')
    flow.close()
    deps.client.releaseAll()
    await building
    await tick(5)
    expect(flow.phase.value).toEqual({ kind: 'idle' })
    expect(deps.client.disposed).toBe(1)
    expect(await deps.storage.listPieces()).toEqual([])
  })

  it('a well-behaved client rejects on abort and the flow stays idle', async () => {
    deps.client.hold = true
    const flow = new ImportFlow(deps, { kind: 'new' })
    const running = flow.openFile(file('two-hands.musicxml'))
    await tick()
    flow.cancel()
    await running
    expect(flow.phase.value).toEqual({ kind: 'idle' })
  })

  it('reports unrelated XML and malformed files readably', async () => {
    const flow = new ImportFlow(deps, { kind: 'new' })
    await flow.openFile(file('unrelated.xml'))
    let p = flow.phase.value
    expect(p.kind).toBe('failed')
    expect(p.kind === 'failed' && p.message).toMatch(/MusicXML/i)

    await flow.openFile(file('malformed.musicxml'))
    p = flow.phase.value
    expect(p.kind).toBe('failed')
    expect(p.kind === 'failed' && p.message.length).toBeGreaterThan(10)
  })

  it('refuses files over the size limit before reading them', async () => {
    const flow = new ImportFlow(deps, { kind: 'new' })
    let read = false
    await flow.openFile({
      name: 'huge.musicxml',
      size: 200 * 1024 * 1024,
      arrayBuffer: async () => {
        read = true
        return new ArrayBuffer(0)
      },
    })
    const p = flow.phase.value
    expect(p.kind === 'failed' && p.message).toMatch(/larger than 32 MB/)
    expect(read).toBe(false)
  })

  it('will not save until hands are confirmed and a tempo is entered', async () => {
    const { flow, saved } = savingFlow()
    await flow.openFile(file('no-tempo.musicxml'))
    const r = review(flow)
    const draft = initialDraft(r.result.summary, r.result.package.model)
    await flow.save(draft)
    expect(review(flow).saveError).toMatch(/practice tempo/)
    expect(await deps.storage.listPieces()).toEqual([])

    await flow.save({ ...draft, bpmText: '84' })
    const done = saved[0]!
    expect(done.piece.userTempo).toEqual({ beatBpm: 84, beatUnit: { n: 1, d: 4 } })
    const pkg = await deps.storage.getPackage(done.piece.scoreVersionId)
    expect(pkg && hasTempo(pkg.model.tempo)).toBe(true)
  })

  it('stores the chosen hand for a voice split between the staves', async () => {
    const { flow, saved } = savingFlow()
    await flow.openFile(file('split-voice.musicxml'))
    const r = review(flow)
    const v = r.result.summary.voices.find((x) => x.ambiguous)!
    const draft = initialDraft(r.result.summary, r.result.package.model)
    await flow.save(draft)
    expect(review(flow).saveError).toMatch(/Choose which hand/)
    await flow.save({ ...draft, hands: { ...draft.hands, [v.key]: 'R' }, handsConfirmed: true })
    const done = saved[0]!
    const pkg = await deps.storage.getPackage(done.piece.scoreVersionId)
    expect(pkg?.model.hands.confirmed).toBe(true)
    expect(pkg?.model.hands.byVoice[v.key]).toBe('R')
  })

  it('replaces a piece’s score: same piece, new version, positions reset, old version released', async () => {
    const first = savingFlow()
    await first.flow.openFile(file('two-hands.musicxml'))
    await first.flow.save(initialDraft(review(first.flow).result.summary, review(first.flow).result.package.model))
    const saved = first.saved[0]!
    const old = await deps.storage.updatePiece(saved.piece.id, {
      lastMultiplier: 0.75,
      lastPassage: { fromOcc: 0, toOcc: 1 },
    })

    deps.clock += 1000
    const replacing = savingFlow({ kind: 'replace', piece: old! })
    const flow = replacing.flow
    await flow.openFile(file('ties.musicxml'))
    await flow.save(initialDraft(review(flow).result.summary, review(flow).result.package.model))
    const done = replacing.saved[0]!
    expect(done.replaced).toBe(true)
    expect(done.piece.id).toBe(saved.piece.id)
    expect(done.piece.scoreVersionId).not.toBe(saved.piece.scoreVersionId)
    expect(done.piece).toMatchObject({
      lastMultiplier: 0.75,
      lastPassage: null,
      resume: null,
      createdAt: saved.piece.createdAt,
    })

    const pieces = await deps.storage.listPieces()
    expect(pieces).toHaveLength(1)
    expect(await deps.storage.getPackage(saved.piece.scoreVersionId)).toBeUndefined() // ST1
    expect(await deps.storage.getPackage(done.piece.scoreVersionId)).toBeDefined()
  })

  it('shows a save failure without touching the library', async () => {
    const flow = new ImportFlow(
      { ...deps, getStorage: () => Promise.reject(new Error('disk on fire')) },
      { kind: 'new' },
    )
    await flow.openFile(file('two-hands.musicxml'))
    await flow.save(initialDraft(review(flow).result.summary, review(flow).result.package.model))
    const r = review(flow)
    expect(r.saving).toBe(false)
    expect(r.saveError).toMatch(/could not be saved: disk on fire\. Your library is unchanged/)
    expect(await deps.storage.listPieces()).toEqual([])
  })
})
