import { describe, expect, it } from 'vitest'
import { WakeLockController, type WakeLockEnvironment } from './wakeLock'

class FakeSentinel {
  released = false
  private listeners: (() => void)[] = []
  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.push(listener)
  }
  release(): Promise<void> {
    this.released = true
    this.fire()
    return Promise.resolve()
  }
  /** The browser drops the lock itself (page hidden). */
  fire(): void {
    for (const l of this.listeners) l()
  }
}

function rig(options: { supported?: boolean; reject?: boolean; visible?: boolean } = {}) {
  const sentinels: FakeSentinel[] = []
  let requests = 0
  const visibility: { state: string; listeners: (() => void)[] } = {
    state: options.visible === false ? 'hidden' : 'visible',
    listeners: [],
  }
  const env: WakeLockEnvironment = {
    navigator:
      options.supported === false
        ? {}
        : {
            wakeLock: {
              request: () => {
                requests++
                if (options.reject) return Promise.reject(new DOMException('low battery', 'NotAllowedError'))
                const s = new FakeSentinel()
                sentinels.push(s)
                return Promise.resolve(s)
              },
            },
          },
    document: {
      get visibilityState() {
        return visibility.state
      },
      addEventListener: (_t, l) => visibility.listeners.push(l),
      removeEventListener: (_t, l) => {
        visibility.listeners = visibility.listeners.filter((x) => x !== l)
      },
    },
  }
  const setVisibility = (state: 'visible' | 'hidden') => {
    visibility.state = state
    for (const l of [...visibility.listeners]) l()
  }
  return { controller: new WakeLockController(env), sentinels, requests: () => requests, setVisibility, visibility }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('WakeLockController', () => {
  it('requests a screen lock while held and releases it when dropped', async () => {
    const { controller, sentinels } = rig()
    controller.hold('practice')
    await settle()
    expect(sentinels).toHaveLength(1)
    expect(controller.state).toBe('held')
    controller.drop('practice')
    expect(sentinels[0]?.released).toBe(true)
    expect(controller.state).toBe('idle')
  })

  it('keeps the lock until every owner has dropped', async () => {
    const { controller, sentinels } = rig()
    controller.hold('view')
    controller.hold('session')
    await settle()
    expect(sentinels).toHaveLength(1)
    controller.drop('view')
    expect(sentinels[0]?.released).toBe(false)
    controller.drop('session')
    expect(sentinels[0]?.released).toBe(true)
  })

  it('re-acquires when the page becomes visible again after the browser dropped it', async () => {
    const { controller, sentinels, setVisibility } = rig()
    controller.hold('practice')
    await settle()
    setVisibility('hidden')
    sentinels[0]?.fire() // browsers release the lock when the page is hidden
    expect(controller.state).toBe('idle')
    setVisibility('visible')
    await settle()
    expect(sentinels).toHaveLength(2)
    expect(controller.state).toBe('held')
  })

  it('does not request while the page is hidden, and does when it shows', async () => {
    const { controller, sentinels, requests, setVisibility } = rig({ visible: false })
    controller.hold('practice')
    await settle()
    expect(requests()).toBe(0)
    setVisibility('visible')
    await settle()
    expect(sentinels).toHaveLength(1)
  })

  it('does not request twice while a lock is held or pending', async () => {
    const { controller, requests, setVisibility } = rig()
    controller.hold('practice')
    controller.hold('practice')
    setVisibility('visible')
    await settle()
    setVisibility('visible')
    expect(requests()).toBe(1)
  })

  it('stops listening for visibility once nothing wants the lock', async () => {
    const { controller, visibility } = rig()
    controller.hold('practice')
    expect(visibility.listeners).toHaveLength(1)
    controller.drop('practice')
    expect(visibility.listeners).toHaveLength(0)
  })

  it('releases a lock that arrives after the last owner already dropped', async () => {
    const { controller, sentinels } = rig()
    controller.hold('practice')
    controller.drop('practice') // before the request resolves
    await settle()
    expect(sentinels[0]?.released).toBe(true)
    expect(controller.state).toBe('idle')
  })

  it('tolerates a refused request and tries again on the next visibility change', async () => {
    const { controller, requests, setVisibility } = rig({ reject: true })
    controller.hold('practice')
    await settle()
    expect(controller.state).toBe('failed')
    expect(requests()).toBe(1)
    setVisibility('visible')
    await settle()
    expect(requests()).toBe(2) // one retry per event, never a loop
  })

  it('is a harmless no-op where the API is missing', () => {
    const { controller } = rig({ supported: false })
    expect(controller.state).toBe('unsupported')
    expect(() => {
      controller.hold('practice')
      controller.drop('practice')
    }).not.toThrow()
  })

  it('survives a request that throws synchronously', async () => {
    const env: WakeLockEnvironment = {
      navigator: {
        wakeLock: {
          request: () => {
            throw new Error('nope')
          },
        },
      },
    }
    const controller = new WakeLockController(env)
    expect(() => controller.hold('practice')).not.toThrow()
    expect(controller.state).toBe('failed')
  })

  it('works without a document', async () => {
    const env: WakeLockEnvironment = { navigator: { wakeLock: { request: () => Promise.resolve(new FakeSentinel()) } } }
    const controller = new WakeLockController(env)
    controller.hold('practice')
    await settle()
    expect(controller.state).toBe('held')
  })
})
