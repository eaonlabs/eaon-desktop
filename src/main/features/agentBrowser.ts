import type { NativeImage } from 'electron'
import {
  AGENT_BROWSER,
  type AgentBrowserFrame,
  type AgentBrowserStatus,
  type AgentBrowserStep,
  type BrowserInput,
  type BrowserTarget
} from '@shared/agentBrowser'
import { registerToolSource, type ToolContext } from '../agent/tools'
import type { Feature, FeatureContext } from './types'
import { browserTool, WorkerBrowsers } from './workers/browser'

/**
 * The chat agent's own browser, and the live view of every agent's browser.
 *
 * The chat agent gets the same BetterWright-driven hidden window workers have
 * (workers/browser.ts), in its own persistent session so it keeps its own
 * logins apart from the user's Chrome and from every worker's. The Chrome
 * extension tool (`browser`) stays for when the user wants the agent in their
 * real browser.
 *
 * The live view works for the chat agent's browser (`'agent'`) and for each
 * worker's (`'worker:<id>'`; the workers service registers its browsers
 * here). While a view is open, every frame the page paints is streamed — the
 * agent's own cursor gliding to what it clicks is drawn into the page, so it
 * shows — at most ~8 a second, scaled and JPEG-encoded. Each step the agent
 * takes is sent too, so the view says what is happening and opens itself the
 * first time the chat agent picks up its browser.
 *
 * "Take control" happens in the view: the user's clicks, scrolls and keys go
 * to the page as real input, and the agent's next step waits until they hand
 * it back (closing the view hands it back too, so the agent is never left
 * waiting on nobody). The real window can still be shown, for a site that
 * needs it.
 */

const AGENT = 'agent'
/** At most this often, in ms: smooth enough to follow the cursor, cheap enough to leave on. */
const FRAME_MS = 120
const FRAME_WIDTH = 1100

let agentBrowsers: WorkerBrowsers | null = null
let workerBrowsers: WorkerBrowsers | null = null
let send: FeatureContext['send'] = () => undefined

interface Watch {
  count: number
  stop: () => void
  latest: NativeImage | null
  timer: ReturnType<typeof setTimeout> | null
  sentAt: number
  lastImage: string
}
const watches = new Map<BrowserTarget, Watch>()

/** The workers service hands over its browsers, so a worker's can be watched and taken over too. */
export function setWorkerBrowsers(browsers: WorkerBrowsers): void {
  workerBrowsers = browsers
}

function resolve(target: BrowserTarget): { browsers: WorkerBrowsers; id: string } | null {
  if (target === AGENT_BROWSER) return agentBrowsers ? { browsers: agentBrowsers, id: AGENT } : null
  const worker = /^worker:(.+)$/.exec(target)
  return worker && workerBrowsers ? { browsers: workerBrowsers, id: worker[1] } : null
}

/** One JPEG data URL, scaled to the view's size; `null` for a blank (not yet painted) frame. */
function encode(image: NativeImage): string | null {
  if (image.isEmpty()) return null
  const { width } = image.getSize()
  const scaled = width > FRAME_WIDTH ? image.resize({ width: FRAME_WIDTH, quality: 'good' }) : image
  return `data:image/jpeg;base64,${scaled.toJPEG(70).toString('base64')}`
}

function sendFrame(target: BrowserTarget, watch: Watch): void {
  watch.timer = null
  const image = watch.latest
  watch.latest = null
  const found = resolve(target)
  const window = found?.browsers.window(found.id)
  if (!image || !found || !window) return
  const data = encode(image)
  if (!data || data === watch.lastImage) return
  watch.lastImage = data
  watch.sentAt = Date.now()
  const frame: AgentBrowserFrame = {
    target,
    url: window.webContents.getURL(),
    title: window.webContents.getTitle(),
    image: data,
    viewport: found.browsers.viewport(found.id),
    at: watch.sentAt
  }
  send('agent-browser:frame', frame)
}

/** Keeps only the newest frame and sends it once the rate allows. */
function onFrame(target: BrowserTarget, image: NativeImage): void {
  const watch = watches.get(target)
  if (!watch) return
  watch.latest = image
  if (watch.timer) return
  watch.timer = setTimeout(() => sendFrame(target, watch), Math.max(0, watch.sentAt + FRAME_MS - Date.now()))
}

function startWatching(target: BrowserTarget): void {
  const found = resolve(target)
  if (!found) return
  let watch = watches.get(target)
  if (watch) {
    watch.count++
    return
  }
  watch = { count: 1, stop: () => undefined, latest: null, timer: null, sentAt: 0, lastImage: '' }
  watches.set(target, watch)
  watch.stop = found.browsers.watchFrames(found.id, (image) => onFrame(target, image))
  // A page that isn't repainting sends no frames: show what is there now.
  void found.browsers.capture(found.id).then(
    (image) => image && onFrame(target, image),
    () => undefined
  )
}

