import { currentUser, randomToken, safeNext, sameOrigin, sessionCookie, setCookie, sign, verify, cookie, SESSION_COOKIE, STATE_COOKIE, type Env, type User } from './auth'
import { normalizeCode } from './links'

export { Account } from './account'
export { Links } from './links'

/**
 * rc.eaon.dev: control Eaon Desktop from a browser, anywhere.
 *
 *   /auth/*   sign in with GitHub (and /auth/dev under `wrangler dev`)
 *   /api/*    the signed-in user, linking a computer, the computer list
 *   /relay/*  WebSockets: a computer's (device token) and a browser tab's (cookie)
 *   anything else: the web app in ./public
 *
 * A device token is `eaonrc1.<github user id>.<device id>.<secret>`. The
 * Worker only reads which account it names; the account's object checks it.
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })

const account = (env: Env, uid: string): DurableObjectStub => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(`gh:${uid}`))
const links = (env: Env): DurableObjectStub => env.LINKS.get(env.LINKS.idFromName('global'))

/** A call into a Durable Object, which only ever sees requests the Worker made. */
const call = (stub: DurableObjectStub, path: string, init: RequestInit = {}): Promise<Response> => stub.fetch(`https://do${path}`, init)

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export function parseDeviceToken(token: string): { uid: string; id: string; secret: string } | null {
  const m = /^eaonrc1\.([\w-]{1,40})\.([\w-]{6,40})\.([\w-]{20,100})$/.exec(token)
  return m ? { uid: m[1], id: m[2], secret: m[3] } : null
}

