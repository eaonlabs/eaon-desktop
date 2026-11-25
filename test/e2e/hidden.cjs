/**
 * Loaded before the app's main script when EAON_E2E_HIDDEN=1 (the harness
 * passes it as NODE_OPTIONS=--require). The app runs as it always does, but
 * nothing of it reaches the screen or the rest of the computer, so the suite
 * can run on a Mac someone is working on:
 *
 * - windows are created and paint (Electron's paintWhenInitiallyHidden), but
 *   are never shown, raised or focused, and there is no Dock icon;
 * - message boxes, file pickers, notifications, Finder reveals, global
 *   shortcuts, login items, the eaon:// handler and permission prompts are
 *   recorded instead of happening (`globalThis.__e2eHidden`).
 *
 * A message box answers with its cancel button (or the first), the way a
 * person dismissing it would. A scenario that needs another answer replaces
 * `dialog.showMessageBox` itself after launch, as it would without this.
 */
const electron = require('electron')
const { app, BrowserWindow, dialog, shell, Notification, globalShortcut, systemPreferences, desktopCapturer } = electron

/** @type {{ kind: string, detail: unknown, at: number }[]} */
const hidden = (globalThis.__e2eHidden = [])
const record = (kind, detail) => {
  hidden.push({ kind, detail, at: Date.now() })
  if (hidden.length > 500) hidden.shift()
}

for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'maximize', 'setFullScreen', 'setSimpleFullScreen', 'flashFrame']) {
  BrowserWindow.prototype[method] = function () {
    record('window', method)
  }
}

if (process.platform === 'darwin') {
  app.dock?.hide()
  if (app.dock) {
    app.dock.show = async () => record('dock', 'show')
    app.dock.bounce = () => (record('dock', 'bounce'), 0)
  }
  app.show = () => record('app', 'show')
}
app.focus = () => record('app', 'focus')
app.setLoginItemSettings = (settings) => record('login-item', settings)
app.setAsDefaultProtocolClient = (protocol) => (record('protocol', protocol), true)

const answer = (options) => ({ response: typeof options?.cancelId === 'number' ? options.cancelId : 0, checkboxChecked: false })
const optionsOf = (args) => (args[0] instanceof BrowserWindow ? args[1] : args[0])
dialog.showMessageBox = async (...args) => {
  const options = optionsOf(args)
  record('message-box', options?.message ?? '')
  return answer(options)
}
dialog.showMessageBoxSync = (...args) => {
  const options = optionsOf(args)
  record('message-box', options?.message ?? '')
  return answer(options).response
}
dialog.showErrorBox = (title, content) => record('error-box', `${title}: ${content}`)
dialog.showOpenDialog = async (...args) => (record('open-dialog', optionsOf(args)?.title ?? ''), { canceled: true, filePaths: [] })
dialog.showOpenDialogSync = (...args) => (record('open-dialog', optionsOf(args)?.title ?? ''), undefined)
dialog.showSaveDialog = async (...args) => (record('save-dialog', optionsOf(args)?.title ?? ''), { canceled: true, filePath: '' })
dialog.showSaveDialogSync = (...args) => (record('save-dialog', optionsOf(args)?.title ?? ''), undefined)

shell.showItemInFolder = (path) => record('show-in-folder', path)
shell.openPath = async (path) => (record('open-path', path), '')
shell.beep = () => record('beep', '')

Notification.prototype.show = function () {
  record('notification', this.title)
}

globalShortcut.register = (accelerator) => (record('global-shortcut', accelerator), true)
globalShortcut.registerAll = (accelerators) => record('global-shortcut', accelerators)

if (process.platform === 'darwin') {
  systemPreferences.isTrustedAccessibilityClient = (prompt) => (prompt && record('accessibility-prompt', ''), false)
  systemPreferences.askForMediaAccess = async (media) => (record('media-prompt', media), false)
}
desktopCapturer.getSources = async () => (record('screen-capture', ''), [])
