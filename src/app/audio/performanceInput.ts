import { waveFile } from '../../core/recording/performance'
import { msg } from '../../i18n/messages'

/** An error whose message is already written for the player, in the interface language. */
export class RecordingError extends Error {
  override name = 'RecordingError'
}

export interface PerformanceInput {
  readonly label: string
  readonly devices: MediaDeviceInfo[]
  readonly deviceId: string
  level(): number
  start(): void
  stop(): Promise<Blob>
  close(): void
}

/** Opens only on a user gesture. No live audio is fed back to the instrument. */
export async function openPerformanceInput(
  id: string,
  onLost: () => void,
  signal: AbortSignal,
  preferredName?: string,
): Promise<PerformanceInput> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
    throw new RecordingError(msg('Audio input is unavailable. Open Pianissimo over HTTPS and allow audio access.'))
  }
  const context = new AudioContext()
  let stream: MediaStream | undefined
  let node: AudioWorkletNode | undefined
  let active = false
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    active = false
    signal.removeEventListener('abort', close)
    stream?.getTracks().forEach((track) => track.stop())
    node?.port.close()
    if (context.state !== 'closed') void context.close().catch(() => {})
  }
  signal.addEventListener('abort', close, { once: true })
  try {
    signal.throwIfAborted()
    const ready = context.resume()
    void ready.catch(() => {})
    const acquire = async (deviceId: string) => {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: { ideal: 2 },
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        },
      })
      if (closed || signal.aborted) {
        next.getTracks().forEach((track) => track.stop())
        signal.throwIfAborted()
        throw new RecordingError(msg('Audio input was interrupted.'))
      }
      return next
    }
    stream = await acquire(id)
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
    const matching =
      preferredName && devices.find((d) => d.label.trim().toLowerCase() === preferredName.trim().toLowerCase())
    if (matching && matching.deviceId && matching.deviceId !== stream.getAudioTracks()[0]?.getSettings().deviceId) {
      const previous = stream
      stream = await acquire(matching.deviceId)
      previous.getTracks().forEach((track) => track.stop())
    }
    await ready
    await context.audioWorklet.addModule(import.meta.env.BASE_URL + 'recording-processor.js')
    signal.throwIfAborted()
    const track = stream.getAudioTracks()[0]!
    let channels = track.getSettings().channelCount === 1 ? 1 : 2
    node = new AudioWorkletNode(context, 'performance-recorder')
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    source.connect(analyser)
    source.connect(node)
    node.connect(context.destination)
    const samples = new Float32Array(analyser.fftSize)
    let parts: BlobPart[] = []
    let buffered = 0
    let total = 0
    const blocks: Blob[] = []
    let stopped: (() => void) | null = null
    node.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | 'stopped' | number>) => {
      if (data === 'stopped') {
        stopped?.()
        return
      }
      if (typeof data === 'number') {
        channels = data
        return
      }
      parts.push(data)
      total += data.byteLength
      buffered += data.byteLength
      if (buffered >= 1024 * 1024) {
        blocks.push(new Blob(parts))
        parts = []
        buffered = 0
      }
      // Leave room for the RIFF header in a standard WAV file.
      if (total >= 0xffff0000 && active) onLost()
    }
    const lost = () => {
      if (!closed) onLost()
    }
    track.addEventListener('ended', lost)
    track.addEventListener('mute', lost)
    node.onprocessorerror = lost
    context.onstatechange = () => {
      if (context.state !== 'running' && !closed) onLost()
    }
    return {
      label: track.label || msg('System audio input'),
      devices,
      deviceId: track.getSettings().deviceId ?? id,
      level() {
        analyser.getFloatTimeDomainData(samples)
        let peak = 0
        for (const v of samples) peak = Math.max(peak, Math.abs(v))
        return peak
      },
      start() {
        if (closed || track.readyState !== 'live' || track.muted || context.state !== 'running')
          throw new RecordingError(msg('Audio input was interrupted.'))
        active = true
        node!.port.postMessage('start')
      },
      async stop() {
        active = false
        // A suspended or disconnected audio thread may never acknowledge the final block.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 400)
          stopped = () => {
            clearTimeout(timer)
            resolve()
          }
          node!.port.postMessage('stop')
        })
        close()
        return waveFile([...blocks, ...parts], total, channels, context.sampleRate)
      },
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}
