import { useEffect } from 'react'
import { resolveRoute, useRouter } from './state/router'
import { startEventStream } from './state/events'
import { getSettings } from './state/settings'
import { useToasts } from './state/toast'
import { Shell } from './components/Shell'
import { ToastViewport } from './components/ui'
import DashboardPage from './pages/DashboardPage'
import JobsPage from './pages/JobsPage'
import JobDetailPage from './pages/JobDetailPage'
import NewJobPage from './pages/NewJobPage'
import ProjectsPage from './pages/ProjectsPage'
import ProvidersPage from './pages/ProvidersPage'
import KnowledgePage from './pages/KnowledgePage'
import ActivityPage from './pages/ActivityPage'
import OpenCodePage from './pages/OpenCodePage'
import SettingsPage from './pages/SettingsPage'

const PATTERNS = ['/', '/new', '/jobs', '/jobs/:id', '/projects', '/providers', '/opencode', '/knowledge', '/activity', '/settings'] as const

const TITLES: Record<string, { title: string; subtitle?: string }> = {
  '/': { title: 'Dashboard' },
  '/new': { title: 'New job' },
  '/jobs': { title: 'Jobs' },
  '/jobs/:id': { title: 'Job detail' },
  '/projects': { title: 'Projects' },
  '/providers': { title: 'Providers & agents' },
  '/opencode': { title: 'OpenCode monitor' },
  '/knowledge': { title: 'Knowledge' },
  '/activity': { title: 'Activity' },
  '/settings': { title: 'Settings' },
}

export default function App() {
  const path = useRouter((s) => s.path)
  const navigate = useRouter((s) => s.navigate)
  const toasts = useToasts()

  useEffect(() => startEventStream(), [])

  // Accent palette + reduced motion are document-level, so apply them once the
  // settings land and again whenever they change.
  useEffect(() => {
    void getSettings()
  }, [])

  const match = resolveRoute(path, PATTERNS)

  useEffect(() => {
    if (!match) navigate('/', { replace: true })
  }, [match, navigate])

  if (!match) return null

  const meta = TITLES[match.pattern] ?? { title: 'Fern Orchestrator' }

  const page = (() => {
    switch (match.pattern) {
      case '/':
        return <DashboardPage params={match.params} />
      case '/new':
        return <NewJobPage params={match.params} />
      case '/jobs':
        return <JobsPage params={match.params} />
      case '/jobs/:id':
        return <JobDetailPage params={match.params} />
      case '/projects':
        return <ProjectsPage params={match.params} />
      case '/providers':
        return <ProvidersPage params={match.params} />
      case '/opencode':
        return <OpenCodePage params={match.params} />
      case '/knowledge':
        return <KnowledgePage params={match.params} />
      case '/activity':
        return <ActivityPage params={match.params} />
      case '/settings':
        return <SettingsPage params={match.params} />
      default:
        return null
    }
  })()

  return (
    <>
      <Shell title={meta.title} subtitle={'subtitle' in meta ? meta.subtitle : undefined}>
        {page}
      </Shell>
      {/* Fixed-position overlay, so it lives outside the page (and outside any
          element that is animating a transform). */}
      <ToastViewport toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  )
}
