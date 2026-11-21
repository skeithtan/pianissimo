import { scorePerformance } from '../core/recording/performance'

self.onmessage = (event: MessageEvent<{ groups: number[][]; played: number[] }>) => {
  self.postMessage(scorePerformance(event.data.groups, event.data.played))
}
