import { DurableObject } from 'cloudflare:workers'
import type { Env, User } from './auth'
import { checkNothing, checkPassword, hashPassword, totpStep, unseal, type PasswordHash } from './password'

/**
 * Password sign-in, added to a GitHub account. You sign in with GitHub, set a
 * password (and optionally 2-step codes) at /security, and from then on can
 * sign in with your GitHub username and that password. The account is still
 * the GitHub one: same computers, same shares.
 *
 * Passwords has two kinds of instance:
 *   name:<username, lowercase>  the password, the 2-step secret, and the
 *                               failed tries for that username
 *   uid:<GitHub id>             which username the account uses, and its
 *                               session version (bumped when the password or
 *                               2-step changes, which signs out every session
 *                               that came from a password)
 * A username that was never set behaves like one with a wrong password: same
 * answer, same time, same lockout, so trying names tells nobody which exist.
 *
 * Throttle has one instance per IP address (an IPv6 /64), counting sign-in
 * tries from it across every username.
 */

export interface Credential {
  uid: string
  login: string
  avatar: string
  password: PasswordHash
  /** The 2-step secret, sealed (password.ts); null when 2-step is off. */
  totp: string | null
  /** The last 2-step step used, so no code works twice. */
  usedStep: number
  setAt: number
}

export interface Owner {
  name: string | null
  version: number
  /** A 2-step secret being set up, until its first code confirms it. */
  pending: { sealed: string; exp: number } | null
}

interface Tries {
  count: number
  last: number
  until: number
}

/** Five wrong tries are free; then each one locks the username for twice as long, up to a day. */
const FREE_TRIES = 5
const MAX_LOCK_MS = 24 * 60 * 60_000
const FORGET_TRIES_MS = 24 * 60 * 60_000

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const waitText = (ms: number): string => {
  const min = Math.ceil(ms / 60_000)
  return min >= 60 ? `${Math.ceil(min / 60)} hour${min > 60 ? 's' : ''}` : `${min} minute${min > 1 ? 's' : ''}`
}

const WRONG = 'Wrong username or password.'

export class Passwords extends DurableObject<Env> {
  /** The Worker refuses password requests before they get here when it's unset. */
  private get pepper(): string {
    if (!this.env.PASSWORD_PEPPER) throw new Error('PASSWORD_PEPPER is not set')
    return this.env.PASSWORD_PEPPER
  }

  private async tries(): Promise<Tries> {
    const t = await this.ctx.storage.get<Tries>('tries')
    return t && Date.now() - t.last < FORGET_TRIES_MS ? t : { count: 0, last: 0, until: 0 }
  }

  private async failed(): Promise<void> {
    const now = Date.now()
    const t = await this.tries()
    t.count += 1
    t.last = now
    t.until = t.count >= FREE_TRIES ? now + Math.min(60_000 * 2 ** (t.count - FREE_TRIES), MAX_LOCK_MS) : 0
    await this.ctx.storage.put('tries', t)
    // A username with no password keeps nothing once its tries are forgotten.
    if (!(await this.ctx.storage.get('cred'))) await this.ctx.storage.setAlarm(now + FORGET_TRIES_MS)
  }

  private async check(body: Record<string, unknown>): Promise<Response> {
    const pepper = this.pepper
    const t = await this.tries()
    if (t.until > Date.now()) return json({ error: `Too many wrong tries. Wait ${waitText(t.until - Date.now())}, or sign in with GitHub.` }, 429)
    const cred = await this.ctx.storage.get<Credential>('cred')
    const password = String(body.password ?? '')
    const ok = cred ? await checkPassword(pepper, password, cred.password) : await checkNothing(pepper, password)
    if (!ok || !cred) {
      await this.failed()
      return json({ error: WRONG }, 401)
    }
    if (cred.totp) {
      const code = String(body.code ?? '').replace(/\s/g, '')
      // The password was right: ask for the code, without counting a try.
      if (!code) return json({ need: 'code' })
      const step = await totpStep(await unseal(pepper, cred.totp), code, Date.now(), cred.usedStep)
      if (step === null) {
        await this.failed()
        return json({ error: 'That code isn’t right. Use the newest one in your authenticator app.', code: true }, 401)
      }
      cred.usedStep = step
      await this.ctx.storage.put('cred', cred)
    }
    await this.ctx.storage.delete('tries')
    const user: User = { uid: cred.uid, login: cred.login, avatar: cred.avatar }
    return json({ user })
  }

