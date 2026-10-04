import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, ChevronDown, FolderGit2 } from 'lucide-react'
import { call, useApi } from '../lib/api'
import { cn } from '../lib/format'
import type { PageProps } from '../lib/types'
import { useRouter } from '../state/router'
import { toast } from '../state/toast'
import { LANGUAGE_OPTIONS, type SettingsShape } from '../state/settings'
import type { OutputLanguage } from '@shared/domain'
import { ProjectPickerDialog } from '../components/ProjectPickerDialog'
import { Button, ErrorNote, Field, Panel, Select, Textarea } from '../components/ui'

const MODES = [
  { value: 'single', label: 'Single pass', hint: 'Plan once, execute, synthesize, review.' },
  { value: 'iterate', label: 'Iterate', hint: 'Keep looping until acceptance criteria hold (max 5).' },
  { value: 'fixed', label: 'Fixed loops', hint: 'Run a specific number of improvement loops.' },
] as const

export default function NewJobPage(_: PageProps) {
  const navigate = useRouter((s) => s.navigate)
  const projects = useApi('projects.list', [])
  const routes = useApi('routes.list', [])
  const templates = useApi('templates.list', [])
  const settings = useApi('settings.get', [])

  const [prompt, setPrompt] = useState('')
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [mode, setMode] = useState<'single' | 'iterate' | 'fixed'>('single')
  const [loopCount, setLoopCount] = useState(2)
  const [templateId, setTemplateId] = useState('')
  const [language, setLanguage] = useState<OutputLanguage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [projectIssue, setProjectIssue] = useState<string | null>(null)

  const settingsShape = (settings.data ?? null) as SettingsShape | null
  const globalLanguage = settingsShape?.general?.language ?? null
  const effectiveLanguage = language ?? globalLanguage ?? 'English'

  const defaultRoute = useMemo(() => routes.data?.find((r) => r.isDefault) ?? routes.data?.[0], [routes.data])
  const selectedTemplate = (templates.data ?? []).find((t) => t.id === templateId)
  const selectedProject = (projects.data ?? []).find((p) => p.id === projectId) ?? null

  // The folder may have been deleted since the project was registered — say so
  // here instead of letting the job fail after it starts.
  useEffect(() => {
    if (!selectedProject) {
      setProjectIssue(null)
      return
    }
    let alive = true
    call('projects.validate', selectedProject.path)
      .then((s) => {
        if (alive) setProjectIssue(s.message)
      })
      .catch((err: unknown) => {
        if (alive) setProjectIssue((err as Error).message)
      })
    return () => {
      alive = false
    }
  }, [selectedProject])

  async function create() {
    setError(null)
    if (!prompt.trim()) {
      setError('Describe the job first.')
      return
    }
    if (projectIssue) {
      setError(`Project folder unavailable: ${projectIssue}`)
      return
    }
    setBusy(true)
    try {
      const job = await call('jobs.create', {
        prompt: prompt.trim(),
        projectId: projectId || null,
        vaultId: null,
        loopCount: mode === 'single' ? 1 : mode === 'iterate' ? 5 : loopCount,
        routeId: defaultRoute?.id ?? null,
        requirePlanApproval: true,
        templateId: templateId || null,
        ...(language || globalLanguage ? { language: effectiveLanguage } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      })
      toast.success('Job created', 'It will refine next, then wait for your plan approval.')
      navigate(`/jobs/${job.id}`)
    } catch (err) {
      const e = err as Error
      setError(e.message)
      toast.error('Could not create job', e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-6">
        <div className="stack-title mb-1.5">New job</div>
        <h2 className="text-[18px] font-semibold tracking-tight text-white">What are we building?</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fgm">
          Rough is fine. The refiner turns your note into a sharp goal, the planner proposes a DAG, and you approve before anything executes.
        </p>

        <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <Panel title="Goal">
              <div className="p-3.5">
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={8}
                  placeholder={'e.g.\nAdd rate limiting to the API, cover it with tests, update the docs, and keep the public API stable.'}
                  autoFocus
                />
                <div className="mt-2 flex items-center justify-between text-[11.5px] text-fgf">
                  <span>{prompt.trim().length} characters</span>
                  <span className="mono">{defaultRoute ? `route: ${defaultRoute.name}` : 'no model route yet'}</span>
                </div>
              </div>
            </Panel>

            <Panel title="Loop strategy" className="mt-3">
              <div className="p-3.5">
                <div className="grid grid-cols-3 gap-2">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => setMode(m.value)}
                      className={cn(
                        'rounded-lg border px-3 py-2.5 text-left transition-colors',
                        mode === m.value ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-line2 hover:bg-panel2',
                      )}
                    >
                      <div className="text-[12.5px] font-medium text-fg">{m.label}</div>
                      <div className="mt-0.5 text-[11px] leading-snug text-fgf">{m.hint}</div>
                    </button>
                  ))}
                </div>
                {mode === 'fixed' && (
                  <div className="mt-3 w-40">
                    <Field label="Loops">
                      <Select value={String(loopCount)} onChange={(e) => setLoopCount(Number(e.target.value))}>
                        {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                )}
              </div>
            </Panel>
          </div>

          <div>
            <Panel title="Context">
              <div className="p-3.5">
                <Field label="Title (optional)" hint="Left blank, the refiner suggests one.">
                  <input
                    className="input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Rate limiting for the API"
                  />
                </Field>
                <Field label="Project" hint="Workers edit this folder directly.">
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    className={cn(
                      'input flex cursor-pointer items-center gap-2 text-left',
                      projectIssue && 'border-warn/50',
                    )}
                  >
                    <FolderGit2 size={14} className="shrink-0 text-fgf" />
                    <span className="min-w-0 flex-1 truncate">
                      {selectedProject ? selectedProject.name : 'No project (workspace only)'}
                    </span>
                    <ChevronDown size={14} className="shrink-0 text-fgf" />
                  </button>
                  {selectedProject && (
                    <div className="mono mt-1 truncate text-[11px] text-fgf">{selectedProject.path}</div>
                  )}
                  {projectIssue && <div className="mt-1 text-[11.5px] text-warn">{projectIssue}</div>}
                </Field>
                <Field label="Output language" hint="Language for the prose you read (refined goal, plan, reviews). Worker instructions stay in English.">
                  <Select value={effectiveLanguage} onChange={(e) => setLanguage(e.target.value as OutputLanguage)}>
                    {LANGUAGE_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Starter template" hint="Seeds the goal with extra acceptance criteria.">
                  <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">None</option>
                    {(templates.data ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {selectedTemplate && (
                  <div className="mt-1 rounded-md border border-line bg-panel2/60 p-2.5 text-[11.5px] leading-relaxed text-fgm">
                    {selectedTemplate.description}
                  </div>
                )}
              </div>
            </Panel>

            <div className="mt-4 flex flex-col gap-2">
              {error && <ErrorNote message={error} />}
              <Button variant="primary" onClick={create} disabled={busy || !prompt.trim()} className="justify-center">
                {busy ? 'Creating…' : 'Create job'}
                <ArrowRight size={14} />
              </Button>
              <p className="text-center text-[11.5px] leading-snug text-fgf">
                After creation the job pauses at <span className="text-fgm">awaiting approval</span> until you accept the plan.
              </p>
            </div>
          </div>
        </div>

        <ProjectPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} value={projectId} onSelect={setProjectId} />
      </div>
    </div>
  )
}
