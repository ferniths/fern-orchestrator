import {
  Activity as ActivityIcon,
  BookOpen,
  Cpu,
  FolderGit2,
  LayoutDashboard,
  ListChecks,
  Settings as SettingsIcon,
  Terminal,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  path: string
  label: string
  icon: LucideIcon
}

export const NAV: readonly NavItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/jobs', label: 'Jobs', icon: ListChecks },
  { path: '/projects', label: 'Projects', icon: FolderGit2 },
  { path: '/providers', label: 'Providers', icon: Cpu },
  { path: '/opencode', label: 'OpenCode', icon: Terminal },
  { path: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { path: '/activity', label: 'Activity', icon: ActivityIcon },
  { path: '/settings', label: 'Settings', icon: SettingsIcon },
]