function stopWatching(target: BrowserTarget): void {
  const watch = watches.get(target)
  if (!watch) return
  watch.count = Math.max(0, watch.count - 1)
  if (watch.count > 0) return
  watch.stop()
  if (watch.timer) clearTimeout(watch.timer)
  watches.delete(target)
  // Nobody is looking any more: hand the browser back rather than leave the agent waiting.
  const found = resolve(target)
  if (found?.browsers.controlled(found.id)) {
    found.browsers.releaseControl(found.id)
    pushStatus(target)
  }
}

function status(target: BrowserTarget): AgentBrowserStatus {
  const found = resolve(target)
  const window = found?.browsers.window(found.id)
  return window
    ? { target, open: true, url: window.webContents.getURL(), title: window.webContents.getTitle(), controlled: found!.browsers.controlled(found!.id) }
    : { target, open: false, url: '', title: '', controlled: false }
}

function pushStatus(target: BrowserTarget): void {
  send('agent-browser:status', status(target))
}

/** A step an agent takes in its browser, for the live view. Workers' browsers report through this too. */
export function reportBrowserStep(target: BrowserTarget, ctx: ToolContext, step: { action: string; detail: string; done: boolean }): void {
  const event: AgentBrowserStep = { target, chatId: ctx.request.chatId, action: step.action, detail: step.detail, done: step.done, at: Date.now() }
  send('agent-browser:step', event)
}

export const agentBrowserFeature: Feature = {
  id: 'agent-browser',
  register: (ctx) => {
    send = ctx.send
    agentBrowsers = new WorkerBrowsers({ partition: () => 'persist:eaon-agent', title: 'Eaon’s browser' })
    const tool = browserTool(agentBrowsers, {
      idOf: (toolCtx) => (toolCtx.request.workerId ? null : AGENT),
      signInHint:
        'If a site needs the user to sign in, tell them: they can take control in the live view beside the chat, sign in, and hand it back.',
      onStep: (toolCtx, step) => reportBrowserStep(AGENT_BROWSER, toolCtx, step)
    })
    registerToolSource({
      id: 'agent-browser',
      // The chat agent at the top level only: workers have their own, sub-agents and trading sessions none.
      tools: (query) =>
        query.mode === 'work' && query.depth === 0 && !query.request.workerId && !query.request.chatId.startsWith('trading:') ? [tool] : [],
      guidance: (query) =>
        query.mode === 'work' && query.depth === 0 && !query.request.workerId
          ? `web_browser is your own browser, which the user can watch live beside the chat and take over to help. Use web search to find pages and your browser to act on them (sign-ups, forms, dashboards).${
              query.settings.browserExtension.enabled ? " Use the browser tool (the user's Chrome) only when they ask for it or a site needs their own logins." : ''
            }`
          : null
    })

    const { ipcMain } = ctx
    const targetOf = (value: unknown): BrowserTarget => (typeof value === 'string' && value ? value : AGENT_BROWSER)
    // A view opens and closes; frames flow only while one is open.
    ipcMain.handle('agent-browser:watch', (_e, on: boolean, target?: string) => {
      const which = targetOf(target)
      if (on) startWatching(which)
      else stopWatching(which)
      return status(which)
    })
    ipcMain.handle('agent-browser:status', (_e, target?: string) => status(targetOf(target)))
    // The real window, for a site that needs it. Closing it only hides it again.
    ipcMain.handle('agent-browser:show', (_e, target?: string) => {
      const found = resolve(targetOf(target))
      return found ? found.browsers.show(found.id) : false
    })
    // Take over in the view, or hand back.
    ipcMain.handle('agent-browser:control', (_e, on: boolean, target?: string) => {
      const which = targetOf(target)
      const found = resolve(which)
      if (found) {
        if (on) found.browsers.takeControl(found.id)
        else found.browsers.releaseControl(found.id)
      }
      pushStatus(which)
      return status(which)
    })
    ipcMain.handle('agent-browser:input', (_e, event: BrowserInput, target?: string) => {
      const found = resolve(targetOf(target))
      return found ? found.browsers.input(found.id, event) : false
    })
    ipcMain.handle('agent-browser:navigate', async (_e, url: string, target?: string) => {
      const which = targetOf(target)
      const found = resolve(which)
      const ok = found ? await found.browsers.navigate(found.id, String(url ?? '')) : false
      pushStatus(which)
      return ok
    })
  },
  dispose: () => {
    for (const watch of watches.values()) {
      watch.stop()
      if (watch.timer) clearTimeout(watch.timer)
    }
    watches.clear()
    void agentBrowsers?.closeAll()
  }
}
