export type SavedEvent = {
  event: string
  n: number
  ms: number
  bytes: number
  lastAt: number
  perSecond: [number, number][]
  plugins: string[]
}

export type Snapshot = {
  events: SavedEvent[]
  steps: { input: number; output: number; cached: number }[]
  turns: { usd: number; tokens: number }[]
  isPaused: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'hook-flow': {
      tick: number
      snapshot: Snapshot | null
    }
  }
}
