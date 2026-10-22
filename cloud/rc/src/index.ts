import { currentUser, freshFromGitHub, passwordsOf, randomToken, safeNext, sameOrigin, sessionCookie, setCookie, sign, verify, cookie, SESSION_COOKIE, STATE_COOKIE, type Env, type User } from './auth'
import { normalizeCode } from './links'
import { leaked, newTotpSecret, otpauthUri, passwordProblem, seal, toBase32, totpStep, unseal } from './password'
import { waitText, type Owner } from './passwords'
import { isLogin } from './shares'

export { Account } from './account'
export { Links } from './links'
export { Passwords, Throttle } from './passwords'

/**
 * rc.eaon.dev: control Eaon Desktop from a browser, anywhere.
 *
 *   /auth/*   sign in with GitHub, or with a password set for the GitHub
 *             account (passwords.ts), and /auth/dev under `wrangler dev`
 *   /api/*    the signed-in user, linking a computer, the computer list,
 *             sharing, and the account's password and 2-step (/api/security)
 *   /relay/*  WebSockets: a computer's (device token), a browser tab's (cookie),
 *             and a tab joining another account's relay as a guest (shares.ts)
 *   anything else: the web app in ./public
 *
 * A device token is `eaonrc1.<github user id>.<device id>.<secret>`. The
 * Worker only reads which account it names; the account's object checks it.
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })

const account = (env: Env, uid: string): DurableObjectStub => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(`gh:${uid}`))
const links = (env: Env): DurableObjectStub => env.LINKS.get(env.LINKS.idFromName('global'))
/** A username's password, 2-step secret and failed tries. */
const username = (env: Env, name: string): DurableObjectStub => env.PASSWORDS.get(env.PASSWORDS.idFromName(`name:${name}`))
/** Sign-in tries from one address: an IPv4 address, or an IPv6 /64 (one home or phone gets a whole /64). */
const throttle = (env: Env, request: Request): DurableObjectStub => {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
  const key = ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip
  return env.THROTTLE.get(env.THROTTLE.idFromName(key))
}

/** A call into a Durable Object, which only ever sees requests the Worker made. */
const call = (stub: DurableObjectStub, path: string, init: RequestInit = {}): Promise<Response> => stub.fetch(`https://do${path}`, init)

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** An invite link's token: `<owner uid>.<share id>.<secret>`. */
export function parseShareToken(token: string): { owner: string; id: string; secret: string } | null {
  const m = /^([\w-]{1,40})\.([\w-]{6,40})\.([\w-]{20,100})$/.exec(token)
  return m ? { owner: m[1], id: m[2], secret: m[3] } : null
}

