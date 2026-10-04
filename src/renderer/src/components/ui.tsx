import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { X, Loader2, AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { cn } from '../lib/format'
import { requiresConfirmation } from '../state/settings'

/* --------------------------------------------------------------- button */

export function Button({
  children,
  variant = 'default',
  size = 'md',
  className,
  ...rest
}: {
  children: ReactNode
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'md' | 'sm'
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const variantClass =
    variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : variant === 'ghost' ? 'btn-ghost' : ''
  return (
    <button className={cn('btn press', size === 'sm' && 'btn-sm', variantClass, className)} {...rest}>
      {children}
    </button>
  )
}

/* --------------------------------------------------------------- panels */

export function Panel({
  children,
  className,
  title,
  action,
  flat,
}: {
  children: ReactNode
  className?: string
  title?: ReactNode
  action?: ReactNode
  flat?: boolean
}) {
  return (
    <section className={cn(flat ? 'panel-flat' : 'panel', 'flex min-h-0 flex-col overflow-hidden', className)}>
      {title !== undefined && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-2.5">
          <div className="stack-title">{title}</div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

/* ---------------------------------------------------------------- forms */

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3.5">
      <label className="label">{label}</label>
      {children}
      {hint && <div className="mt-1.5 text-[11.5px] leading-snug text-fgf">{hint}</div>}
    </div>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input', props.className)} {...props} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('textarea', props.className)} {...props} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('select', props.className)} {...props} />
}

export function Switch({ checked, onCheckedChange, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className="relative h-[18px] w-8 shrink-0 rounded-full border border-line2 bg-panel2 transition-colors disabled:opacity-40 data-[state=checked]:border-accent data-[state=checked]:bg-accent/80"
    >
      <SwitchPrimitive.Thumb className="block h-3.5 w-3.5 translate-x-[1px] rounded-full bg-fgm transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-app" />
    </SwitchPrimitive.Root>
  )
}

/* ---------------------------------------------------------------- pills */

export type PillTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'

export function Pill({ children, tone = 'neutral', className }: { children: ReactNode; tone?: PillTone; className?: string }) {
  const toneClass =
    tone === 'ok'
      ? 'pill-ok'
      : tone === 'warn'
        ? 'pill-warn'
        : tone === 'danger'
          ? 'pill-danger'
          : tone === 'info'
            ? 'pill-info'
            : tone === 'accent'
              ? 'pill-accent'
              : 'pill-muted'
  return <span className={cn('pill', toneClass, className)}>{children}</span>
}

const STATUS_TONE: Record<string, PillTone> = {
  draft: 'neutral',
  refining: 'info',
  planning: 'info',
  ready: 'accent',
  running: 'accent',
  paused: 'warn',
  awaiting_approval: 'warn',
  completed: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
  queued: 'neutral',
  starting: 'info',
  waiting_approval: 'warn',
  succeeded: 'ok',
  timed_out: 'warn',
  aborted: 'neutral',
  orphaned: 'warn',
  pending: 'neutral',
  ready_task: 'neutral',
  blocked: 'warn',
  skipped: 'neutral',
  unhealthy: 'danger',
  healthy: 'ok',
  unreachable: 'danger',
  degraded: 'warn',
  available: 'ok',
  missing: 'danger',
}

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const tone = STATUS_TONE[status] ?? 'neutral'
  const active = status === 'running' || status === 'starting' || status === 'refining' || status === 'planning'
  return (
    <Pill tone={tone}>
      <span className={cn('dot', active && 'animate-pulse-soft')} />
      {label ?? status.replace(/_/g, ' ')}
    </Pill>
  )
}

/* --------------------------------------------------------------- states */

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-fgf" />
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 text-fgf">{icon}</div>}
      <div className="text-sm font-medium text-fgm">{title}</div>
      {description && <div className="max-w-md text-[12.5px] leading-relaxed text-fgf">{description}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function LoadingRow({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-6 text-[12.5px] text-fgf">
      <Spinner />
      {label}
    </div>
  )
}

/** Shimmer placeholders for the shape of what is about to render. */
export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2.5', className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${Math.max(45, 100 - i * 11)}%` }} />
      ))}
    </div>
  )
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/8 px-3.5 py-3 text-[12.5px] text-danger">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">Something went wrong</div>
        <div className="mt-0.5 break-words text-danger/85">{message}</div>
      </div>
      {onRetry && (
        <Button size="sm" variant="danger" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- dialog */

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fx-overlay fixed inset-0 z-40 bg-black/65 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={cn(
            'fx-modal fixed left-1/2 top-1/2 z-50 w-[calc(100vw-40px)] -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-line2 bg-panel p-0 shadow-2xl shadow-black/60',
            width,
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
            <div>
              <DialogPrimitive.Title className="text-sm font-semibold text-fg">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="mt-0.5 text-[12px] text-fgf">{description}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="rounded p-1 text-fgf transition-colors hover:bg-panel2 hover:text-fg">
              <X size={15} />
            </DialogPrimitive.Close>
          </header>
          <div className="max-h-[65vh] overflow-y-auto px-4 py-3.5">{children}</div>
          {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  pending,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  pending?: boolean
}) {
  const [gated, setGated] = useState(false)

  useEffect(() => {
    if (!open) {
      setGated(false)
      return
    }
    let alive = true
    void requiresConfirmation().then((needs) => {
      if (!alive) return
      if (needs) return
      // "Confirm destructive actions" is off — act straight away.
      setGated(true)
      onConfirm()
      onOpenChange(false)
    })
    return () => {
      alive = false
    }
  }, [open])

  return (
    <Modal
      open={open && !gated}
      onOpenChange={onOpenChange}
      title={title}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={pending}>
            {pending && <Spinner size={13} />}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-fgm">{message}</div>
    </Modal>
  )
}

/* --------------------------------------------------------------- toasts */

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: { id: string; kind: 'info' | 'success' | 'error' | 'warn'; title: string; message?: string }[]
  onDismiss: (id: string) => void
}) {
  const icon = {
    info: <Info size={15} className="text-info" />,
    success: <CheckCircle2 size={15} className="text-ok" />,
    warn: <AlertTriangle size={15} className="text-warn" />,
    error: <XCircle size={15} className="text-danger" />,
  }
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="fx-toast pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line2 bg-panel2/95 px-3 py-2.5 shadow-xl shadow-black/50 backdrop-blur"
        >
          <div className="mt-0.5">{icon[t.kind]}</div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-fg">{t.title}</div>
            {t.message && <div className="mt-0.5 break-words text-[12px] leading-snug text-fgf">{t.message}</div>}
          </div>
          <button className="text-fgf hover:text-fg" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------- tooltip */

export function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            className="fx-tip z-50 rounded-md border border-line2 bg-panel2 px-2 py-1 text-[11.5px] text-fgm shadow-lg shadow-black/50"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}

/* ---------------------------------------------------------------- misc */

export function StatCard({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: PillTone
  onClick?: () => void
}) {
  const toneText = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-fg'
  return (
    <div
      className={cn(
        'panel flex flex-col gap-1 px-3.5 py-3 transition-colors',
        onClick && 'lift cursor-pointer hover:border-line2 hover:bg-panel2',
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
    >
      <div className="stack-title">{label}</div>
      <div className={cn('text-[22px] font-semibold leading-none tracking-tight', toneText)}>{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-fgf">{sub}</div>}
    </div>
  )
}
