import { Notification } from 'electron'
import type { CloudflareSetup, EmailOptions, EmailOutgoing, EmailSignUp } from '@shared/email'
import { registerToolSource } from '../agent/tools'
import { secrets } from '../secrets'
import { store } from '../store'
import { AgentMailClient } from './email/agentmail'
import { CloudflareMailClient } from './email/cloudflare'
import { EmailService, type EmailNotice } from './email/service'
import { emailToolSource } from './email/tools'
import type { Feature, FeatureContext } from './types'

/**
 * The agent's own email, through AgentMail or on the user's own domain via
 * Cloudflare. The service (`email/service.ts`) holds the account and the
 * rules (the code before sending, the daily cap); this wires it to the vault,
 * the store, notifications and IPC.
 *
 * The keys are in the secrets vault — AgentMail's under `email:agentmail`,
 * the Cloudflare API token under `email:cloudflare` — and the rest is in
 * `email.json`. Nothing is fetched until a few seconds after launch, so the
 * window paints first.
 */

const VAULT_KEY = 'email:agentmail'
const CLOUDFLARE_VAULT_KEY = 'email:cloudflare'
const STATE_FILE = 'email.json'
/** Lets the window load first; the inbox isn't needed to paint it. */
const START_DELAY_MS = 4000

let service: EmailService | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null
/** Held until clicked or closed: a collected notification loses its click handler. */
const notifications = new Set<Notification>()

/** The running service, for other features. Null before registration. */
export function emailService(): EmailService | null {
  return service
}

function focusWindow(ctx: FeatureContext): void {
  const window = ctx.getWindow()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function showNotice(ctx: FeatureContext, notice: EmailNotice): void {
  if (!Notification.isSupported()) return
  // No banner while Eaon is in front: the inbox badge updates live.
  if (ctx.getWindow()?.isFocused()) return
  const notification = new Notification({ title: notice.title, body: notice.body })
  notifications.add(notification)
  notification.on('click', () => {
    notifications.delete(notification)
    focusWindow(ctx)
  })
  notification.on('close', () => notifications.delete(notification))
  notification.show()
}

function stop(): void {
  if (startTimer) clearTimeout(startTimer)
  startTimer = null
  service?.stop()
}

export const emailFeature: Feature = {
  id: 'email',
  register: (ctx) => {
    const email = new EmailService({
      createClient: (key) => new AgentMailClient(key),
      getKey: () => secrets.get(VAULT_KEY) ?? null,
      // An empty value removes it from the vault.
      setKey: (key) => secrets.set(VAULT_KEY, key ?? ''),
      createCloudflare: (token, getConfig, saveConfig, auth) => new CloudflareMailClient(token, getConfig, saveConfig, auth),
      getCloudflareToken: () => secrets.get(CLOUDFLARE_VAULT_KEY) ?? null,
      setCloudflareToken: (token) => secrets.set(CLOUDFLARE_VAULT_KEY, token ?? ''),
      load: () => store.getJson<unknown>(STATE_FILE, null),
      save: (saved) => store.setJson(STATE_FILE, saved),
      notify: (notice) => showNotice(ctx, notice),
      onChange: (state) => ctx.send('email:changed', state)
    })
    service = email
    email.load()
    registerToolSource(emailToolSource(email))

    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    const { ipcMain } = ctx
    ipcMain.handle('email:state', () => email.state())
    ipcMain.handle('email:sign-up', (_e, input: EmailSignUp) => email.signUp(input))
    ipcMain.handle('email:verify', (_e, code: string) => email.verify(text(code)))
    ipcMain.handle('email:resend-code', () => email.resendCode())
    ipcMain.handle('email:use-api-key', (_e, key: string) => email.useApiKey(text(key)))
    ipcMain.handle('email:create-inbox', (_e, input: { username?: string; domain?: string; displayName?: string }) => email.createInbox(input ?? {}))
    ipcMain.handle('email:use-inbox', (_e, id: string) => email.useInbox(text(id)))
    ipcMain.handle('email:add-domain', (_e, domain: string) => email.addDomain(text(domain)))
    ipcMain.handle('email:verify-domain', (_e, id: string) => email.verifyDomain(text(id)))
    ipcMain.handle('email:remove-domain', (_e, id: string) => email.removeDomain(text(id)))
    ipcMain.handle('email:refresh', () => email.refresh())
    ipcMain.handle('email:read', (_e, id: string) => email.read(text(id)))
    ipcMain.handle('email:send', (_e, outgoing: EmailOutgoing) => email.send(outgoing))
    ipcMain.handle('email:set-options', (_e, options: EmailOptions) => email.setOptions(options ?? {}))
    ipcMain.handle('email:disconnect', () => email.disconnect())
    ipcMain.handle('email:cloudflare-zones', (_e, token: string, login?: string) => email.cloudflareZones(text(token), text(login) || undefined))
    ipcMain.handle('email:cloudflare-setup', (_e, input: CloudflareSetup) => email.setUpCloudflare(input))
    ipcMain.handle('email:set-worker-address', (_e, workerId: string, input: { username: string; displayName?: string }) =>
      email.setWorkerAddress(text(workerId), input ?? { username: '' })
    )
    ipcMain.handle('email:remove-worker-address', (_e, workerId: string) => email.removeWorkerAddress(text(workerId)))
    ipcMain.handle('email:add-verified-address', (_e, address: string) => email.addVerifiedAddress(text(address)))

    startTimer = setTimeout(() => {
      startTimer = null
      email.start()
    }, START_DELAY_MS)
    startTimer.unref?.()
  },
  dispose: stop,
  shutdown: async () => stop()
}
