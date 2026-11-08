/**
 * AudioWorklet processor for the microphone follower (DECISIONS P15): batches the first input
 * channel into 512-sample blocks and posts them to the main thread, which forwards them to the
 * follower worker. Plain JavaScript on purpose: worklet modules load by URL from `public/`.
 * It outputs nothing (the node is connected to the destination only so it keeps running).
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(512)
    this.fill = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let i = 0
    while (i < channel.length) {
      const n = Math.min(channel.length - i, this.block.length - this.fill)
      this.block.set(channel.subarray(i, i + n), this.fill)
      this.fill += n
      i += n
      if (this.fill === this.block.length) {
        const samples = this.block
        this.block = new Float32Array(512)
        this.fill = 0
        this.port.postMessage({ type: 'samples', samples, sampleRate }, [samples.buffer])
      }
    }
    return true
  }
}

registerProcessor('pianissimo-mic', MicProcessor)
