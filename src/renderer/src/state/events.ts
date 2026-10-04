import { create } from 'zustand'
import type { AppEvent } from '@shared/domain'

const MAX_EVENTS = 800

interface EventStreamState {
  events: AppEvent[]
  connected: boolean
  lastSeq: number
  counts: Record<string, number>
  push: (event: AppEvent) => void
  pushBatch: (events: AppEvent[]) => void
  markConnected: () => void
  clearCounts: () => void
}

export const useEventStream = create<EventStreamState>((set, get) => ({
  events: [],
  connected: false,
  lastSeq: 0,
  counts: {},

  push: (event) => {
    const state = get()
    const counts = { ...state.counts, [event.type]: (state.counts[event.type] ?? 0) + 1 }
    set({
      events: [...state.events, event].slice(-MAX_EVENTS),
      lastSeq: Math.max(state.lastSeq, event.seq),
      counts,
    })
  },

  pushBatch: (events) => {
    if (events.length === 0) return
    const state = get()
    const counts = { ...state.counts }
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
    set({
      events: [...state.events, ...events].slice(-MAX_EVENTS),
      lastSeq: Math.max(state.lastSeq, ...events.map((e) => e.seq)),
      counts,
    })
  },

  markConnected: () => set({ connected: true }),
  clearCounts: () => set({ counts: {} }),
}))

let started = false

/** Attach the preload event bridge exactly once for the app's lifetime. */
export function startEventStream(): () => void {
  if (started || typeof window === 'undefined') return () => undefined
  started = true
  const offEvents = window.fern.onEvent((event) => useEventStream.getState().push(event))
  const offBuffered = window.fern.onBufferedEvents((events) => {
    useEventStream.getState().pushBatch(events)
    useEventStream.getState().markConnected()
  })
  return () => {
    offEvents()
    offBuffered()
    started = false
  }
}
