import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUFFERED_EVENTS_CHANNEL, EVENT_CHANNEL } from '@shared/ipc'
import type { AppConfig } from '@core/kernel/config'
import { createContext, type AppContext } from './context'
import { registerIpc } from './ipc/router'
import { appHandlers } from './ipc/handlers/app'
import { projectHandlers } from './ipc/handlers/projects'
import { providerHandlers, seedBuiltins } from './ipc/handlers/providers'
import { jobHandlers } from './ipc/handlers/jobs'
import { artifactHandlers } from './ipc/handlers/artifacts'
import { obsidianHandlers } from './ipc/handlers/obsidian'
import { opencodeHandlers } from './ipc/handlers/opencode'

const moduleDir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))

/** 32×32 tray/app mark, generated once — no asset files to lose. */
const TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAnElEQVR4nO3XMQ6AIAyFYRYv4gGcvKzn8iLMJkY3E2PBV5q21GjSlf8bFCEl4pnX5dAYqmUShiBWcRJhHX8gXAFe8QsREpD3jRx1QCksgcAANM5FQABunIN4BbTGUUQzYJjG26gA0LgEwQaU4jXED/gWwPQldP8MawCzjUiCQNaO8TPiIjhrxjqQaIw/wP1Y3gXA/WrWxeXUAkK1Tvn/wB/FLN4oAAAAAElFTkSuQmCC'

let ctx: AppContext | null = null
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let shuttingDown = false
let quitRequested = false

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!ctx) void boot()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function ensureTray(): void {
  if (tray) return
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON))
  tray.setToolTip('Fern Orchestrator')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Fern Orchestrator', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => {
        quitRequested = true
        app.quit()
      } },
    ]),
  )
  tray.on('click', () => showWindow())
}

/**
 * `general.launchAtLogin` — only meaningful for a packaged build; in dev we
 * would be registering the Electron binary itself, so it is skipped there.
 */
function applyLoginItem(cfg: AppConfig): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: Boolean(cfg.general.launchAtLogin) })
}

function resolvePreload(): string {
  const candidates = ['index.js', 'index.mjs', 'index.cjs'].map((f) => join(moduleDir, '..', 'preload', f))
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a0a0b',
    title: 'Fern Orchestrator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // `general.minimizeToTray`: closing hides the window (and raises the tray
  // icon) instead of quitting, so runs keep going in the background.
  win.on('close', (e) => {
    if (quitRequested || !ctx?.config.get().general.minimizeToTray) return
    e.preventDefault()
    ensureTray()
    win.hide()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    // renderer may only hand external URLs to the OS, never open new windows
    if (/^https?:\/\//i.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url))
    return { action: 'deny' }
  })

  win.webContents.on('did-finish-load', () => {
    if (!ctx) return
    win.webContents.send(BUFFERED_EVENTS_CHANNEL, ctx.events.recent(500))
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(moduleDir, '../renderer/index.html'))
  }

  return win
}

function registerHandlers(context: AppContext): void {
  registerIpc({
    ...appHandlers(context),
    ...projectHandlers(context),
    ...providerHandlers(context),
    ...jobHandlers(context),
    ...artifactHandlers(context),
    ...obsidianHandlers(context),
    ...opencodeHandlers(context),
  })
}

async function boot(): Promise<void> {
  const context = await createContext()
  ctx = context

  seedBuiltins(context)
  registerHandlers(context)

  applyLoginItem(context.config.get())
  context.onSettingsChanged = (cfg) => {
    applyLoginItem(cfg)
    if (!cfg.general.minimizeToTray && tray) {
      tray.destroy()
      tray = null
    }
  }

  context.setDesktopNotifier((n) => {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: n.title,
      body: n.body || (n.severity === 'error' ? 'Something went wrong' : 'Fern Orchestrator'),
    })
    notification.on('click', () => showWindow())
    notification.show()
  })

  // fan the bus out to every open window
  context.events.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event)
    }
  })

  context.vaults.watchAll()
  context.vaults.onChange((vaultId, relPath) => {
    context.emit('obsidian.note.changed', { message: `note changed: ${relPath}`, data: { vaultId, relPath } })
  })

  context.log('app').info('boot complete', { version: app.getVersion(), platform: process.platform })
  mainWindow = createWindow()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(boot).catch((err) => {
    console.error('boot failed', err)
    app.exit(1)
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (shuttingDown) return
    if (!ctx) return
    event.preventDefault()
    shuttingDown = true
    const context = ctx
    ctx = null
    void context
      .shutdown()
      .catch((err) => context.logger.error('shutdown error', { error: String(err) }))
      .finally(() => app.exit(0))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void boot()
    else showWindow()
  })
}
