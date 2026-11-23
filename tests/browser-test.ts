import { test as base, type BrowserContext } from '@playwright/test'

export { expect, type Browser, type CDPSession, type Locator, type Page } from '@playwright/test'

export async function silenceBrowserContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // The fake MIDI fixture can still define its own method on navigator.
    Reflect.deleteProperty(Navigator.prototype, 'requestMIDIAccess')

    // Media elements (a recorded take) play on, muted.
    const playMedia = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      this.muted = true
      return playMedia.call(this)
    }

    const liveContext = window.AudioContext
    if (!liveContext) return

    // Headless WebKit still plays sound. Mute at the speaker connection, keeping the real
    // audio clock, scheduled sources, and microphone graphs running.
    const outputs = new WeakMap<AudioContext, GainNode>()
    const connect = AudioNode.prototype.connect
    AudioNode.prototype.connect = new Proxy(connect, {
      apply(original, source: AudioNode, args: unknown[]) {
        const ctx = source.context
        const destination = args[0]
        if (!(ctx instanceof liveContext) || destination !== ctx.destination) {
          return Reflect.apply(original, source, args)
        }

        let output = outputs.get(ctx)
        if (!output) {
          output = ctx.createGain()
          output.gain.value = 0
          Reflect.apply(connect, output, [destination])
          outputs.set(ctx, output)
        }
        args[0] = output
        Reflect.apply(original, source, args)
        return destination
      },
    })
    AudioNode.prototype.disconnect = new Proxy(AudioNode.prototype.disconnect, {
      apply(original, source: AudioNode, args: unknown[]) {
        const ctx = source.context
        if (ctx instanceof liveContext && args[0] === ctx.destination) {
          args[0] = outputs.get(ctx) ?? ctx.destination
        }
        return Reflect.apply(original, source, args)
      },
    })
  })
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await silenceBrowserContext(context)
    await use(context)
  },
})
