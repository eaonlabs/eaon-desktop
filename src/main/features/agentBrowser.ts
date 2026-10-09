import type { NativeImage, WebContents } from 'electron'
import {
  AGENT_BROWSER,
  type AgentBrowserFrame,
  type AgentBrowserStatus,
  type AgentBrowserStep,
  type BrowserInput,
  type BrowserTarget
} from '@shared/agentBrowser'
import { isRunning } from '../agent/loop'
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
 * here). While a view is open the page is pictured ~8 times a second as the
 * agent takes a step or the user has control — the agent's own cursor gliding
 * to what it clicks is drawn into the page, so it shows — and once after
 * (workers/browser.ts, `watchFrames`). Each picture is scaled, JPEG-encoded
 * only if it changed, and sent only to the windows watching that browser.
 * Each step the agent takes is sent to every window, so the view says what is
 * happening and opens itself the first time the chat agent picks up its
 * browser.
 *
 * "Take control" happens in the view: the user's clicks, scrolls and keys go
 * to the page as real input, and the agent's next step waits until they hand
 * it back (closing the view hands it back too, so the agent is never left
 * waiting on nobody). The real window can still be shown, for a site that
 * needs it.
 */

const AGENT = 'agent'
const FRAME_WIDTH = 1100

let agentBrowsers: WorkerBrowsers | null = null
let workerBrowsers: WorkerBrowsers | null = null
let send: FeatureContext['send'] = () => undefined

interface Watch {
  /** The windows with a view open on this browser, by webContents id, and how many views each has. */
  viewers: Map<number, { contents: WebContents; count: number }>
  stop: () => void
  /** The latest frame sent, for a view that opens while the page is still. */
  frame: AgentBrowserFrame | null
  /** Its pixels, scaled, so an unchanged picture is told apart before it is encoded. */
  pixels: Buffer | null
}
const watches = new Map<BrowserTarget, Watch>()
/**
 * Every window with a view open, and what stops listening for it going away:
 * a window that closes, crashes or reloads never says it closed its views,
 * and each one left behind kept its browser streaming for the rest of the run.
 */
const viewers = new Map<number, () => void>()

/** The workers service hands over its browsers, so a worker's can be watched and taken over too. */
export function setWorkerBrowsers(browsers: WorkerBrowsers): void {
  workerBrowsers = browsers
}

function resolve(target: BrowserTarget): { browsers: WorkerBrowsers; id: string } | null {
  if (target === AGENT_BROWSER) return agentBrowsers ? { browsers: agentBrowsers, id: AGENT } : null
  const worker = /^worker:(.+)$/.exec(target)
  return worker && workerBrowsers ? { browsers: workerBrowsers, id: worker[1] } : null
}

/** One picture to the windows watching `target`: scaled to the view's size, and encoded only if it changed. */
function sendFrame(target: BrowserTarget, image: NativeImage): void {
  const watch = watches.get(target)
  const found = resolve(target)
  if (!watch || !found || image.isEmpty()) return
  const { width } = image.getSize()
  const scaled = width > FRAME_WIDTH ? image.resize({ width: FRAME_WIDTH, quality: 'good' }) : image
  // Most pictures between the agent's moves are the page as it was; comparing pixels costs a fraction of a JPEG.
  const pixels = scaled.toBitmap()
  if (watch.pixels?.equals(pixels)) return
  watch.pixels = pixels
  const frame: AgentBrowserFrame = {
    target,
    ...found.browsers.page(found.id),
    image: `data:image/jpeg;base64,${scaled.toJPEG(70).toString('base64')}`,
    viewport: found.browsers.viewport(found.id),
    at: Date.now()
  }
  watch.frame = frame
  for (const viewer of watch.viewers.values()) if (!viewer.contents.isDestroyed()) viewer.contents.send('agent-browser:frame', frame)
}

function startWatching(target: BrowserTarget, sender: WebContents): void {
  const found = resolve(target)
  if (!found) return
  let watch = watches.get(target)
  if (!watch) {
    watch = { viewers: new Map(), stop: () => undefined, frame: null, pixels: null }
    watches.set(target, watch)
    // It sends what is there now, then pictures as things happen.
    watch.stop = found.browsers.watchFrames(found.id, (image) => sendFrame(target, image))
  } else if (watch.frame) {
    // Another view on a browser already watched: what the others see, now.
    sender.send('agent-browser:frame', watch.frame)
  }
  const viewer = watch.viewers.get(sender.id)
  if (viewer) viewer.count++
  else watch.viewers.set(sender.id, { contents: sender, count: 1 })
  follow(sender)
}

