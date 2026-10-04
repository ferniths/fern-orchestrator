import { create } from 'zustand'
import { newIdToast } from '../lib/id'

export type ToastKind = 'info' | 'success' | 'error' | 'warn'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  message?: string
  createdAt: number
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id' | 'createdAt'>) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = newIdToast()
    const entry: Toast = { ...toast, id, createdAt: Date.now() }
    set((s) => ({ toasts: [...s.toasts, entry].slice(-5) }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, toast.kind === 'error' ? 7000 : 4000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = {
  info: (title: string, message?: string) => useToasts.getState().push({ kind: 'info', title, ...(message ? { message } : {}) }),
  success: (title: string, message?: string) => useToasts.getState().push({ kind: 'success', title, ...(message ? { message } : {}) }),
  warn: (title: string, message?: string) => useToasts.getState().push({ kind: 'warn', title, ...(message ? { message } : {}) }),
  error: (title: string, message?: string) => useToasts.getState().push({ kind: 'error', title, ...(message ? { message } : {}) }),
}
