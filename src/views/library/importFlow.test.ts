import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { fixtureBytes } from '../../../tests/unit/import/fixtures'
import { hasTempo } from '../../core/music/tempo'
import type { PieceRecord } from '../../core/storage/records'
import { ImportFlow, resetPersistenceRequestForTests, type FlowPhase, type StorageStatus } from './importFlow'
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
  storage: Promise<StorageStatus>
}
function savingFlow(): { flow: ImportFlow; saved: Saved[] } {
  const saved: Saved[] = []
  const flow = new ImportFlow(deps, (piece, info) => saved.push({ piece, ...info }))
  return { flow, saved }
}

/** Record every phase the flow shows. */
function trace(flow: ImportFlow): string[] {
  const seen: string[] = []
  flow.phase.subscribe((p) => seen.push(p.kind))
  return seen
}

describe('ImportFlow', () => {
  it('saves a score that needs no answer in one commit, showing only the progress', async () => {
    const { flow, saved } = savingFlow()
    const phases = trace(flow)
    await flow.openFile(file('two-hands.musicxml'))
    expect(deps.client.calls).toEqual(['inspect', 'build:P1'])
    // The sheet showed its progress and closed; the save is reported once (L6, L12).
    expect([...new Set(phases)]).toEqual(['idle', 'working'])
    expect(phases.at(-1)).toBe('idle')
    expect(saved).toHaveLength(1)
    const done = saved[0]!
    expect(done.piece.title).toBe('Two Hands')
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
    expect(deps.manager.persistCalls).toBe(1)
    expect(again.saved).toHaveLength(1)
    expect((await again.saved[0]!.storage).persistence).toBe('granted')
  })

  it.each(['no-tempo', 'split-voice', 'timing-marks', 'tempo-conflict', 'unsupported'])(
    'asks when something is unclear (%s)',
    async (name) => {
      const flow = new ImportFlow(deps)
      await flow.openFile(file(`${name}.musicxml`))
      expect(review(flow).choiceOffered).toBe(false)
      expect(await deps.storage.listPieces()).toEqual([])
    },
  )

  it('asks about a score that is already in the library', async () => {
    await new ImportFlow(deps).openFile(file('two-hands.musicxml'))
    const flow = new ImportFlow(deps)
    await flow.openFile(file('two-hands.musicxml'))
    expect(review(flow).saveError).toBeNull()
    expect(await deps.storage.listPieces()).toHaveLength(1)
  })

  it('canceling before the commit saves nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const flow = new ImportFlow({ ...deps, getStorage: () => gate.then(() => deps.storage) })
    const running = flow.openFile(file('two-hands.musicxml'))
    await tick(20)
    flow.cancel()
    release()
    await running
    expect(flow.phase.value).toEqual({ kind: 'idle' })
    expect(await deps.storage.listPieces()).toEqual([])
  })

  it('offers the part choice when there is one, and validates it before building', async () => {
    const flow = new ImportFlow(deps)
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
    const flow = new ImportFlow(deps)
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
    const flow = new ImportFlow(deps)
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
    const flow = new ImportFlow(deps)
    const running = flow.openFile(file('two-hands.musicxml'))
    await tick()
    flow.cancel()
    await running
    expect(flow.phase.value).toEqual({ kind: 'idle' })
  })

  it('reports unrelated XML and malformed files readably', async () => {
    const flow = new ImportFlow(deps)
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
    const flow = new ImportFlow(deps)
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

  it('adds a duplicate with the stored practice tempo instead of the unreviewed source defaults', async () => {
    const first = savingFlow()
    await first.flow.openFile(file('no-tempo.musicxml'))
    const original = review(first.flow)
    await first.flow.save({ ...initialDraft(original.result.summary, original.result.package.model), bpmText: '84' })
    const existing = first.saved[0]!.piece
    await deps.storage.updatePiece(existing.id, { lastMultiplier: 0.75 })
    const copy = savingFlow()
    await copy.flow.openFile(file('no-tempo.musicxml'))
    expect(review(copy.flow).result.summary.tempo.present).toBe(false)

    await copy.flow.saveCopy(existing.id)

    expect(copy.flow.phase.value.kind).toBe('idle')
    expect(copy.saved).toHaveLength(1)
    expect(copy.saved[0]!.piece.id).not.toBe(existing.id)
    expect(copy.saved[0]!.piece.userTempo).toEqual(existing.userTempo)
    expect(copy.saved[0]!.piece.lastMultiplier).toBe(1)
    expect(copy.saved[0]!.piece.resume).toBeNull()
    const pieces = await deps.storage.listPieces()
    expect(pieces).toHaveLength(2)
    expect(pieces.every((piece) => piece.userTempo?.beatBpm === 84)).toBe(true)
    expect((await deps.storage.getPiece(existing.id))?.lastMultiplier).toBe(0.75)
  })

  it('does not add a duplicate when its existing piece has disappeared', async () => {
    const { flow, saved } = savingFlow()
    await flow.openFile(file('no-tempo.musicxml'))
    await flow.saveCopy('missing')
    expect(review(flow).saving).toBe(false)
    expect(review(flow).saveError).toContain('existing piece changed')
    expect(saved).toHaveLength(0)
    expect(await deps.storage.listPieces()).toEqual([])
  })

  it('cancel releases the client and the retained file; a later file still imports', async () => {
    const flow = new ImportFlow(deps)
    await flow.openFile(file('two-parts.musicxml'))
    expect(flow.phase.value.kind).toBe('choose')
    flow.cancel()
    expect(deps.client.disposed).toBe(1)
    await flow.openFile(file('two-hands.musicxml'))
    expect(await deps.storage.listPieces()).toHaveLength(1)
  })

  it('closing the sheet while saving still stores the piece but skips the Practice handoff', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const saved: Saved[] = []
    const flow = new ImportFlow({ ...deps, getStorage: () => gate.then(() => deps.storage) }, (piece, info) =>
      saved.push({ piece, ...info }),
    )
    await flow.openFile(file('no-tempo.musicxml'))
    const r = review(flow)
    const saving = flow.save({ ...initialDraft(r.result.summary, r.result.package.model), bpmText: '80' })
    expect(flow.busy).toBe(true)
    flow.close()
    release()
    await saving
    expect(saved).toEqual([]) // no notice, no openPractice(autoStart)
    expect(flow.phase.value).toEqual({ kind: 'idle' })
    expect((await deps.storage.listPieces()).map((p) => p.title)).toEqual([r.result.summary.title]) // never lose a save
  })

  it('shows a save failure without touching the library', async () => {
    const flow = new ImportFlow({ ...deps, getStorage: () => Promise.reject(new Error('disk on fire')) })
    await flow.openFile(file('two-hands.musicxml'))
    const r = review(flow)
    expect(r.saving).toBe(false)
    expect(r.saveError).toMatch(/could not be saved: disk on fire\. Your library is unchanged/)
    expect(await deps.storage.listPieces()).toEqual([])
  })
})