function stopWatching(target: BrowserTarget, senderId: number): void {
  const watch = watches.get(target)
  const viewer = watch?.viewers.get(senderId)
  if (!watch || !viewer) return
  viewer.count--
  if (viewer.count <= 0) watch.viewers.delete(senderId)
  if (watch.viewers.size === 0) unwatch(target, watch)
  if (![...watches.values()].some((w) => w.viewers.has(senderId))) unfollow(senderId)
}

/** The last view of a browser has gone. */
function unwatch(target: BrowserTarget, watch: Watch): void {
  watch.stop()
  watches.delete(target)
  // Nobody is looking any more: hand the browser back rather than leave the agent waiting.
  const found = resolve(target)
  if (found?.browsers.controlled(found.id)) {
    found.browsers.releaseControl(found.id)
    pushStatus(target)
  }
}

/** A window that closed, crashed or reloaded: its views go with it. */
function dropViewer(senderId: number): void {
  for (const [target, watch] of [...watches]) {
    if (watch.viewers.delete(senderId) && watch.viewers.size === 0) unwatch(target, watch)
  }
  unfollow(senderId)
}

function follow(sender: WebContents): void {
  const id = sender.id
  if (viewers.has(id)) return
  const gone = (): void => dropViewer(id)
  // A reload, not a route change inside the app (those stay in the same document).
  const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) dropViewer(id)
  }
  sender.once('destroyed', gone)
  sender.on('render-process-gone', gone)
  sender.on('did-start-navigation', navigated)
  viewers.set(id, () => {
    sender.removeListener('destroyed', gone)
    sender.removeListener('render-process-gone', gone)
    sender.removeListener('did-start-navigation', navigated)
  })
}

function unfollow(senderId: number): void {
  viewers.get(senderId)?.()
  viewers.delete(senderId)
}

function status(target: BrowserTarget): AgentBrowserStatus {
  const found = resolve(target)
  if (!found?.browsers.window(found.id)) return { target, open: false, url: '', title: '', controlled: false }
  return { target, open: true, ...found.browsers.page(found.id), controlled: found.browsers.controlled(found.id) }
}

function pushStatus(target: BrowserTarget): void {
  send('agent-browser:status', status(target))
}

/** The browser a tool call's agent owns: a worker's own, else the chat agent's. */
function browserOf(ctx: ToolContext): { browsers: WorkerBrowsers; id: string } | null {
  if (ctx.request.workerId) return workerBrowsers ? { browsers: workerBrowsers, id: ctx.request.workerId } : null
  return agentBrowsers ? { browsers: agentBrowsers, id: AGENT } : null
}

/** The page the calling agent's browser is on; null when it has none open. */
export function agentBrowserUrl(ctx: ToolContext): string | null {
  const found = browserOf(ctx)
  const url = found ? found.browsers.url(found.id) : ''
  return url && url !== 'about:blank' ? url : null
}

/** Types a value the model must not see (card details) into a ref of the calling agent's browser. */
export async function typeSecretInAgentBrowser(ctx: ToolContext, ref: string, value: string): Promise<void> {
  const found = browserOf(ctx)
  if (!found) throw new Error('This agent has no browser of its own.')
  reportBrowserStep(ctx.request.workerId ? `worker:${ctx.request.workerId}` : AGENT_BROWSER, ctx, { action: 'type', detail: 'card details', done: false })
  try {
    await found.browsers.fillSecret(found.id, ref, value)
  } finally {
    reportBrowserStep(ctx.request.workerId ? `worker:${ctx.request.workerId}` : AGENT_BROWSER, ctx, { action: 'type', detail: 'card details', done: true })
  }
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
      // Every chat (and scheduled task) shares this one browser, one at a time.
      shared: { alive: isRunning },
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
              query.settings.browserUse.enabled ? " Use the browser_* tools (the user's own browser) only when they ask for it or a site needs their own logins." : ''
            }`
          : null
    })

    const { ipcMain } = ctx
    const targetOf = (value: unknown): BrowserTarget => (typeof value === 'string' && value ? value : AGENT_BROWSER)
    // A view opens and closes; frames flow only while one is open, and only to its window.
    ipcMain.handle('agent-browser:watch', (event, on: boolean, target?: string) => {
      const which = targetOf(target)
      if (on) startWatching(which, event.sender)
      else stopWatching(which, event.sender.id)
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
    for (const watch of watches.values()) watch.stop()
    watches.clear()
    for (const id of [...viewers.keys()]) unfollow(id)
    void agentBrowsers?.closeAll()
  }
}
