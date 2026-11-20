import { expect, test } from '../browser-test'

test('the test browser routes speaker audio through a silent gain and hides native MIDI', async ({ page }) => {
  await page.goto('./')
  const output = await page.evaluate(async () => {
    const audio = new AudioContext()
    try {
      const gains: GainNode[] = []
      const createGain = audio.createGain.bind(audio)
      audio.createGain = () => {
        const gain = createGain()
        gains.push(gain)
        return gain
      }

      const oscillator = audio.createOscillator()
      const stream = audio.createMediaStreamDestination()
      const streamConnected = oscillator.connect(stream) === stream
      const speakerConnected = oscillator.connect(audio.destination) === audio.destination
      const sample = audio.createBufferSource()
      sample.connect(audio.destination)
      oscillator.disconnect(audio.destination)
      sample.disconnect(audio.destination)

      return {
        streamConnected,
        speakerConnected,
        outputGains: gains.map((gain) => gain.gain.value),
        midiAvailable: typeof navigator.requestMIDIAccess === 'function',
      }
    } finally {
      await audio.close()
    }
  })
  expect(output).toEqual({ streamConnected: true, speakerConnected: true, outputGains: [0], midiAvailable: false })
})
