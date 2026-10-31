/**
 * Decoded MIDI input events. Produced by the Web MIDI adapter on the main thread and
 * consumed exactly once by the practice engine (spec: "Every input event is consumed at most once").
 */
export type MidiInputEvent =
  | {
      readonly kind: 'noteon'
      readonly seq: number
      readonly channel: number
      readonly note: number
      /** 1..127. Note On with velocity 0 is decoded as 'noteoff'. */
      readonly velocity: number
      /** DOMHighResTimeStamp (performance.now() timebase) from MIDIMessageEvent.timeStamp. */
      readonly time: number
      readonly portId: string
    }
  | {
      readonly kind: 'noteoff'
      readonly seq: number
      readonly channel: number
      readonly note: number
      readonly velocity: number
      readonly time: number
      readonly portId: string
    }
  | {
      readonly kind: 'cc'
      readonly seq: number
      readonly channel: number
      readonly controller: number
      readonly value: number
      readonly time: number
      readonly portId: string
    }

export const CC_SUSTAIN = 64
export const CC_SOSTENUTO = 66
export const CC_SOFT = 67
export const CC_ALL_NOTES_OFF = 123
