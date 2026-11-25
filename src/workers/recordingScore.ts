import { playedThrough, scorePerformance } from '../core/recording/performance'

self.onmessage = ({ data }: MessageEvent<{ groups: number[][]; played: number[] }>) => {
  self.postMessage({
    score: scorePerformance(data.groups, data.played),
    playedThrough: playedThrough(data.groups, data.played),
  })
}
