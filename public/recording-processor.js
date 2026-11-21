// Pack interleaved 16-bit PCM in the audio thread. The output stays silent.
class RecordingProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.channels = 0
    this.block = new Int16Array(8192 * this.channels)
    this.used = 0
    this.active = false
    this.port.onmessage = ({data}) => {
      if (data === 'start') this.active = true
      if (data === 'stop') {
        this.active = false
        this.flush()
        this.port.postMessage('stopped')
      }
    }
  }

  flush() {
    if (!this.used) return
    const block = this.used === this.block.length ? this.block : this.block.slice(0,this.used)
    this.port.postMessage(block.buffer,[block.buffer])
    this.block = new Int16Array(8192 * this.channels)
    this.used = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!this.active || !input?.[0]) return true
    if (!this.channels) {
      this.channels = Math.min(2,input.length)
      this.block = new Int16Array(8192 * this.channels)
      this.port.postMessage(this.channels)
    }
    for (let frame = 0; frame < input[0].length; frame++) {
      for (let channel = 0; channel < this.channels; channel++) {
        const value = Math.max(-1, Math.min(1, (input[channel] ?? input[0])[frame]))
        this.block[this.used++] = Math.round(value * (value < 0 ? 32768 : 32767))
      }
      if (this.used === this.block.length) this.flush()
    }
    return true
  }
}
registerProcessor('performance-recorder', RecordingProcessor)