/** An unlinked computer's shares are gone: the accounts they were with forget them too. */
async function forgetDropped(env: Env, owner: string, res: Response): Promise<Response> {
  if (!res.ok) return res
  const body = (await res.json()) as { dropped?: { uid: string; share: string }[] }
  await Promise.all((body.dropped ?? []).map((d) => call(account(env, d.uid), '/incoming/remove', post({ owner, share: d.share }))))
  return json({ ok: true })
}

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

  // Password sign-in (passwords.ts). Every answer for a wrong password or an
  // unknown username is the same, and both count against the username and the address.
  if (url.pathname === '/auth/password' && request.method === 'POST') {
    if (!sameOrigin(env, request)) return json({ error: 'forbidden' }, 403)
    if (!env.PASSWORD_PEPPER) return json({ error: 'Password sign-in isn’t set up on this server yet.' }, 500)
    const body = (await request.json().catch(() => ({}))) as { login?: unknown; password?: unknown; code?: unknown; next?: unknown }
    const typed = String(body.login ?? '').trim().replace(/^@/, '')
    const password = String(body.password ?? '')
    const from = throttle(env, request)
    const take = (await (await call(from, '/take', { method: 'POST' })).json()) as { wait: number }
    if (take.wait) return json({ error: `Too many sign-in tries from your network. Wait ${waitText(take.wait)}, or sign in with GitHub.` }, 429)
    if (!isLogin(typed) || !password || password.length > 256) return json({ error: 'Wrong username or password.' }, 401)
    const res = await call(username(env, typed.toLowerCase()), '/check', post({ password, code: typeof body.code === 'string' ? body.code : '' }))
    const out = (await res.json()) as { user?: User; need?: string; error?: string; code?: boolean }
    if (!res.ok) return json(out, res.status)
    await call(from, '/give-back', { method: 'POST' })
    if (out.need) return json({ need: out.need })
    const user = out.user!
    const owner = (await (await call(passwordsOf(env, user.uid), '/owner')).json()) as Owner
    // A username whose GitHub login has since moved to another account signs nobody in.
    if (owner.name !== typed.toLowerCase()) return json({ error: 'Wrong username or password.' }, 401)
    return json({ ok: true, next: safeNext(typeof body.next === 'string' ? body.next : null) }, 200, { 'Set-Cookie': await sessionCookie(env, user, 'password', owner.version) })
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
    return forgetDropped(env, token.uid, await call(account(env, token.uid), '/devices/self-remove', { method: 'POST', headers: { 'X-RC-Device': token.id, 'X-RC-Secret': token.secret } }))
  }
  // The computer's own view of who it's shared with, and revoking from it (Settings → Remote devices).
  if (path === '/api/device/shares' || path.startsWith('/api/device/shares/')) {
    const token = parseDeviceToken((request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''))
    if (!token) return json({ error: 'Not a device token.' }, 401)
    const auth = { 'X-RC-Device': token.id, 'X-RC-Secret': token.secret }
    if (path === '/api/device/shares' && request.method === 'GET') return call(account(env, token.uid), '/devices/self-shares', { headers: auth })
    // A locked terminal the computer shares itself (see /devices/self-shares/add).
    if (path === '/api/device/shares' && request.method === 'POST') {
      const res = await call(account(env, token.uid), '/devices/self-shares/add', { ...post(await request.json().catch(() => ({}))), headers: { 'content-type': 'application/json', ...auth } })
      if (!res.ok) return res
      const made = (await res.json()) as { share: { id: string }; secret: string }
      return json({ share: made.share, url: `${env.PUBLIC_URL}/share/${token.uid}.${made.share.id}.${made.secret}` })
    }
    const one = /^\/api\/device\/shares\/([\w-]+)$/.exec(path)
    if (one && request.method === 'DELETE') {
      const res = await call(account(env, token.uid), `/devices/self-shares/${one[1]}`, { method: 'DELETE', headers: auth })
      if (!res.ok) return res
      const done = (await res.json()) as { uid: string | null }
      if (done.uid) await call(account(env, done.uid), '/incoming/remove', post({ owner: token.uid, share: one[1] }))
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  }

  // ---- from the web app: signed in, and from our own pages
  const user = await currentUser(env, request)
  if (path === '/api/me') return user ? json({ user }) : json({ user: null }, 401)
  if (!user) return json({ error: 'Sign in first.' }, 401)
  if (request.method !== 'GET' && !sameOrigin(env, request)) return json({ error: 'forbidden' }, 403)

  if (path === '/api/security' || path.startsWith('/api/security/')) return security(env, request, path, user)

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
  if (one && request.method === 'PATCH') {
    return call(account(env, user.uid), `/devices/${one[1]}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: await request.text() })
  }
  if (one && request.method === 'DELETE') return forgetDropped(env, user.uid, await call(account(env, user.uid), `/devices/${one[1]}`, { method: 'DELETE' }))

  // ---- sharing (shares.ts): what you shared, invites, and what's shared with you
  if (path === '/api/shares' && request.method === 'GET') return call(account(env, user.uid), '/shares')
  if (path === '/api/shares' && request.method === 'POST') {
    const res = await call(account(env, user.uid), '/shares/add', { ...post(await request.json().catch(() => ({}))), headers: { 'content-type': 'application/json', 'X-RC-Login': user.login } })
    if (!res.ok) return res
    const made = (await res.json()) as { share: { id: string }; secret: string }
    return json({ share: made.share, url: `${env.PUBLIC_URL}/share/${user.uid}.${made.share.id}.${made.secret}` })
  }
  const share = /^\/api\/shares\/([\w-]+)$/.exec(path)
  if (share && request.method === 'DELETE') {
    const res = await call(account(env, user.uid), `/shares/${share[1]}`, { method: 'DELETE' })
    if (!res.ok) return res
    const done = (await res.json()) as { uid: string | null }
    if (done.uid) await call(account(env, done.uid), '/incoming/remove', post({ owner: user.uid, share: share[1] }))
    return json({ ok: true })
  }
  if (path === '/api/share/open' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { token?: string; accept?: boolean }
    const token = parseShareToken(String(body.token ?? ''))
    if (!token) return json({ error: 'That isn’t an invite link.' }, 400)
    if (token.owner === user.uid) return json({ error: 'This is your own invite. Send the link to the person it’s for.' }, 400)
    const res = await call(account(env, token.owner), '/shares/invite', {
      ...post({ id: token.id, secret: token.secret, accept: body.accept === true }),
      headers: { 'content-type': 'application/json', 'X-RC-Uid': user.uid, 'X-RC-Login': user.login }
    })
    if (!res.ok) return res
    const out = (await res.json()) as { accepted?: boolean; ownerLogin?: string }
    if (out.accepted) await call(account(env, user.uid), '/incoming/add', post({ owner: token.owner, ownerLogin: out.ownerLogin ?? '', share: token.id }))
    return json(out)
  }
  if (path === '/api/shared' && request.method === 'GET') return call(account(env, user.uid), '/incoming')
  return json({ error: 'not found' }, 404)
}

/**
 * The account's password and 2-step codes (passwords.ts). Seeing them needs
 * only a session; changing them needs a GitHub sign-in in the last few
 * minutes, so a stolen password (or a session from one) can't change the
 * password, turn 2-step off, or keep itself signed in after either changes.
 */
async function security(env: Env, request: Request, path: string, user: User): Promise<Response> {
  const mine = passwordsOf(env, user.uid)
  const owner = (await (await call(mine, '/owner')).json()) as Owner
  const info = owner.name
    ? ((await (await call(username(env, owner.name), `/info?uid=${encodeURIComponent(user.uid)}`)).json()) as { set: boolean; totp: boolean; setAt: number | null })
    : { set: false, totp: false, setAt: null }

  if (path === '/api/security' && request.method === 'GET') {
    return json({
      available: !!env.PASSWORD_PEPPER,
      username: user.login,
      password: info.set ? { username: owner.name, setAt: info.setAt } : null,
      totp: info.set && info.totp,
      fresh: await freshFromGitHub(env, request)
    })
  }
  if (!env.PASSWORD_PEPPER) return json({ error: 'Password sign-in isn’t set up on this server yet.' }, 500)
  if (!(await freshFromGitHub(env, request))) return json({ error: 'Confirm it’s you with GitHub first.', fresh: false }, 403)
  const pepper = env.PASSWORD_PEPPER
  const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}

  if (path === '/api/security/password' && request.method === 'POST') {
    const password = String(body.password ?? '')
    const problem = passwordProblem(password, user.login)
    if (problem) return json({ error: problem }, 400)
    if (await leaked(password)) return json({ error: 'That password has shown up in a data breach, so it’s on attackers’ lists. Choose another.' }, 400)
    const name = user.login.toLowerCase()
    // Your GitHub username, as it is now: a rename moves the password with it.
    if (owner.name && owner.name !== name) await call(username(env, owner.name), '/remove', post({ uid: user.uid }))
    const set = await call(username(env, name), '/set', post({ uid: user.uid, login: user.login, avatar: user.avatar, password }))
    const { replaced } = (await set.json()) as { replaced: string | null }
    // That login belonged to an account that has since renamed: its password stops working.
    if (replaced) await call(passwordsOf(env, replaced), '/owner', post({ name: null, bump: true }))
    await call(mine, '/owner', post({ name, bump: true }))
    return json({ ok: true })
  }
  if (path === '/api/security/password' && request.method === 'DELETE') {
    if (owner.name) await call(username(env, owner.name), '/remove', post({ uid: user.uid }))
    await call(mine, '/owner', post({ name: null, pending: null, bump: true }))
    return json({ ok: true })
  }

  if (path === '/api/security/totp/start' && request.method === 'POST') {
    if (!info.set) return json({ error: 'Set a password first. 2-step codes are asked for after it.' }, 409)
    const secret = newTotpSecret()
    await call(mine, '/owner', post({ pending: { sealed: await seal(pepper, secret), exp: Date.now() + 10 * 60_000 } }))
    return json({ secret: toBase32(secret), uri: otpauthUri(secret, user.login) })
  }
  if (path === '/api/security/totp/confirm' && request.method === 'POST') {
    if (!info.set || !owner.name) return json({ error: 'Set a password first.' }, 409)
    if (!owner.pending || owner.pending.exp < Date.now()) return json({ error: 'That setup expired. Start again.' }, 409)
    const step = await totpStep(await unseal(pepper, owner.pending.sealed), String(body.code ?? '').replace(/\s/g, ''), Date.now(), 0)
    if (step === null) return json({ error: 'That code isn’t right. Check the app shows Eaon Remote, and type the newest code.' }, 400)
    await call(username(env, owner.name), '/totp', post({ uid: user.uid, sealed: owner.pending.sealed, usedStep: step }))
    // Turning 2-step on signs out every session that came from the password alone.
    await call(mine, '/owner', post({ pending: null, bump: true }))
    return json({ ok: true })
  }
  if (path === '/api/security/totp' && request.method === 'DELETE') {
    if (owner.name) await call(username(env, owner.name), '/totp', post({ uid: user.uid, sealed: null }))
    await call(mine, '/owner', post({ pending: null, bump: true }))
    return json({ ok: true })
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

  // Another account's relay, as a guest: it checks what was shared with you, message by message.
  if (url.pathname === '/relay/guest') {
    if (!sameOrigin(env, request)) return new Response('Forbidden.', { status: 403 })
    const user = await currentUser(env, request)
    if (!user) return new Response('Sign in first.', { status: 401 })
    const owner = url.searchParams.get('owner') ?? ''
    if (!/^[\w-]{1,40}$/.test(owner) || owner === user.uid) return new Response('Not found.', { status: 404 })
    return account(env, owner).fetch('https://do/guest', { headers: { Upgrade: 'websocket', 'X-RC-Uid': user.uid, 'X-RC-Login': user.login } })
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