async function github(env: Env, request: Request, url: URL): Promise<Response> {
  if (url.pathname === '/auth/github') {
    if (!env.GITHUB_CLIENT_ID) return new Response('GitHub sign-in isn’t set up on this server yet (GITHUB_CLIENT_ID).', { status: 500 })
    const state = randomToken(16)
    const next = safeNext(url.searchParams.get('next'))
    const go = new URL('https://github.com/login/oauth/authorize')
    go.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
    go.searchParams.set('redirect_uri', `${env.PUBLIC_URL}/auth/callback`)
    go.searchParams.set('state', state)
    // No scopes: only who you are (public profile), nothing in your repositories.
    go.searchParams.set('allow_signup', 'true')
    return new Response(null, {
      status: 302,
      headers: { Location: go.toString(), 'Set-Cookie': setCookie(env, STATE_COOKIE, await sign(env.SESSION_SECRET, { state, next, at: Date.now() }), 600) }
    })
  }

  if (url.pathname === '/auth/callback') {
    const saved = await verify<{ state: string; next: string; at: number }>(env.SESSION_SECRET, cookie(request, STATE_COOKIE))
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (!saved || !state || saved.state !== state || !code || Date.now() - saved.at > 600_000) {
      return new Response('That sign-in link is stale. Go back and sign in again.', { status: 400 })
    }
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${env.PUBLIC_URL}/auth/callback` })
    })
    const token = ((await tokenRes.json().catch(() => ({}))) as { access_token?: string }).access_token
    if (!token) return new Response('GitHub didn’t sign you in. Try again.', { status: 502 })
    const me = (await (await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'eaon-rc', Accept: 'application/vnd.github+json' } })).json()) as {
      id?: number
      login?: string
      avatar_url?: string
    }
    if (!me.id || !me.login) return new Response('GitHub didn’t say who you are. Try again.', { status: 502 })
    // The GitHub token isn't kept: it was only needed to learn who you are.
    const user: User = { uid: String(me.id), login: me.login, avatar: me.avatar_url ?? '' }
    const headers = new Headers({ Location: saved.next })
    headers.append('Set-Cookie', await sessionCookie(env, user))
    headers.append('Set-Cookie', setCookie(env, STATE_COOKIE, '', 0))
    return new Response(null, { status: 302, headers })
  }

  if (url.pathname === '/auth/dev' && env.DEV_LOGIN === '1') {
    const login = (url.searchParams.get('login') ?? 'dev').replace(/[^\w-]/g, '').slice(0, 39) || 'dev'
    const user: User = { uid: `dev-${login}`, login, avatar: '' }
    return new Response(null, { status: 302, headers: { Location: safeNext(url.searchParams.get('next')), 'Set-Cookie': await sessionCookie(env, user) } })
  }

  if (url.pathname === '/auth/logout' && request.method === 'POST') {
    if (!sameOrigin(env, request)) return json({ error: 'forbidden' }, 403)
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(env, SESSION_COOKIE, '', 0) })
  }

  return json({ error: 'not found' }, 404)
}

async function api(env: Env, request: Request, url: URL): Promise<Response> {
  const path = url.pathname

  // ---- from the desktop app (no session: it isn't signed in, it's being linked)
  if (path === '/api/link/start' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const res = await call(links(env), '/start', {
      ...post({ name: body.name, platform: body.platform }),
      headers: { 'content-type': 'application/json', 'X-RC-IP': request.headers.get('CF-Connecting-IP') ?? 'local' }
    })
    if (!res.ok) return res
    const started = (await res.json()) as { code: string; poll: string; expiresIn: number }
    return json({ ...started, url: `${env.PUBLIC_URL}/link?code=${started.code}` })
  }
  if (path === '/api/link/poll' && request.method === 'POST') {
    return call(links(env), '/poll', post(await request.json().catch(() => ({}))))
  }
  // Unlinking from the desktop: the device's own token revokes itself.
  if (path === '/api/device/unlink' && request.method === 'POST') {
    const token = parseDeviceToken((request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''))
    if (!token) return json({ error: 'Not a device token.' }, 401)
    return call(account(env, token.uid), '/devices/self-remove', { method: 'POST', headers: { 'X-RC-Device': token.id, 'X-RC-Secret': token.secret } })
  }

  // ---- from the web app: signed in, and from our own pages
  const user = await currentUser(env, request)
  if (path === '/api/me') return user ? json({ user }) : json({ user: null }, 401)
  if (!user) return json({ error: 'Sign in first.' }, 401)
  if (request.method !== 'GET' && !sameOrigin(env, request)) return json({ error: 'forbidden' }, 403)

  if (path === '/api/link/info') return call(links(env), `/info?code=${encodeURIComponent(url.searchParams.get('code') ?? '')}`)

  if (path === '/api/link/confirm' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { code?: string }
    const code = normalizeCode(body.code)
    if (!code) return json({ error: 'Type the 8-character code Eaon shows.' }, 400)
    const info = await call(links(env), `/info?code=${code}`)
    if (!info.ok) return info
    const { name, platform } = (await info.json()) as { name: string; platform: string }
    const made = await call(account(env, user.uid), '/devices/add', post({ name, platform }))
    if (!made.ok) return made
    const device = (await made.json()) as { id: string; secret: string }
    const approved = await call(
      links(env),
      '/approve',
      post({ code, result: { token: `eaonrc1.${user.uid}.${device.id}.${device.secret}`, deviceId: device.id, user: { login: user.login, avatar: user.avatar } } })
    )
    if (!approved.ok) {
      await call(account(env, user.uid), `/devices/${device.id}`, { method: 'DELETE' })
      return approved
    }
    return json({ ok: true, device: { id: device.id, name } })
  }
  if (path === '/api/link/deny' && request.method === 'POST') return call(links(env), '/deny', post(await request.json().catch(() => ({}))))

  if (path === '/api/devices' && request.method === 'GET') return call(account(env, user.uid), '/devices')
  const one = /^\/api\/devices\/([\w-]+)$/.exec(path)
  if (one && (request.method === 'PATCH' || request.method === 'DELETE')) {
    return call(account(env, user.uid), `/devices/${one[1]}`, { method: request.method, headers: { 'content-type': 'application/json' }, body: request.method === 'PATCH' ? await request.text() : undefined })
  }
  return json({ error: 'not found' }, 404)
}

async function relay(env: Env, request: Request, url: URL): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 })

  if (url.pathname === '/relay/device') {
    const raw = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const token = parseDeviceToken(raw)
    if (!token) return new Response('Link this computer at rc.eaon.dev first.', { status: 401 })
    const headers = new Headers({ Upgrade: 'websocket', 'X-RC-Device': token.id, 'X-RC-Secret': token.secret })
    const name = request.headers.get('X-RC-Name')
    if (name) headers.set('X-RC-Name', name)
    return account(env, token.uid).fetch('https://do/device', { headers })
  }

  if (url.pathname === '/relay/web') {
    // A browser always sends Origin on a WebSocket: only our own pages may open one with your cookie.
    if (!sameOrigin(env, request)) return new Response('Forbidden.', { status: 403 })
    const user = await currentUser(env, request)
    if (!user) return new Response('Sign in first.', { status: 401 })
    return account(env, user.uid).fetch('https://do/web', { headers: { Upgrade: 'websocket', 'X-RC-Login': user.login } })
  }

  return new Response('Not found.', { status: 404 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname.startsWith('/auth/')) return await github(env, request, url)
      if (url.pathname.startsWith('/api/')) return await api(env, request, url)
      if (url.pathname.startsWith('/relay/')) return await relay(env, request, url)
      return env.ASSETS.fetch(request)
    } catch (error) {
      console.error(error)
      return json({ error: 'Something went wrong on the server.' }, 500)
    }
  }
} satisfies ExportedHandler<Env>
