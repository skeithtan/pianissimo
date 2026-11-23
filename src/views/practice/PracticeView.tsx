import { msg } from '../../i18n/messages'
/**
 * Practice view entry (lazily loaded from `app/views.ts`). Reads `practiceRequest`, loads the
 * piece and its score package from storage, and hands them to `PracticeScreen`. Without a
 * request it shows an empty state that leads back to the Library (plus recent pieces).
 */
import { useEffect, useState } from 'preact/hooks'
import { navigate, openPractice, practiceRequest, type PracticeRequest } from '../../app/navigation'
import type { PracticeMode } from '../../core/model/practice'
import type { ScorePackage } from '../../core/model/score'
import type { PieceRecord, UserTempo } from '../../core/storage/records'
import { Button } from '../../ui/controls'
import { defaultPracticeEnv, type PracticeEnv } from './env'
import { PracticeScreen } from './PracticeScreen'
import styles from './practice.module.css'

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'missing'; readonly message: string }
  | {
      readonly state: 'ready'
      readonly piece: PieceRecord
      readonly pkg: ScorePackage
      /** The request's mode, until the learner chooses another (which is then the piece's own). */
      readonly openIn: PracticeMode | undefined
    }

/** Registered in `app/views.ts` (no props). */
export function PracticeView() {
  return <PracticeViewWith />
}

/** The view with an injectable environment (tests). */
export function PracticeViewWith({ env: injected }: { env?: PracticeEnv | undefined }) {
  const [env] = useState(() => injected ?? defaultPracticeEnv())
  const request = practiceRequest.value
  if (!request) return <EmptyState env={env} />
  const key = JSON.stringify([request.pieceId, request.preset ?? null, request.mode ?? null])
  return <Loaded key={key} env={env} request={request} />
}

function Loaded({ env, request }: { env: PracticeEnv; request: PracticeRequest }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const storage = await env.storage()
        const piece = await storage.getPiece(request.pieceId)
        if (!piece) throw new Error(msg('This piece is no longer in the library.'))
        const pkg = await storage.getPackage(piece.scoreVersionId)
        if (!pkg) throw new Error(msg('The score for this piece is missing. Import it again from the Library.'))
        void storage.updatePiece(piece.id, { lastOpenedAt: Date.now() }).catch(() => undefined)
        if (live) setLoad({ state: 'ready', piece, pkg, openIn: request.mode })
      } catch (e) {
        if (live)
          setLoad({ state: 'missing', message: e instanceof Error ? e.message : msg('The piece could not be opened.') })
      }
    })()
    return () => {
      live = false
    }
  }, [env, request.pieceId])

  if (load.state === 'loading') {
    return (
      <section class={styles.center} aria-busy="true">
        <p class={styles.muted}>{msg('Opening the piece…')}</p>
      </section>
    )
  }
  if (load.state === 'missing') {
    return (
      <section class={styles.center}>
        <h1 class={styles.emptyTitle}>{msg('Can’t open this piece')}</h1>
        <p class={styles.muted}>{load.message}</p>
        <Button variant="primary" icon="back" onClick={() => navigate('library')}>
          {msg('Back to Library')}
        </Button>
      </section>
    )
  }
  const onTempo = async (userTempo: UserTempo): Promise<void> => {
    const storage = await env.storage()
    const piece = await storage.updatePiece(load.piece.id, { userTempo })
    if (piece) setLoad({ ...load, piece, openIn: piece.mode === load.piece.mode ? load.openIn : undefined })
  }
  return (
    <PracticeScreen
      key={load.piece.userTempo ? `${load.piece.userTempo.beatBpm}` : 'no-tempo'}
      env={env}
      piece={load.piece}
      pkg={load.pkg}
      preset={request.preset}
      openIn={load.openIn}
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
      <span class={styles.eyebrow}>{msg('Practice')}</span>
      <h1 class={styles.emptyTitle}>{msg('Choose a piece to practice')}</h1>
      <p class={styles.muted}>{msg('Pick a score in the Library, then practice it here.')}</p>
      <Button variant="primary" icon="back" onClick={() => navigate('library')}>
        {msg('Back to Library')}
      </Button>
      {recent.length > 0 ? (
        <div class={styles.recent}>
          <h2 class={styles.recentTitle}>{msg('Recently opened')}</h2>
          <ul>
            {recent.map((p) => (
              <li key={p.id}>
                <Button icon="music" onClick={() => openPractice({ pieceId: p.id })}>
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
