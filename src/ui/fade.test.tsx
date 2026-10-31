// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { mount, type Mounted } from '../views/shared/testing'
import { Fade, useFadeList, useFadePresence } from './fade'
import { fadeDuration, HINT_FADE_MS, REDUCED_FADE_MS } from './motion'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function Probe({ visible, ms }: { visible: boolean; ms?: number }) {
  const { mounted, phase, style } = useFadePresence(visible, ms)
  return mounted ? (
    <div data-testid="probe" data-phase={phase} style={style}>
      content
    </div>
  ) : null
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })
const probe = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-testid="probe"]')

describe('useFadePresence', () => {
  it('starts visible without a fade-in when initially shown', () => {
    vi.useFakeTimers()
    view = mount(<Probe visible />)
    expect(probe(view.container)?.style.opacity).toBe('1')
  })

  it('fades in from opacity 0 when shown later', () => {
    vi.useFakeTimers()
    view = mount(<Probe visible={false} />)
    expect(probe(view.container)).toBeNull()
    view.rerender(<Probe visible />)
    expect(probe(view.container)?.getAttribute('data-phase')).toBe('entering')
    expect(probe(view.container)?.style.opacity).toBe('0')
    advance(50)
    expect(probe(view.container)?.style.opacity).toBe('1')
  })

  it('keeps the element mounted while it fades to 0, then removes it', () => {
    vi.useFakeTimers()
    view = mount(<Probe visible ms={300} />)
    view.rerender(<Probe visible={false} ms={300} />)
    const el = probe(view.container)!
    expect(el.style.opacity).toBe('0')
    expect(el.style.transition).toContain('300ms')
    expect(el.style.pointerEvents).toBe('none')
    advance(299)
    expect(probe(view.container)).not.toBeNull()
    advance(2)
    expect(probe(view.container)).toBeNull()
  })

  it('cancels the removal when shown again during the fade', () => {
    vi.useFakeTimers()
    view = mount(<Probe visible ms={300} />)
    view.rerender(<Probe visible={false} ms={300} />)
    advance(150)
    view.rerender(<Probe visible ms={300} />)
    advance(500)
    expect(probe(view.container)?.style.opacity).toBe('1')
    expect(probe(view.container)?.getAttribute('data-phase')).toBe('visible')
  })

  it('shortens, but keeps, the fade under reduced motion', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: /reduce/u.test(query), media: query }))
    view = mount(<Probe visible ms={300} />)
    view.rerender(<Probe visible={false} ms={300} />)
    const el = probe(view.container)!
    expect(el.style.transition).toContain(`${REDUCED_FADE_MS}ms`)
    expect(el.style.opacity).toBe('0')
    advance(REDUCED_FADE_MS + 5)
    expect(probe(view.container)).toBeNull()
  })
})

describe('fadeDuration', () => {
  it('keeps the spec default of 300 ms and shortens under reduced motion without removing it', () => {
    expect(HINT_FADE_MS).toBe(300)
    expect(fadeDuration(300, false)).toBe(300)
    expect(fadeDuration(300, true)).toBeGreaterThan(0)
    expect(fadeDuration(300, true)).toBeLessThan(300)
    expect(fadeDuration(40, true)).toBe(40)
  })
})

describe('<Fade>', () => {
  it('fades its children out before unmounting them', () => {
    vi.useFakeTimers()
    view = mount(
      <Fade show ms={200}>
        hello
      </Fade>,
    )
    expect(view.container.textContent).toBe('hello')
    view.rerender(
      <Fade show={false} ms={200}>
        hello
      </Fade>,
    )
    expect(view.container.textContent).toBe('hello')
    expect(view.container.firstElementChild?.getAttribute('style')).toContain('opacity: 0')
    advance(250)
    expect(view.container.textContent).toBe('')
  })
})

describe('useFadeList', () => {
  interface Item {
    readonly id: number
    readonly text: string
  }
  function List({ items }: { items: readonly Item[] }) {
    const entries = useFadeList(items, 200)
    return (
      <ul>
        {entries.map(({ item, leaving }) => (
          <li key={item.id} data-leaving={leaving}>
            {item.text}
          </li>
        ))}
      </ul>
    )
  }
  const texts = (root: HTMLElement) =>
    [...root.querySelectorAll('li')].map((li) => `${li.textContent}${li.dataset['leaving'] === 'true' ? '*' : ''}`)

  it('keeps removed items, flagged as leaving, until their fade ends', () => {
    vi.useFakeTimers()
    const a = { id: 1, text: 'a' }
    const b = { id: 2, text: 'b' }
    view = mount(<List items={[a, b]} />)
    expect(texts(view.container)).toEqual(['a', 'b'])
    view.rerender(<List items={[b]} />)
    expect(texts(view.container)).toEqual(['b', 'a*'])
    advance(250)
    expect(texts(view.container)).toEqual(['b'])
  })

  it('handles several items leaving at different times', () => {
    vi.useFakeTimers()
    const items = [1, 2, 3].map((id) => ({ id, text: `n${id}` }))
    view = mount(<List items={items} />)
    view.rerender(<List items={[items[1]!, items[2]!]} />)
    advance(100)
    view.rerender(<List items={[items[2]!]} />)
    expect(texts(view.container)).toEqual(['n3', 'n1*', 'n2*'])
    advance(110)
    expect(texts(view.container)).toEqual(['n3', 'n2*']) // n1 done, n2 still fading
    advance(100)
    expect(texts(view.container)).toEqual(['n3'])
  })

  it('shows an item again if it returns while fading', () => {
    vi.useFakeTimers()
    const a = { id: 1, text: 'a' }
    view = mount(<List items={[a]} />)
    view.rerender(<List items={[]} />)
    view.rerender(<List items={[a]} />)
    expect(texts(view.container)).toEqual(['a'])
    advance(300)
    expect(texts(view.container)).toEqual(['a'])
  })
})