  async alarm(): Promise<void> {
    if (!(await this.ctx.storage.get('cred'))) await this.ctx.storage.deleteAll()
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}

    // ---- a username's instance
    // One check at a time per username: tries sent all at once can't slip past the lockout.
    if (url.pathname === '/check') return this.ctx.blockConcurrencyWhile(() => this.check(body))

    if (url.pathname === '/set') {
      const old = await this.ctx.storage.get<Credential>('cred')
      // The same account changing its password keeps 2-step. A GitHub login now
      // owned by someone else (renamed and taken) starts fresh for its new owner.
      const keep = old?.uid === body.uid ? old : null
      const cred: Credential = {
        uid: String(body.uid),
        login: String(body.login),
        avatar: String(body.avatar ?? ''),
        password: await hashPassword(this.pepper, String(body.password ?? '')),
        totp: keep?.totp ?? null,
        usedStep: keep?.usedStep ?? 0,
        setAt: Date.now()
      }
      await this.ctx.storage.put('cred', cred)
      await this.ctx.storage.delete('tries')
      await this.ctx.storage.deleteAlarm()
      return json({ ok: true, replaced: old && !keep ? old.uid : null })
    }

    const mine = async (): Promise<Credential | null> => {
      const cred = await this.ctx.storage.get<Credential>('cred')
      return cred && cred.uid === String(body.uid ?? url.searchParams.get('uid')) ? cred : null
    }

    if (url.pathname === '/remove') {
      if (await mine()) await this.ctx.storage.deleteAll()
      return json({ ok: true })
    }

    if (url.pathname === '/totp') {
      const cred = await mine()
      if (!cred) return json({ error: 'Set a password first.' }, 409)
      cred.totp = typeof body.sealed === 'string' ? body.sealed : null
      cred.usedStep = Number(body.usedStep ?? cred.usedStep) || 0
      await this.ctx.storage.put('cred', cred)
      return json({ ok: true })
    }

    if (url.pathname === '/info') {
      const cred = await mine()
      return json(cred ? { set: true, totp: !!cred.totp, setAt: cred.setAt } : { set: false, totp: false, setAt: null })
    }

    // ---- an account's instance
    if (url.pathname === '/owner') {
      const owner: Owner = (await this.ctx.storage.get<Owner>('owner')) ?? { name: null, version: 0, pending: null }
      if (request.method === 'POST') {
        if ('name' in body) owner.name = typeof body.name === 'string' ? body.name : null
        if ('pending' in body) owner.pending = (body.pending as Owner['pending']) ?? null
        if (body.bump === true) owner.version += 1
        await this.ctx.storage.put('owner', owner)
      }
      return json(owner)
    }

    return json({ error: 'not found' }, 404)
  }
}

/**
 * Sign-in tries from one address, across every username. A try is counted
 * before its password is checked, so tries sent all at once count too; one
 * that signs in (or reaches the 2-step code) is given back.
 */
const IP_LIMITS: [windowMs: number, max: number][] = [
  [15 * 60_000, 20],
  [24 * 60 * 60_000, 100]
]
const DAY_MS = IP_LIMITS[IP_LIMITS.length - 1][0]

export class Throttle extends DurableObject<Env> {
  private async recent(): Promise<number[]> {
    return ((await this.ctx.storage.get<number[]>('tries')) ?? []).filter((at) => Date.now() - at < DAY_MS)
  }

  async alarm(): Promise<void> {
    if (!(await this.recent()).length) await this.ctx.storage.deleteAll()
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST') return json({ error: 'not found' }, 404)
    const tries = await this.recent()
    const now = Date.now()
    if (url.pathname === '/take') {
      let wait = 0
      for (const [windowMs, max] of IP_LIMITS) {
        const inWindow = tries.filter((at) => now - at < windowMs)
        if (inWindow.length >= max) wait = Math.max(wait, inWindow[inWindow.length - max] + windowMs - now)
      }
      if (wait) return json({ wait })
      tries.push(now)
      await this.ctx.storage.put('tries', tries.slice(-IP_LIMITS[IP_LIMITS.length - 1][1]))
      await this.ctx.storage.setAlarm(now + DAY_MS)
      return json({ wait: 0 })
    }
    if (url.pathname === '/give-back') {
      tries.pop()
      await this.ctx.storage.put('tries', tries)
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  }
}
