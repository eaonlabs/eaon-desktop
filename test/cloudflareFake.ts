import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'

/**
 * A fake Cloudflare API for Eaon's own-domain email: zones, DNS records,
 * Email Routing (settings, enabling, rules), Email Sending (sending domains,
 * their DNS records, send), Workers KV and Worker uploads. Paths, bodies and
 * error envelopes follow the Cloudflare API reference. Like Cloudflare,
 * turning on Email Routing adds its MX and SPF records; onboarding a sending
 * domain does not add its records (Eaon must). Each permission can be
 * withdrawn to see the 403 a token without it gets.
 *
 * Used by test/email-cloudflare.test.ts and by the end-to-end run.
 */

/**
 * A user API token in Cloudflare's current format: cfut_ + 40 characters + an
 * 8-hex checksum. Fake, and put together at runtime so secret scanners (GitHub's
 * push protection checks Cloudflare's prefixes) never see a token-shaped literal.
 */
export const TOKEN = ['cfut', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0f' + '1a2b3c4d'].join('_')
/** A Global API Key in the current format, and the login it belongs to. Fake, built the same way. */
export const GLOBAL_KEY = ['cfk', 'Zy9xWv8uTs7rQp6oNm5lKj4iHg3fEd2cBa1zYx0w' + '9f8e7d6c'].join('_')
export const GLOBAL_EMAIL = 'sans@example.com'
export const ALL_PERMISSIONS = ['zone:read', 'dns:edit', 'zone_settings:edit', 'email_routing_rules:edit', 'workers_scripts:edit', 'workers_kv:edit', 'email_sending:edit']

/**
 * Permission groups as GET /user/tokens/permission_groups lists them, with a
 * few that must not be picked by mistake. Ids map to the fake's permissions.
 */
export const PERMISSION_GROUPS = [
  { id: 'pg-zone-read', name: 'Zone Read', scopes: ['com.cloudflare.api.account.zone'], grants: 'zone:read' },
  { id: 'pg-zone-write', name: 'Zone Write', scopes: ['com.cloudflare.api.account.zone'], grants: null },
  { id: 'pg-dns-read', name: 'DNS Read', scopes: ['com.cloudflare.api.account.zone'], grants: null },
  { id: 'pg-dns-write', name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'], grants: 'dns:edit' },
  { id: 'pg-zone-settings', name: 'Zone Settings Write', scopes: ['com.cloudflare.api.account.zone'], grants: 'zone_settings:edit' },
  { id: 'pg-routing-rules', name: 'Email Routing Rules Write', scopes: ['com.cloudflare.api.account.zone'], grants: 'email_routing_rules:edit' },
  { id: 'pg-scripts-read', name: 'Workers Scripts Read', scopes: ['com.cloudflare.api.account'], grants: null },
  { id: 'pg-scripts', name: 'Workers Scripts Write', scopes: ['com.cloudflare.api.account'], grants: 'workers_scripts:edit' },
  { id: 'pg-kv', name: 'Workers KV Storage Write', scopes: ['com.cloudflare.api.account'], grants: 'workers_kv:edit' },
  { id: 'pg-sending', name: 'Email Sending Write', scopes: ['com.cloudflare.api.account'], grants: 'email_sending:edit' },
  { id: 'pg-addresses', name: 'Email Routing Addresses Write', scopes: ['com.cloudflare.api.account'], grants: 'email_routing_addresses:edit' }
]

interface Record_ {
  id: string
  type: string
  name: string
  content: string
  priority?: number
}

export interface FakeCloudflare {
  url: string
  /** What TOKEN may do. Tokens made through the API get what their policies grant. */
  permissions: Set<string>
  /** Email Routing destination addresses: address → verified. */
  destinations: Map<string, boolean>
  /** The account's workers.dev subdomain; null when it has none. */
  workersSubdomain: string | null
  /** What the uploaded Worker sent through its send_email binding. */
  workerSent: Record<string, unknown>[]
  /** Tokens made with POST /user/tokens: their policies, and the zones they reach. */
  created: { name: string; value: string; policies: { effect: string; resources: Record<string, string>; permission_groups: { id: string }[] }[] }[]
  /** Sending to people outside the account (the Workers Paid plan). */
  paid: boolean
  zones: { id: string; name: string; account: { id: string; name: string } }[]
  dns: Map<string, Record_[]>
  routing: Map<string, { enabled: boolean; status: string; name: string }>
  rules: Map<string, { id: string; name: string; enabled: boolean; matchers: { type: string; field: string; value: string }[]; actions: { type: string; value: string[] }[] }[]>
  sending: Map<string, { tag: string; name: string; enabled: boolean }[]>
  namespaces: { id: string; title: string }[]
  kv: Map<string, { value: Buffer; metadata: Record<string, unknown> | null }>
  scripts: Map<string, { metadata: Record<string, unknown>; source: string }>
  workersDev: Map<string, boolean>
  sent: Record<string, unknown>[]
  calls: string[]
  close: () => Promise<void>
}

function sendingRecords(name: string): Omit<Record_, 'id'>[] {
  return [
    { type: 'MX', name: `cf-bounce.${name}`, content: 'route1.mx.cloudflare.net', priority: 10 },
    { type: 'TXT', name: `cf-bounce.${name}`, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' },
    { type: 'TXT', name: `cf-bounce._domainkey.${name}`, content: '"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"' },
    { type: 'TXT', name: `_dmarc.${name}`, content: '"v=DMARC1; p=reject;"' }
  ]
}

const ROUTING_MX = [
  { content: 'route1.mx.cloudflare.net', priority: 13 },
  { content: 'route2.mx.cloudflare.net', priority: 86 },
  { content: 'route3.mx.cloudflare.net', priority: 24 }
]

export async function fakeCloudflare(): Promise<FakeCloudflare> {
  let ids = 0
  const fake: FakeCloudflare = {
    url: '',
    permissions: new Set([...ALL_PERMISSIONS, 'email_routing_addresses:edit']),
    created: [],
    destinations: new Map(),
    workersSubdomain: 'example-account',
    workerSent: [],
    paid: true,
    zones: [
      { id: 'zone1', name: 'example.com', account: { id: 'acct1', name: 'Sans' } },
      { id: 'zone2', name: 'withmail.com', account: { id: 'acct1', name: 'Sans' } }
    ],
    dns: new Map([
      ['zone1', []],
      [
        'zone2',
        [
          { id: 'r-g1', type: 'MX', name: 'withmail.com', content: 'aspmx.l.google.com', priority: 1 },
          { id: 'r-g2', type: 'TXT', name: 'withmail.com', content: '"v=spf1 include:_spf.google.com ~all"' }
        ]
      ]
    ]),
    routing: new Map([
      ['zone1', { enabled: false, status: 'unconfigured', name: 'example.com' }],
      ['zone2', { enabled: false, status: 'unconfigured', name: 'withmail.com' }]
    ]),
    rules: new Map([
      ['zone1', []],
      ['zone2', []]
    ]),
    sending: new Map([
      ['zone1', []],
      ['zone2', []]
    ]),
    namespaces: [],
    kv: new Map(),
    scripts: new Map(),
    workersDev: new Map(),
    sent: [],
    calls: [],
    close: async () => {}
  }

  const ok = (res: ServerResponse, result: unknown, info?: Record<string, unknown>): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) }))
  }
  const fail = (res: ServerResponse, status: number, code: number, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }))
  }

  // The uploaded Worker, loaded as a module (once per version of its source).
  const modules = new Map<string, Promise<{ fetch: (request: Request, env: unknown) => Promise<Response> }>>()
  const workerDir = mkdtempSync(join(tmpdir(), 'eaon-fake-worker-'))
  const runWorker = async (name: string, subpath: string, req: IncomingMessage, raw: Buffer, res: ServerResponse): Promise<void> => {
    const script = fake.scripts.get(name)
    const enabled = fake.workersDev.get(name)
    if (!script || !enabled) {
      res.writeHead(404, { 'content-type': 'text/html' })
      return void res.end('<h1>There is nothing here yet</h1>')
    }
    const hash = createHash('sha1').update(script.source).digest('hex')
    if (!modules.has(hash)) {
      const file = join(workerDir, `${hash}.mjs`)
      writeFileSync(file, script.source)
      modules.set(hash, import(pathToFileURL(file).href).then((m) => m.default))
    }
    const worker = await modules.get(hash)!
    const bindings = (script.metadata.bindings as { type: string; name: string; text?: string }[]) ?? []
    const env: Record<string, unknown> = {}
    for (const b of bindings) {
      if (b.type === 'secret_text') env[b.name] = b.text
      if (b.type === 'kv_namespace') env[b.name] = { put: async (key: string, value: ArrayBuffer, o: { metadata?: Record<string, unknown> }) => fake.kv.set(key, { value: Buffer.from(value), metadata: o.metadata ?? null }) }
      if (b.type === 'send_email') {
        env[b.name] = {
          // Like the binding before Email Sending is onboarded: verified destination addresses only.
          send: async (message: { to: unknown; cc?: unknown }) => {
            const recipients = ([] as unknown[]).concat(message.to ?? [], message.cc ?? []).map((r) => String(typeof r === 'object' && r ? (r as { email: string }).email : r).toLowerCase())
            if (recipients.some((r) => !fake.destinations.get(r))) {
              throw Object.assign(new Error('destination address not verified'), { code: 'E_RECIPIENT_NOT_ALLOWED' })
            }
            fake.workerSent.push(message as Record<string, unknown>)
            return { messageId: `<w${fake.workerSent.length}@example.com>` }
          }
        }
      }
    }
    const request = new Request(`https://${name}.${fake.workersSubdomain}.workers.dev${subpath}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw
    })
    const response = await worker.fetch(request, env)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const method = req.method ?? 'GET'
    fake.calls.push(`${method} ${path}`)
    // The Worker's own workers.dev endpoint: run the uploaded code, as Cloudflare would.
    const workerMatch = /^\/__worker\/([^/]+)(\/.*)$/.exec(path)
    if (workerMatch) return runWorker(workerMatch[1], workerMatch[2], req, raw, res)
    // Who is asking, answered the way Cloudflare answers (probed live): an unknown well-formed
    // token is 403/9109, anything not shaped like a token 400/6003+6111, a wrong Global API Key 403/9103.
    let granted: Set<string>
    let zonesAllowed: Set<string> | null = null
    let globalKey = false
    const authorization = String(req.headers.authorization ?? '')
    if (req.headers['x-auth-key'] || req.headers['x-auth-email']) {
      if (req.headers['x-auth-key'] !== GLOBAL_KEY || req.headers['x-auth-email'] !== GLOBAL_EMAIL) return fail(res, 403, 9103, 'Unknown X-Auth-Key or X-Auth-Email')
      granted = new Set(ALL_PERMISSIONS)
      globalKey = true
    } else if (!authorization) {
      res.writeHead(403, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ success: false, errors: [{ code: 9106, message: 'Missing X-Auth-Email header' }, { code: 9107, message: 'Missing X-Auth-Key header' }], result: null }))
    } else {
      const value = authorization.replace(/^Bearer /, '')
      const made = fake.created.find((t) => t.value === value)
      if (value === TOKEN) granted = fake.permissions
      else if (made) {
        const ids = made.policies.flatMap((p) => p.permission_groups.map((g) => g.id))
        granted = new Set(PERMISSION_GROUPS.filter((g) => ids.includes(g.id) && g.grants).map((g) => g.grants!))
        zonesAllowed = new Set(made.policies.flatMap((p) => Object.keys(p.resources)).filter((r) => r.startsWith('com.cloudflare.api.account.zone.')).map((r) => r.slice('com.cloudflare.api.account.zone.'.length)))
      } else if (/^(cf(ut|at|k)_[A-Za-z0-9_-]{40}[0-9a-f]{8}|[A-Za-z0-9_-]{40})$/.test(value)) return fail(res, 403, 9109, 'Invalid access token')
      else {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ success: false, errors: [{ code: 6003, message: 'Invalid request headers', error_chain: [{ code: 6111, message: 'Invalid format for Authorization header' }] }], result: null }))
      }
    }
    const need = (permission: string): boolean => {
      if (granted.has(permission)) return true
      // Each the way the real API words it for a good token without the permission.
      if (permission === 'email_sending:edit') fail(res, 401, 2036, 'Unauthorized')
      else if (permission.startsWith('workers')) fail(res, 403, 9109, 'Unauthorized to access requested resource')
      else fail(res, 403, 10000, 'Authentication error')
      return false
    }
    const zoneMatch = /^\/zones\/([^/]+)\//.exec(path)
    if (zoneMatch && zonesAllowed && !zonesAllowed.has(zoneMatch[1])) return fail(res, 403, 9109, 'Unauthorized to access requested resource')
    const json = (): Record<string, unknown> => (raw.length ? JSON.parse(raw.toString('utf8')) : {})
    const form = async (): Promise<FormData> => new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: raw }).formData()
    let m: RegExpExecArray | null

    if (method === 'GET' && path === '/zones') {
      if (!need('zone:read')) return
      return ok(res, fake.zones.filter((z) => !zonesAllowed || zonesAllowed.has(z.id)).map((z) => ({ ...z, status: 'active' })), { page: 1, total_pages: 1 })
    }
    if (method === 'GET' && path === '/user/tokens/permission_groups') {
      if (!globalKey) return fail(res, 403, 9109, 'Unauthorized to access requested resource')
      return ok(res, PERMISSION_GROUPS.map(({ grants: _grants, ...group }) => group))
    }
    if (method === 'POST' && path === '/user/tokens') {
      if (!globalKey) return fail(res, 403, 9109, 'Unauthorized to access requested resource')
      const body = json() as unknown as FakeCloudflare['created'][number]
      const value = `cfut_${'N'.repeat(36)}${String(fake.created.length).padStart(4, '0')}0badc0de`
      fake.created.push({ name: body.name, policies: body.policies, value })
      return ok(res, { id: `tok${fake.created.length}`, name: body.name, status: 'active', value })
    }
    if ((m = /^\/zones\/([^/]+)\/dns_records$/.exec(path))) {
      const records = fake.dns.get(m[1])!
      if (method === 'GET') {
        if (!need('dns:edit')) return
        const type = url.searchParams.get('type')
        const name = url.searchParams.get('name')
        return ok(res, records.filter((r) => (!type || r.type === type) && (!name || r.name === name)), { page: 1, total_pages: 1 })
      }
      if (!need('dns:edit')) return
      const body = json() as unknown as Record_
      const record = { id: `r${++ids}`, type: body.type, name: body.name, content: body.content, ...(body.priority !== undefined ? { priority: body.priority } : {}) }
      records.push(record)
      return ok(res, record)
    }
    if ((m = /^\/zones\/([^/]+)\/email\/routing$/.exec(path)) && method === 'GET') {
      if (!need('zone_settings:edit')) return
      return ok(res, fake.routing.get(m[1]))
    }
    if ((m = /^\/zones\/([^/]+)\/email\/routing\/dns$/.exec(path))) {
      const zone = fake.zones.find((z) => z.id === m![1])!
      if (method === 'GET') return ok(res, [...ROUTING_MX.map((r) => ({ type: 'MX', name: zone.name, ...r })), { type: 'TXT', name: zone.name, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' }])
      if (!need('zone_settings:edit')) return
      const name = String(json().name ?? zone.name)
      // Like Cloudflare: turning it on adds its MX and SPF records at that name.
      const records = fake.dns.get(zone.id)!
      for (const mx of ROUTING_MX) records.push({ id: `r${++ids}`, type: 'MX', name, ...mx })
      records.push({ id: `r${++ids}`, type: 'TXT', name, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' })
      const settings = { enabled: true, status: 'ready', name: zone.name }
      fake.routing.set(zone.id, settings)
      return ok(res, settings)
    }
    if ((m = /^\/zones\/([^/]+)\/email\/routing\/rules(?:\/([^/]+))?$/.exec(path))) {
      if (!need('email_routing_rules:edit')) return
      const rules = fake.rules.get(m[1])!
      if (method === 'GET') return ok(res, rules, { page: 1, total_pages: 1 })
      if (method === 'POST') {
        const body = json()
        const rule = { id: `rule${++ids}`, ...(body as object) } as (typeof rules)[number]
        rules.push(rule)
        return ok(res, rule)
      }
      const index = rules.findIndex((r) => r.id === m![2])
      if (index === -1) return fail(res, 404, 2020, 'Rule not found')
      if (method === 'PUT') {
        rules[index] = { ...rules[index], ...(json() as object) }
        return ok(res, rules[index])
      }
      rules.splice(index, 1)
      return ok(res, { id: m[2] })
    }
    if ((m = /^\/zones\/([^/]+)\/email\/sending\/subdomains(?:\/([^/]+)\/dns)?$/.exec(path))) {
      if (!need('email_sending:edit')) return
      const list = fake.sending.get(m[1])!
      if (m[2]) {
        const found = list.find((s) => s.tag === m![2])
        return found ? ok(res, sendingRecords(found.name)) : fail(res, 404, 1001, 'Not found')
      }
      if (method === 'GET') return ok(res, list)
      const name = String(json().name)
      const entry = { tag: `tag-${name}`, name, enabled: true }
      list.push(entry)
      return ok(res, entry)
    }
    if ((m = /^\/accounts\/([^/]+)\/storage\/kv\/namespaces$/.exec(path))) {
      if (!need('workers_kv:edit')) return
      if (method === 'GET') return ok(res, fake.namespaces, { page: 1, total_pages: 1 })
      const namespace = { id: `ns${++ids}`, title: String(json().title) }
      fake.namespaces.push(namespace)
      return ok(res, namespace)
    }
    if ((m = /^\/accounts\/([^/]+)\/storage\/kv\/namespaces\/([^/]+)\/keys$/.exec(path))) {
      if (!need('workers_kv:edit')) return
      const prefix = url.searchParams.get('prefix') ?? ''
      const keys = [...fake.kv.keys()].filter((k) => k.startsWith(prefix)).sort()
      return ok(res, keys.map((name) => ({ name, metadata: fake.kv.get(name)!.metadata ?? undefined })), { count: keys.length, cursor: '' })
    }
    if ((m = /^\/accounts\/([^/]+)\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/.exec(path))) {
      if (!need('workers_kv:edit')) return
      const key = decodeURIComponent(m[3])
      if (method === 'GET') {
        const entry = fake.kv.get(key)
        if (!entry) return fail(res, 404, 10009, 'get: key not found')
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return res.end(entry.value)
      }
      const data = await form()
      const value = data.get('value')
      const metadata = data.get('metadata')
      fake.kv.set(key, {
        value: Buffer.from(typeof value === 'string' ? value : await (value as Blob).arrayBuffer()),
        metadata: typeof metadata === 'string' ? JSON.parse(metadata) : null
      })
      return ok(res, {})
    }
    if ((m = /^\/accounts\/([^/]+)\/workers\/subdomain$/.exec(path)) && method === 'GET') {
      if (!need('workers_scripts:edit')) return
      return fake.workersSubdomain ? ok(res, { subdomain: fake.workersSubdomain }) : fail(res, 404, 10007, 'workers.dev subdomain not found')
    }
    if ((m = /^\/accounts\/([^/]+)\/email\/routing\/addresses$/.exec(path))) {
      if (!need('email_routing_addresses:edit')) return
      if (method === 'GET') {
        return ok(res, [...fake.destinations].map(([email, verified], i) => ({ id: `addr${i}`, email, verified: verified ? '2026-10-01T00:00:00Z' : null })), { page: 1, total_pages: 1 })
      }
      const email = String(json().email).toLowerCase()
      if (!fake.destinations.has(email)) fake.destinations.set(email, false)
      return ok(res, { id: `addr${fake.destinations.size}`, email, verified: null })
    }
    if (/^\/accounts\/[^/]+\/workers\/scripts$/.test(path) && method === 'GET') {
      if (!need('workers_scripts:edit')) return
      return ok(res, [...fake.scripts.keys()].map((id) => ({ id, handlers: ['email'] })))
    }
    if ((m = /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)$/.exec(path)) && method === 'PUT') {
      if (!need('workers_scripts:edit')) return
      const data = await form()
      const metadata = JSON.parse(String(data.get('metadata')))
      const module = data.get(String(metadata.main_module)) as Blob
      fake.scripts.set(m[2], { metadata, source: await module.text() })
      return ok(res, { id: m[2] })
    }
    if ((m = /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path))) {
      if (!need('workers_scripts:edit')) return
      fake.workersDev.set(m[2], Boolean(json().enabled))
      return ok(res, { enabled: Boolean(json().enabled) })
    }
    if ((m = /^\/accounts\/([^/]+)\/email\/sending\/send$/.exec(path))) {
      if (!need('email_sending:edit')) return
      const body = json()
      if (!fake.paid) return fail(res, 403, 10403, 'Sending to unverified destination addresses requires a Workers Paid plan')
      fake.sent.push(body)
      const to = ([] as unknown[]).concat(body.to as unknown[])
      return ok(res, { delivered: to.map(String), permanent_bounces: [], queued: [] })
    }
    fail(res, 404, 7000, `No route for ${method} ${path}`)
  })
  fake.close = () => new Promise((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}

