/**
 * Study view entry (lazily loaded from `app/views.ts`; DECISIONS U72): reads `studyRequest`,
 * loads the piece and its score package from storage, and hands them to `StudyScreen`. It is
 * the Practice view's reading-only sibling: playback and the score on any device, including a
 * phone, with no practice, grading or history. Without a request it shows an empty state that
 * leads back to the Library (plus recent pieces).
 */
import { useEffect, useState } from 'preact/hooks'
import { studyRequest, navigate, openStudy, type StudyRequest } from '../../app/navigation'
import type { ScorePackage } from '../../core/model/score'
import type { PieceRecord, UserTempo } from '../../core/storage/records'
import { Button } from '../../ui/controls'
import { defaultPracticeEnv, type PracticeEnv } from '../practice/env'
import { StudyScreen } from './StudyScreen'
import styles from './study.module.css'

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'missing'; readonly message: string }
  | { readonly state: 'ready'; readonly piece: PieceRecord; readonly pkg: ScorePackage }

/** Registered in `app/views.ts` (no props). */
export function StudyView() {
  return <StudyViewWith />
}

/** The view with an injectable environment (tests). */
export function StudyViewWith({ env: injected }: { env?: PracticeEnv | undefined }) {
  const [env] = useState(() => injected ?? defaultPracticeEnv())
  const request = studyRequest.value
  if (!request) return <EmptyState env={env} />
  return <Loaded key={request.pieceId} env={env} request={request} />
}

function Loaded({ env, request }: { env: PracticeEnv; request: StudyRequest }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const storage = await env.storage()
        const piece = await storage.getPiece(request.pieceId)
        if (!piece) throw new Error('This piece is no longer in the library.')
        const pkg = await storage.getPackage(piece.scoreVersionId)
        if (!pkg) throw new Error('The score for this piece is missing. Import it again from the Library.')
        void storage.updatePiece(piece.id, { lastOpenedAt: Date.now() }).catch(() => undefined)
        if (live) setLoad({ state: 'ready', piece, pkg })
      } catch (e) {
        if (live)
          setLoad({ state: 'missing', message: e instanceof Error ? e.message : 'The piece could not be opened.' })
      }
    })()
    return () => {
      live = false
    }
  }, [env, request.pieceId])

  if (load.state === 'loading') {
    return (
      <section class={styles.center} aria-busy="true">
        <p class={styles.muted}>Opening the piece…</p>
      </section>
    )
  }
  if (load.state === 'missing') {
    return (
      <section class={styles.center}>
        <h1 class={styles.emptyTitle}>Can’t open this piece</h1>
        <p class={styles.muted}>{load.message}</p>
        <Button variant="primary" icon="back" onClick={() => navigate('library')}>
          Back to Library
        </Button>
      </section>
    )
  }
  const onTempo = async (userTempo: UserTempo): Promise<void> => {
    const storage = await env.storage()
    const piece = await storage.updatePiece(load.piece.id, { userTempo })
    if (piece) setLoad({ ...load, piece })
  }
  return (
    <StudyScreen
      key={load.piece.userTempo ? `${load.piece.userTempo.beatBpm}` : 'no-tempo'}
      env={env}
      piece={load.piece}
      pkg={load.pkg}
      onTempoSaved={onTempo}
    />
  )
}

function EmptyState({ env }: { env: PracticeEnv }) {
  const [recent, setRecent] = useState<readonly PieceRecord[]>([])
  useEffect(() => {
    let live = true
    env
      .storage()
      .then((s) => s.listPieces())
      .then((pieces) => live && setRecent(pieces.slice(0, 5)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [env])
  return (
    <section class={styles.center}>
      <span class={styles.eyebrow}>Study</span>
      <h1 class={styles.emptyTitle}>Choose a piece to study</h1>
      <p class={styles.muted}>Pick a score in the Library to listen to it and read it here.</p>
      <Button variant="primary" icon="back" onClick={() => navigate('library')}>
        Back to Library
      </Button>
      {recent.length > 0 ? (
        <div class={styles.recent}>
          <h2 class={styles.recentTitle}>Recently opened</h2>
          <ul>
            {recent.map((p) => (
              <li key={p.id}>
                <Button icon="music" onClick={() => openStudy({ pieceId: p.id })}>
                  {p.title}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
