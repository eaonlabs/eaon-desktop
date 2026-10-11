import { DurableObject } from 'cloudflare:workers'
import { randomToken, sha256, type Env } from './auth'

/**
 * Linking a desktop to a GitHub account, the way a TV signs in: the app asks
 * for a code, shows it and opens rc.eaon.dev/link?code=…; the user signs in
 * with GitHub there and confirms; the app, polling with a secret only it
 * holds, collects its device token once.
 *
 * One instance (named "global") holds every pending code. Codes last ten
 * minutes and are never reused; the poll secret is stored only as a hash.
 */

const TTL_MS = 10 * 60_000
/** No 0/O, 1/I/L: read off one screen and typed into another. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const STARTS_PER_IP_PER_MINUTE = 10

export interface PendingLink {
  code: string
  pollHash: string
  name: string
  platform: string
  createdAt: number
  status: 'pending' | 'approved' | 'denied'
  /** Set when approved, handed to the desktop once and then deleted. */
  result?: { token: string; deviceId: string; user: { login: string; avatar: string } }
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

export const normalizeCode = (raw: unknown): string | null => {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export class Links extends DurableObject<Env> {
  private async live(code: string): Promise<PendingLink | null> {
    const link = await this.ctx.storage.get<PendingLink>(`code:${code}`)
    if (!link) return null
    if (Date.now() - link.createdAt > TTL_MS) {
      await this.ctx.storage.delete([`code:${code}`, `poll:${link.pollHash}`])
      return null
    }
    return link
  }

  /** Drops expired codes and old rate-limit counters now and then. */
  private async sweep(): Promise<void> {
    const now = Date.now()
    const all = await this.ctx.storage.list<PendingLink | number>({ limit: 500 })
    const gone: string[] = []
    for (const [key, value] of all) {
      if (key.startsWith('code:') && now - (value as PendingLink).createdAt > TTL_MS) gone.push(key, `poll:${(value as PendingLink).pollHash}`)
      if (key.startsWith('ip:') && Number(key.split(':').pop()) < Math.floor(now / 60_000) - 1) gone.push(key)
    }
    if (gone.length) await this.ctx.storage.delete(gone.slice(0, 128))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}

    switch (url.pathname) {
      case '/start': {
        const ip = request.headers.get('X-RC-IP') ?? 'unknown'
        const minute = Math.floor(Date.now() / 60_000)
        const key = `ip:${ip}:${minute}`
        const count = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1
        await this.ctx.storage.put(key, count)
        if (count > STARTS_PER_IP_PER_MINUTE) return json({ error: 'Too many link requests. Wait a minute and try again.' }, 429)
        if (Math.random() < 0.1) await this.sweep()
        let code = newCode()
        while (await this.ctx.storage.get(`code:${code}`)) code = newCode()
        const poll = randomToken()
        const pollHash = await sha256(poll)
        const link: PendingLink = {
          code,
          pollHash,
          name: String(body.name ?? 'A computer').slice(0, 80),
          platform: String(body.platform ?? '').slice(0, 20),
          createdAt: Date.now(),
          status: 'pending'
        }
        await this.ctx.storage.put({ [`code:${code}`]: link, [`poll:${pollHash}`]: code })
        return json({ code, poll, expiresIn: TTL_MS / 1000 })
      }

      case '/info': {
        const code = normalizeCode(url.searchParams.get('code'))
        const link = code ? await this.live(code) : null
        if (!link || link.status !== 'pending') return json({ error: 'That code has expired or was already used. Start linking again from Eaon.' }, 404)
        return json({ code: link.code, name: link.name, platform: link.platform })
      }

      case '/approve': {
        // Called by the Worker after the account has made the device.
        const code = normalizeCode(body.code)
        const link = code ? await this.live(code) : null
        if (!link || link.status !== 'pending') return json({ error: 'That code has expired or was already used.' }, 404)
        link.status = 'approved'
        link.result = body.result as PendingLink['result']
        await this.ctx.storage.put(`code:${link.code}`, link)
        return json({ ok: true })
      }

      case '/deny': {
        const code = normalizeCode(body.code)
        const link = code ? await this.live(code) : null
        if (link && link.status === 'pending') {
          link.status = 'denied'
          await this.ctx.storage.put(`code:${link.code}`, link)
        }
        return json({ ok: true })
      }

      case '/poll': {
        const pollHash = await sha256(String(body.poll ?? ''))
        const code = await this.ctx.storage.get<string>(`poll:${pollHash}`)
        const link = code ? await this.live(code) : null
        if (!link) return json({ status: 'expired' })
        if (link.status === 'pending') return json({ status: 'pending' })
        // Approved or denied: told once, then forgotten, so the token exists in one place only.
        await this.ctx.storage.delete([`code:${link.code}`, `poll:${link.pollHash}`])
        return link.status === 'approved' && link.result ? json({ status: 'approved', ...link.result }) : json({ status: 'denied' })
      }
    }
    return json({ error: 'not found' }, 404)
  }
}
