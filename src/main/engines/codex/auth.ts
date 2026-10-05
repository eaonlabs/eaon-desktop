import type { EngineAuth } from '@shared/engines'
import { EngineError, type EngineBilling } from '../types'
import { RpcError, type AppServer } from './appServer'
import type { AccountLoginCompletedNotification, GetAccountResponse, LoginAccountResponse } from './protocol'

/**
 * Codex's own sign-in, read and started through its app-server. Eaon never
 * reads Codex's tokens (`~/.codex/auth.json` stays Codex's): it asks Codex
 * who is signed in, and for a ChatGPT sign-in it lets Codex run its own
 * browser flow.
 */

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
  edu_plus: 'Edu Plus',
  edu_pro: 'Edu Pro',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  enterprise_cbp_automation: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  ent26: 'Enterprise'
}

export function planLabel(plan: string | null | undefined): string | null {
  if (!plan || plan === 'unknown') return null
  return PLAN_LABEL[plan] ?? plan.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/**
 * Who Codex is signed in as. `requiresOpenaiAuth: false` means Codex is set up
 * with a provider that needs no OpenAI account (a local model, a custom
 * endpoint), so there is nothing to sign in to.
 */
export function authFromAccount(read: GetAccountResponse): EngineAuth {
  const account = read?.account ?? null
  if (!account) {
    return read?.requiresOpenaiAuth === false
      ? { state: 'not-required', method: null, plan: null }
      : { state: 'signed-out', method: null, plan: null }
  }
  switch (account.type) {
    case 'chatgpt':
      return { state: 'signed-in', method: 'ChatGPT', plan: planLabel((account as { planType?: string }).planType) }
    case 'apiKey':
      return { state: 'signed-in', method: 'API key', plan: null }
    case 'amazonBedrock':
      return { state: 'signed-in', method: 'Amazon Bedrock', plan: null }
    default:
      return { state: 'signed-in', method: account.type, plan: null }
  }
}

/** Who pays for a turn, from the same account answer. */
export function billingFor(read: GetAccountResponse | null): EngineBilling {
  if (!read) return 'unknown'
  if (!read.account) return read.requiresOpenaiAuth === false ? 'provider' : 'unknown'
  if (read.account.type === 'chatgpt') return 'plan'
  if (read.account.type === 'apiKey') return 'api-key'
  return 'provider'
}

/** Words a refused (rather than unreachable) ChatGPT session shows up as. */
const AUTH_REFUSED = /\b401\b|unauthori[sz]ed|refresh[_ ]token|token (has )?(expired|is invalid|was revoked)|session (has )?expired|sign(ed)? in again|log ?in again|re-?authenticat|invalidated|revoked/i

export function isAuthRefusal(message: string): boolean {
  return AUTH_REFUSED.test(message)
}

/**
 * Tells "signed in" from "signed in once, session now dead". Codex keeps
 * reporting a ChatGPT account from its saved file even after the session
 * expired; the first call that uses it is what fails. Reading the plan's
 * usage limits is such a call, and a cheap one. A network failure says
 * nothing about the session, so it leaves the answer at signed-in.
 */
export async function checkChatgptSession(server: AppServer, timeoutMs = 10_000): Promise<'ok' | 'expired' | 'unknown'> {
  try {
    await server.request('account/rateLimits/read', undefined, timeoutMs)
    return 'ok'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return isAuthRefusal(message) ? 'expired' : 'unknown'
  }
}

/* ------------------------------------------------------------------- login */

/** Long enough to create an account and pass two-factor; the page can be retried. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000

export interface LoginHandle {
  /** Resolves once Codex reports the sign-in finished; rejects with an EngineError otherwise. */
  done: Promise<void>
  cancel: () => Promise<void>
}

/**
 * Starts Codex's ChatGPT browser sign-in (`account/login/start`): Codex opens
 * a local callback server and hands back the page to open; it saves the
 * session itself and reports `account/login/completed`.
 */
export async function startChatgptLogin(
  server: AppServer,
  openExternal: (url: string) => void | Promise<void>,
  timeoutMs = LOGIN_TIMEOUT_MS
): Promise<LoginHandle> {
  // Listen before asking, so a completion that races the response isn't missed.
  const completions: AccountLoginCompletedNotification[] = []
  let onCompleted: ((n: AccountLoginCompletedNotification) => void) | null = null
  const unsubscribe = server.onNotification((method, params) => {
    if (method !== 'account/login/completed') return
    const n = params as AccountLoginCompletedNotification
    if (onCompleted) onCompleted(n)
    else completions.push(n)
  })

  let started: LoginAccountResponse
  try {
    started = await server.request<LoginAccountResponse>('account/login/start', { type: 'chatgpt' }, 30_000)
  } catch (error) {
    unsubscribe()
    if (error instanceof RpcError && error.code === -32601) {
      throw new EngineError('signed-out', 'This Codex can’t sign in from Eaon. Run "codex login" in a terminal, then press Refresh.', error.message)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new EngineError(
      'signed-out',
      /1455|address (already )?in use|port/i.test(message)
        ? 'Codex couldn’t start its sign-in page: another sign-in (Codex, ChatGPT or Eaon’s ChatGPT provider) is already waiting on the same port. Finish or close it, then try again.'
        : 'Codex couldn’t start signing in.',
      message
    )
  }
  if (started.type !== 'chatgpt' || !started.authUrl || !started.loginId) {
    unsubscribe()
    throw new EngineError('signed-out', 'Codex answered the sign-in request in a way Eaon doesn’t understand.', JSON.stringify(started))
  }
  const loginId = started.loginId

  let settle!: { resolve: () => void; reject: (error: Error) => void }
  const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
  let finished = false
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopExit: () => void = () => {}
  const finish = (error: Error | null): void => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    unsubscribe()
    stopExit()
    if (error) settle.reject(error)
    else settle.resolve()
  }
  const handle = (n: AccountLoginCompletedNotification): void => {
    if (n.loginId && n.loginId !== loginId) return
    if (n.success) finish(null)
    else finish(new EngineError('signed-out', cancelled ? 'Sign-in cancelled.' : 'Signing in to ChatGPT didn\u2019t finish.', n.error ?? undefined))
  }
  timer = setTimeout(() => {
    void server.request('account/login/cancel', { loginId }, 5000).catch(() => {})
    finish(new EngineError('signed-out', 'Sign-in timed out. Try again when you\u2019re ready to finish it in the browser.'))
  }, timeoutMs)
  stopExit = server.onExit(() => finish(new EngineError('engine-crashed', 'Codex stopped while waiting for the sign-in to finish.')))
  onCompleted = handle
  for (const n of completions.splice(0)) handle(n)

  if (!finished) {
    try {
      await openExternal(started.authUrl)
    } catch (error) {
      finish(new EngineError('signed-out', 'Eaon couldn’t open the sign-in page in your browser.', String(error)))
    }
  }

  return {
    done,
    cancel: async () => {
      if (finished) return
      cancelled = true
      await server.request('account/login/cancel', { loginId }, 5000).catch(() => {})
      // Codex answers a cancel with a failed completion; if it doesn't, stop waiting anyway.
      finish(new EngineError('signed-out', 'Sign-in cancelled.'))
    }
  }
}
