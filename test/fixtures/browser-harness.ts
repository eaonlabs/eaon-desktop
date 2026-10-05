/**
 * Runs inside real Electron (spawned by agentBrowser-live.test.ts): the
 * agent's web_browser tool over real BetterWright, against the local site in
 * browser-site.mjs. Each step's result goes to HARNESS_OUT as JSON, keyed by
 * name, for the test to check. Nothing here touches a real profile:
 * userData is HARNESS_PROFILE.
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserTool, WorkerBrowsers } from '../../src/main/features/workers/browser'
// @ts-expect-error plain JS fixture module
import { startFixtures } from './browser-site.mjs'

const profile = process.env.HARNESS_PROFILE!
app.setPath('userData', profile)
// BetterWright refuses to attach without these (configureElectronNetwork in the app).
app.commandLine.appendSwitch('disable-quic')
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')
app.on('window-all-closed', () => undefined)

type Step = { ok: boolean; ms: number; text: string; extra?: unknown }
const out: Record<string, Step> = {}

function ctxFor(workerId: string, signal = new AbortController().signal, runId = 'm1', title = 'Harness'): never {
  return {
    request: { chatId: `chat-${workerId}`, messageId: runId, chatTitle: title, workerId },
    turn: { notes: [] },
    cwd: join(profile, 'work'),
    signal,
    emit: () => undefined,
    toolId: 't',
    depth: 0,
    readOnly: false,
    settings: {},
    progress: () => undefined,
    confirm: async () => true
  } as never
}

async function main(): Promise<void> {
  await app.whenReady()
  app.dock?.hide()
  mkdirSync(join(profile, 'work'), { recursive: true })
  const site = await startFixtures()
  const base: string = site.base
  const browsers = new WorkerBrowsers({ openTimeoutMs: 6000 })
  const tool = browserTool(browsers, { idOf: (ctx: { request: { workerId?: string } }) => ctx.request.workerId ?? null, signInHint: '' } as never)

  const step = async (name: string, input: Record<string, unknown>, worker = 'w1', signal?: AbortSignal): Promise<string> => {
    const started = Date.now()
    let text = ''
    let ok = true
    try {
      const result = await Promise.race([
        Promise.resolve(tool.run(input, ctxFor(worker, signal))),
        new Promise((_, reject) => setTimeout(() => reject(new Error('harness step timed out after 60 s')), 60_000))
      ])
      const normalized = typeof result === 'string' ? { text: result } : (result as { text: string; isError?: boolean })
      text = normalized.text
      ok = !normalized.isError
    } catch (error) {
      ok = false
      text = `Error: ${error instanceof Error ? error.message : String(error)}`
    }
    out[name] = { ok, ms: Date.now() - started, text: text.slice(0, 2000) }
    return text
  }
  const note = (name: string, extra: unknown): void => {
    out[name] = { ok: true, ms: 0, text: '', extra }
  }
  const ref = (snapshot: string, label: RegExp): string | undefined => {
    for (const line of snapshot.split('\n')) if (label.test(line)) return /\[ref=([^\]]+)\]/.exec(line)?.[1]
    return undefined
  }
  const visibleWindows = (): number => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length

  try {
    // New tabs and popups open in place; no window appears.
    let s = await step('newtab.open', { action: 'open', url: `${base}/newtab` })
    await step('newtab.blank', { action: 'click', ref: ref(s, /link "Open landing/) })
    s = await step('newtab.back', { action: 'back' })
    await step('newtab.popup', { action: 'click', ref: ref(s, /button "Open popup"/) })
    note('newtab.windows', { visible: visibleWindows(), all: BrowserWindow.getAllWindows().length })

    // File picker intercepted, upload fills it.
    s = await step('upload.open', { action: 'open', url: `${base}/upload` })
    const input = ref(s, /button "Attachment"/)
    await step('upload.click', { action: 'click', ref: input })
    note('upload.windows', { visible: visibleWindows() })
    writeFileSync(join(profile, 'work', 'cv.txt'), 'hello upload')
    await step('upload.choose', { action: 'upload', ref: input, path: 'cv.txt' })
    await step('upload.read', { action: 'read' })

    // Downloads described, then saved with the session's cookies.
    s = await step('download.open', { action: 'open', url: `${base}/download` })
    await step('download.click', { action: 'click', ref: ref(s, /link "Get the report"/) })
    await step('download.save', { action: 'download' })
    await step('download.private', { action: 'download', url: `${base}/private.pdf` })

    // Sign-in persists in its own browser and nowhere else.
    s = await step('login.open', { action: 'open', url: `${base}/login` })
    await step('login.type', { action: 'type', ref: ref(s, /textbox "Username"/), text: 'nova', submit: true })
    await step('login.privateAfter', { action: 'download', url: `${base}/private.pdf`, save_to: 'files/' })
    await browsers.close('w1')
    await step('login.reopen', { action: 'open', url: `${base}/cookie` })
    await step('login.readAfterClose', { action: 'read' })
    await step('login.otherOpen', { action: 'open', url: `${base}/cookie` }, 'w2')
    await step('login.otherRead', { action: 'read' }, 'w2')

    // Failures the model can act on.
    s = await step('stale.open', { action: 'open', url: `${base}/stale` })
    const alpha = ref(s, /button "Alpha"/)
    await step('stale.refresh', { action: 'click', ref: ref(s, /button "Refresh list"/) })
    await step('stale.click', { action: 'click', ref: alpha })
    s = await step('overlay.open', { action: 'open', url: `${base}/overlay` })
    await step('overlay.click', { action: 'click', ref: ref(s, /button "Covered button"/) })
    s = await step('disabled.open', { action: 'open', url: `${base}/disabled` })
    await step('disabled.click', { action: 'click', ref: ref(s, /button "Submit order form"/) })
    await step('blocked.open', { action: 'open', url: `${base}/blocked` })
    await step('notfound.open', { action: 'open', url: `${base}/nope` })
    await step('dns.open', { action: 'open', url: 'http://does-not-exist.invalid/' })
    await step('slow.open', { action: 'open', url: `${base}/slow` })
    s = await step('shadow.open', { action: 'open', url: `${base}/shadow` })
    await step('shadow.find', { action: 'find', text: 'Shadow button' })
    await step('iframe.open', { action: 'open', url: `${base}/iframe` })
    await step('iframe.clickWords', { action: 'click', text: 'Inner button' })
    s = await step('hydrate.open', { action: 'open', url: `${base}/hydrate` })
    await step('hydrate.click', { action: 'click', ref: ref(s, /button "Load more"/) })

    // Repeating a failing click, page reopened in between, is stopped.
    for (let i = 0; i < 4; i++) {
      s = await step(`loop.open${i}`, { action: 'open', url: `${base}/overlay` })
      await step(`loop.click${i}`, { action: 'click', ref: ref(s, /button "Covered button"/) })
    }

    // A crashed page is reopened at the next step; the other worker's browser is untouched.
    await step('crash.open', { action: 'open', url: `${base}/landing` })
    await step('crash.otherOpen', { action: 'open', url: `${base}/about` }, 'w2')
    const pid = browsers.window('w1')!.webContents.getOSProcessId()
    if (pid > 0) process.kill(pid, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 800))
    await step('crash.next', { action: 'snapshot' })
    await step('crash.after', { action: 'open', url: `${base}/about` })
    await step('crash.other', { action: 'snapshot' }, 'w2')

    // Stop ends an open that is waiting on a silent server.
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 1000)
    await step('abort.open', { action: 'open', url: `${base}/slow` }, 'w1', stop.signal)
  } catch (error) {
    out.harness = { ok: false, ms: 0, text: String(error) }
  }
  writeFileSync(process.env.HARNESS_OUT!, JSON.stringify(out, null, 2))
  await browsers.closeAll()
  site.server.closeAllConnections?.()
  site.server.close()
  app.exit(0)
}

main().catch((error) => {
  writeFileSync(process.env.HARNESS_OUT!, JSON.stringify({ harness: { ok: false, ms: 0, text: String(error) } }))
  app.exit(1)
})
