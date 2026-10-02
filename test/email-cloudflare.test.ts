import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentMailClient } from '../src/main/features/email/agentmail'
import { CloudflareMailClient, MAIL_WORKER_SOURCE, MAIL_WORKER_VERSION, summarize } from '../src/main/features/email/cloudflare'
import { EmailService, type SavedEmail } from '../src/main/features/email/service'
import { emailToolSource } from '../src/main/features/email/tools'
import type { ToolContext, ToolQuery } from '../src/main/agent/tools'
import { CLOUDFLARE_TOKEN_URL } from '@shared/email'
import { GLOBAL_EMAIL, GLOBAL_KEY, TOKEN, fakeCloudflare, type FakeCloudflare } from './cloudflareFake'

/**
 * Eaon's email on the user's own domain, through their Cloudflare account,
 * against a fake Cloudflare API: setting up (KV, the Worker, Email Routing,
 * sending, DNS records, routing rules), refusing to take over a domain's
 * existing mail, naming a missing token permission, mail arriving through
 * the uploaded Worker, sending and replying in the thread, workers' own
 * addresses, and switching back to AgentMail. Paths and bodies follow the
 * Cloudflare API reference (Email Routing, Email Sending, Workers, KV, DNS).
 */

let fakes: FakeCloudflare[] = []
let dirs: string[] = []
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()))
  fakes = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

interface Harness {
  fake: FakeCloudflare
  email: EmailService
  vault: Map<string, string>
  saved: () => SavedEmail | null
}

async function setup(): Promise<Harness> {
  const fake = await fakeCloudflare()
  fakes.push(fake)
  const vault = new Map<string, string>()
  let saved: SavedEmail | null = null
  const email = new EmailService({
    createClient: (key) => new AgentMailClient(key, { baseUrl: 'http://127.0.0.1:9', retryDelayMs: 0 }),
    getKey: () => vault.get('agentmail'),
    setKey: (key) => (key ? vault.set('agentmail', key) : vault.delete('agentmail')),
    createCloudflare: (token, getConfig, saveConfig, auth) => new CloudflareMailClient(token, getConfig, saveConfig, { baseUrl: fake.url, retryDelayMs: 0, workerOrigin: `${fake.url}/__worker`, ...auth }),
    tokenSettleMs: 0,
    getCloudflareToken: () => vault.get('cloudflare'),
    setCloudflareToken: (token) => (token ? vault.set('cloudflare', token) : vault.delete('cloudflare')),
    load: () => saved,
    save: (next) => (saved = structuredClone(next))
  })
  email.load()
  return { fake, email, vault, saved: () => saved }
}

/** Mail arriving: Email Routing runs the Worker Eaon uploaded, with the KV namespace bound as MAIL. */
async function deliver(fake: FakeCloudflare, envelope: { from: string; to: string }, mime: string): Promise<void> {
  const script = fake.scripts.get('eaon-mail')
  assert.ok(script, 'the Worker was uploaded')
  const dir = mkdtempSync(join(tmpdir(), 'eaon-mail-worker-'))
  dirs.push(dir)
  const file = join(dir, 'worker.mjs')
  writeFileSync(file, script.source)
  const worker = (await import(pathToFileURL(file).href)).default as { email: (message: unknown, env: unknown) => Promise<void> }
  const headerBlock = mime.split(/\r?\n\r?\n/)[0]
  const headers = new Headers()
  for (const line of headerBlock.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const env = {
    MAIL: {
      put: async (key: string, value: ArrayBuffer, options: { metadata?: Record<string, unknown> }) => {
        fake.kv.set(key, { value: Buffer.from(value), metadata: options.metadata ?? null })
      }
    }
  }
  let rejected: string | null = null
  await worker.email({ ...envelope, headers, raw: new Blob([mime]).stream(), rawSize: Buffer.byteLength(mime), setReject: (reason: string) => (rejected = reason) }, env)
  assert.equal(rejected, null)
}

const mail = (from: string, to: string, subject: string, body: string, extra = ''): string =>
  [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Message-ID: <abc123@mail.gmail.com>',
    'Date: Thu, 01 Oct 2026 10:00:00 +0000',
    ...(extra ? [extra] : []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    body
  ].join('\r\n')

// — Setting up ——————————————————————————————————————————————————

test('the token lists the domains on the account, and a wrong token is a sentence', async () => {
  const h = await setup()
  const zones = await h.email.cloudflareZones(TOKEN)
  assert.deepEqual(
    zones.map((z) => z.name),
    ['example.com', 'withmail.com']
  )
  assert.equal(h.email.state().status, 'off')
})

test('each way a pasted key can be wrong gets its own sentence', async () => {
  const h = await setup()
  // A well-formed token Cloudflare doesn't know: deleted, rolled, expired, or a character lost.
  await assert.rejects(h.email.cloudflareZones(TOKEN.replace('Ab3', 'Ab4')), /doesn’t recognise this token.*shows a token only once/)
  // Not shaped like a token at all: Cloudflare answers 6003/6111.
  await assert.rejects(h.email.cloudflareZones('my-token-name-from-the-list'), /isn’t an API token.*not the Global API Key, a token’s name or an ID/)
  // Caught before anything is sent.
  await assert.rejects(h.email.cloudflareZones('0123456789abcdef0123456789abcdef'), /account or zone ID, not a token/)
  await assert.rejects(h.email.cloudflareZones('cfut_Ab3dEf6hIj9kLm2n'), /looks cut short/)
  await assert.rejects(h.email.cloudflareZones(GLOBAL_KEY), /That’s your Global API Key\. Add the email you sign in to Cloudflare with/)
  await assert.rejects(h.email.cloudflareZones(GLOBAL_KEY, 'someone@else.com'), /didn’t accept that Global API Key with that email/)
  // An older, unprefixed Global API Key (37 hex) is recognised too.
  await assert.rejects(h.email.cloudflareZones('0123456789abcdef0123456789abcdef01234'), /That’s your Global API Key/)
  assert.equal(h.email.state().status, 'off')
})

test('what comes along when copying is cleaned off: spaces, quotes, “Bearer”, invisible characters', async () => {
  const h = await setup()
  for (const pasted of [`  ${TOKEN}\n`, `"${TOKEN}"`, `Bearer ${TOKEN}`, `Authorization: Bearer ${TOKEN}`, `${TOKEN}\u200b`, `\u00a0${TOKEN}\ufeff`]) {
    const zones = await h.email.cloudflareZones(pasted)
    assert.equal(zones.length, 2, JSON.stringify(pasted))
  }
})

test('a Global API Key makes a token with only what email needs, on that domain; only the token is kept', async () => {
  const h = await setup()
  assert.deepEqual((await h.email.cloudflareZones(GLOBAL_KEY, GLOBAL_EMAIL)).map((z) => z.name), ['example.com', 'withmail.com'])
  const state = await h.email.setUpCloudflare({ token: GLOBAL_KEY, email: GLOBAL_EMAIL, zoneId: 'zone1', username: 'eaon' })
  assert.equal(state.status, 'ready')
  assert.equal(state.inbox?.address, 'eaon@example.com')

  assert.equal(h.fake.created.length, 1)
  const [made] = h.fake.created
  assert.equal(made.name, 'Eaon email (example.com)')
  assert.deepEqual(
    made.policies.map((p) => [Object.keys(p.resources)[0], p.permission_groups.map((g) => g.id).sort()]),
    [
      ['com.cloudflare.api.account.zone.zone1', ['pg-dns-write', 'pg-routing-rules', 'pg-zone-read', 'pg-zone-settings']],
      ['com.cloudflare.api.account.acct1', ['pg-addresses', 'pg-kv', 'pg-scripts', 'pg-sending']]
    ],
    'the four zone permissions on that domain only, the three account ones on its account; no others'
  )
  assert.equal(h.vault.get('cloudflare'), made.value, 'the vault holds the new token')
  assert.ok(![...h.vault.values()].includes(GLOBAL_KEY), 'and never the Global API Key')
  assert.ok(!JSON.stringify(h.saved()).includes(GLOBAL_KEY))
  // Everything after the first request ran on the narrow token.
  await h.email.send({ to: ['jo@gmail.com'], subject: 'Hi', text: 'Hello' })
  assert.equal(h.fake.sent.length, 1)
})

test('a missing permission is named, whichever way Cloudflare words the refusal', async () => {
  const h = await setup()
  h.fake.permissions.delete('workers_scripts:edit') // answered with 9109 "Unauthorized to access requested resource"
  await assert.rejects(h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' }), /missing a permission Eaon needs: Workers Scripts: Edit/)
  h.fake.permissions.add('workers_scripts:edit')
  h.fake.permissions.delete('dns:edit') // answered with 10000 "Authentication error"
  await assert.rejects(h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' }), /missing a permission Eaon needs: DNS: Edit/)
})

test('a permission lost after setup is named at the step that needs it, not blamed on the token', async () => {
  const h = await setup()
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' })
  h.fake.permissions.delete('email_sending:edit')
  await assert.rejects(h.email.send({ to: ['jo@gmail.com'], subject: 'Hi', text: 'Hello' }), /Cloudflare didn’t send it: Unauthorized\..*Email Sending: Edit/)
  assert.equal(h.email.state().status, 'ready', 'the token isn’t marked broken')
})

test('setting up makes everything on Cloudflare and switches Eaon’s email to the domain', async () => {
  const h = await setup()
  const state = await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon', displayName: 'Eaon' })

  assert.equal(state.status, 'ready')
  assert.equal(state.provider, 'cloudflare')
  assert.equal(state.inbox?.address, 'eaon@example.com')
  assert.deepEqual(state.cloudflare, { zoneName: 'example.com', domain: 'example.com', canSend: true, sendsTo: 'anyone', verified: null, returnsToAgentMail: false })
  assert.equal(h.vault.get('cloudflare'), TOKEN, 'the token is in the vault')
  assert.ok(!JSON.stringify(h.saved()).includes(TOKEN), 'and nowhere in email.json')

  // KV and the Worker: bound to it, able to send to verified addresses, with a secret only Eaon knows.
  assert.deepEqual(h.fake.namespaces.map((n) => n.title), ['eaon-mail'])
  const script = h.fake.scripts.get('eaon-mail')!
  assert.equal(script.metadata.main_module, 'worker.js')
  const bindings = script.metadata.bindings as { type: string; name: string; namespace_id?: string; text?: string }[]
  assert.deepEqual(bindings.slice(0, 2), [{ type: 'kv_namespace', name: 'MAIL', namespace_id: h.fake.namespaces[0].id }, { type: 'send_email', name: 'SEND' }])
  assert.equal(bindings[2].type, 'secret_text')
  assert.match(bindings[2].text ?? '', /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(h.saved()).includes(bindings[2].text!), 'the secret isn’t in email.json')
  assert.equal(script.source, MAIL_WORKER_SOURCE)
  assert.equal(h.fake.workersDev.get('eaon-mail'), true)

  // Email Routing on, and the address routed to the Worker.
  assert.equal(h.fake.routing.get('zone1')?.enabled, true)
  assert.deepEqual(
    h.fake.rules.get('zone1')!.map((r) => [r.matchers[0].value, r.actions[0].type, r.actions[0].value[0]]),
    [['eaon@example.com', 'worker', 'eaon-mail']]
  )

  // Sending onboarded, and every record it needs is in the zone.
  assert.deepEqual(h.fake.sending.get('zone1')!.map((s) => s.name), ['example.com'])
  const names = h.fake.dns.get('zone1')!.map((r) => `${r.type} ${r.name}`)
  for (const wanted of ['MX cf-bounce.example.com', 'TXT cf-bounce.example.com', 'TXT cf-bounce._domainkey.example.com', 'TXT _dmarc.example.com', 'MX example.com']) {
    assert.ok(names.includes(wanted), `${wanted} is in the zone`)
  }
  assert.equal(state.domains[0].status, 'VERIFIED')
  assert.ok(state.domains[0].records.every((r) => r.status === 'VALID'))
})

test('setting up again changes nothing that is already right', async () => {
  const h = await setup()
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' })
  const records = h.fake.dns.get('zone1')!.length
  await h.email.verifyDomain('example.com')
  assert.equal(h.fake.dns.get('zone1')!.length, records, 'no duplicate DNS records')
  assert.equal(h.fake.namespaces.length, 1)
  assert.equal(h.fake.rules.get('zone1')!.length, 1)
  assert.equal(h.fake.sending.get('zone1')!.length, 1)
})

test('a domain that already gets email elsewhere is never taken over; a subdomain works', async () => {
  const h = await setup()
  await assert.rejects(
    h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone2', username: 'eaon' }),
    /withmail\.com already receives email through aspmx\.l\.google\.com.*Use a subdomain for Eaon instead, like agents\.withmail\.com/
  )
  assert.equal(h.fake.routing.get('zone2')?.enabled, false, 'Email Routing was not turned on')
  assert.deepEqual(
    h.fake.dns.get('zone2')!.filter((r) => r.type === 'MX').map((r) => r.content),
    ['aspmx.l.google.com'],
    'the existing MX records are untouched'
  )

  const state = await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone2', subdomain: 'agents', username: 'eaon' })
  assert.equal(state.inbox?.address, 'eaon@agents.withmail.com')
  const apexSpf = h.fake.dns.get('zone2')!.filter((r) => r.type === 'TXT' && r.name === 'withmail.com')
  assert.equal(apexSpf.length, 1, 'the apex keeps its one SPF record')
  assert.ok(h.fake.dns.get('zone2')!.some((r) => r.type === 'MX' && r.name === 'agents.withmail.com' && r.content === 'route1.mx.cloudflare.net'))
  assert.equal(state.domains[0].status, 'VERIFIED')
})

test('a token short of permissions hears all of them at once, before anything is changed', async () => {
  const h = await setup()
  h.fake.permissions.delete('email_routing_rules:edit')
  h.fake.permissions.delete('workers_kv:edit')
  await assert.rejects(
    h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' }),
    (error: Error) => {
      assert.match(error.message, /missing 2 permissions Eaon needs: Email Routing Rules: Edit \(under Zone, for your domain\) and Workers KV Storage: Edit \(under Account\)/)
      assert.match(error.message, /choose Edit on this token, add them/)
      return true
    }
  )
  assert.equal(h.email.state().status, 'off', 'nothing switched')
  assert.equal(h.fake.namespaces.length, 0, 'no storage made')
  assert.equal(h.fake.scripts.size, 0, 'no Worker uploaded')
  assert.equal(h.fake.routing.get('zone1')?.enabled, false, 'Email Routing untouched')
  assert.equal(h.fake.dns.get('zone1')!.length, 0, 'no DNS records')
  h.fake.permissions.add('email_routing_rules:edit')
  h.fake.permissions.add('workers_kv:edit')
  assert.equal((await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' })).status, 'ready', 'and with them added, it goes through')
})

test('with no Email Sending and no workers.dev, Eaon receives and says it can’t send yet', async () => {
  const h = await setup()
  h.fake.permissions.delete('email_sending:edit')
  h.fake.workersSubdomain = null
  const state = await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'nova' })
  assert.equal(state.status, 'ready')
  assert.equal(state.cloudflare?.sendsTo, 'nobody')
  assert.match(state.domains[0].reason ?? '', /Receiving works; sending isn’t on yet\. Email Sending isn’t turned on for this Cloudflare account.*onboard example\.com.*Workers Paid plan.*only offers Read until sending is on/)
  assert.deepEqual(h.fake.sending.get('zone1'), [], 'no sending domain was attempted')
  await deliver(h.fake, { from: 'jo@gmail.com', to: 'nova@example.com' }, mail('Jo <jo@gmail.com>', 'nova@example.com', 'Hello', 'Hi Nova'))
  assert.equal((await h.email.refresh()).recent[0]?.subject, 'Hello', 'mail arrives')
  await assert.rejects(h.email.send({ to: ['jo@gmail.com'], subject: 'Hi', text: 'Hello' }), /Receiving works; sending isn’t on yet/)
  assert.equal(h.email.state().sentToday, 0, 'a refused send isn’t counted')
  const tools = emailToolSource(h.email)
  assert.match(tools.guidance!({ mode: 'work', depth: 0, request: {} } as unknown as ToolQuery)!, /can’t send yet: Email Sending isn’t turned on/)
})

test('without Email Sending, the Worker emails the account’s verified addresses for free', async () => {
  const h = await setup()
  // The co-founder's account: no Email Sending (the token can only get Read, the API answers 401).
  h.fake.permissions.delete('email_sending:edit')
  h.fake.destinations.set('me@example.com', true)
  const state = await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'nova', displayName: 'Nova' })
  assert.equal(state.cloudflare?.sendsTo, 'verified')
  const bindings = (h.fake.scripts.get('eaon-mail')!.metadata.bindings as { type: string; name: string; text?: string }[]).map((b) => `${b.type}:${b.name}`)
  assert.deepEqual(bindings, ['kv_namespace:MAIL', 'send_email:SEND', 'secret_text:SECRET'])
  assert.equal(h.fake.workersDev.get('eaon-mail'), true, 'its workers.dev address is on, for the send endpoint')
  assert.deepEqual((await h.email.refresh()).cloudflare?.verified, ['me@example.com'])

  // A verified address: sent by the Worker's binding, as Nova, with no Email Sending call.
  await h.email.send({ to: ['me@example.com'], subject: 'Acme: $20 due today', text: 'Your Acme bill of $20 is due today.' })
  assert.equal(h.fake.workerSent.length, 1)
  assert.deepEqual(h.fake.workerSent[0].from, { email: 'nova@example.com', name: 'Nova' })
  assert.deepEqual(h.fake.workerSent[0].to, ['me@example.com'])
  assert.equal(h.fake.workerSent[0].subject, 'Acme: $20 due today')
  assert.equal(h.fake.sent.length, 0)
  assert.equal(h.email.state().sentToday, 1)
  assert.equal((await h.email.list())[0].subject, 'Acme: $20 due today', 'a copy is kept')

  // Anyone else is refused before anything is sent, with the way out.
  await assert.rejects(h.email.send({ to: ['jo@gmail.com'], subject: 'Hi', text: 'Hello' }), /can only email addresses verified in your Cloudflare account, and jo@gmail\.com isn’t\. Verify it in Settings → Email/)
  assert.equal(h.fake.workerSent.length, 1)
  // Verified from Eaon: Cloudflare emails a link; once clicked, it works.
  await h.email.addVerifiedAddress('Jo@Gmail.com')
  assert.equal(h.fake.destinations.get('jo@gmail.com'), false)
  h.fake.destinations.set('jo@gmail.com', true)
  await h.email.refresh()
  await h.email.send({ to: ['jo@gmail.com'], subject: 'Hi', text: 'Hello' })
  assert.equal(h.fake.workerSent.length, 2)

  // A token that can't list addresses: the Worker's own refusal is explained the same way.
  h.fake.permissions.delete('email_routing_addresses:edit')
  await h.email.refresh()
  await assert.rejects(h.email.send({ to: ['stranger@x.io'], subject: 'Hi', text: 'Hello' }), /can only email addresses verified.*stranger@x\.io isn’t/)
  await assert.rejects(h.email.addVerifiedAddress('stranger@x.io'), /Add stranger@x\.io in Cloudflare → Email Service → Email Routing → Destination addresses/)

  // The tools say who the agent can email.
  h.fake.permissions.add('email_routing_addresses:edit')
  await h.email.refresh()
  const tools = emailToolSource(h.email)
  assert.match(tools.guidance!({ mode: 'work', depth: 0, request: {} } as unknown as ToolQuery)!, /can email only addresses verified in the user’s Cloudflare account \(me@example\.com, jo@gmail\.com\)/)
})

test('the Worker’s send endpoint answers no one without the secret', async () => {
  const h = await setup()
  h.fake.permissions.delete('email_sending:edit')
  h.fake.destinations.set('me@example.com', true)
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'nova' })
  const body = JSON.stringify({ from: 'nova@example.com', to: ['me@example.com'], subject: 'x', text: 'x' })
  for (const authorization of [undefined, 'Bearer guess', `Bearer ${TOKEN}`]) {
    const response = await fetch(`${h.fake.url}/__worker/eaon-mail/send`, { method: 'POST', headers: authorization ? { authorization } : {}, body })
    assert.equal(response.status, 404, String(authorization))
  }
  assert.equal((await fetch(`${h.fake.url}/__worker/eaon-mail/`, { method: 'GET' })).status, 404)
  assert.equal(h.fake.workerSent.length, 0)
})

test('Email Sending turned on later is picked up by the next check — no Check again', async () => {
  const h = await setup()
  h.fake.permissions.delete('email_sending:edit')
  assert.equal((await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'nova' })).cloudflare?.sendsTo, 'verified')
  h.fake.permissions.add('email_sending:edit') // turned on in the dashboard, token edited
  const after = await h.email.refresh()
  assert.equal(after.cloudflare?.sendsTo, 'anyone')
  assert.equal(after.cloudflare?.canSend, true)
  assert.deepEqual(h.fake.sending.get('zone1')!.map((d) => d.name), ['example.com'], 'the domain was onboarded')
  assert.ok(h.fake.dns.get('zone1')!.some((r) => r.name === 'cf-bounce._domainkey.example.com'), 'and its records added')
  await h.email.send({ to: ['jo@gmail.com'], subject: 'Hi', text: 'Hello' })
  assert.equal(h.fake.sent.length, 1, 'through Email Sending now, to anyone')
  assert.equal(h.fake.workerSent.length, 0)
})

test('a setup made by an older Eaon gets the current Worker when Eaon starts', async () => {
  const h = await setup()
  h.fake.permissions.delete('email_sending:edit')
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'nova' })
  // As an older Eaon left it: the store-only Worker, no send route, no version.
  const old = structuredClone(h.saved()!)
  delete old.cloudflare!.workerVersion
  old.cloudflare!.workerUrl = null
  h.fake.scripts.set('eaon-mail', { metadata: { main_module: 'worker.js', bindings: [{ type: 'kv_namespace', name: 'MAIL' }] }, source: 'export default {}' })
  let saved: SavedEmail | null = old
  const again = new EmailService({
    createClient: (key) => new AgentMailClient(key, { baseUrl: 'http://127.0.0.1:9', retryDelayMs: 0 }),
    getKey: () => undefined,
    setKey: () => {},
    createCloudflare: (token, getConfig, saveConfig, auth) =>
      new CloudflareMailClient(token, getConfig, saveConfig, { baseUrl: h.fake.url, retryDelayMs: 0, workerOrigin: `${h.fake.url}/__worker`, ...auth }),
    getCloudflareToken: () => h.vault.get('cloudflare'),
    setCloudflareToken: () => {},
    load: () => saved,
    save: (next) => (saved = structuredClone(next)),
    minuteMs: 60_000_000
  })
  again.load()
  assert.equal(again.state().cloudflare?.sendsTo, 'nobody')
  again.start()
  for (let i = 0; i < 100 && again.state().cloudflare?.sendsTo !== 'verified'; i++) await new Promise((r) => setTimeout(r, 20))
  again.stop()
  assert.equal(again.state().cloudflare?.sendsTo, 'verified')
  assert.equal(h.fake.scripts.get('eaon-mail')!.source, MAIL_WORKER_SOURCE, 'the current Worker was uploaded')
  assert.equal(saved!.cloudflare!.workerVersion, MAIL_WORKER_VERSION)
})

// — Mail ————————————————————————————————————————————————————————

test('mail arriving through the Worker shows up in the inbox, parsed, and is read once', async () => {
  const h = await setup()
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon', displayName: 'Eaon' })
  await deliver(h.fake, { from: 'jo@gmail.com', to: 'eaon@example.com' }, mail('Jo Smith <jo@gmail.com>', 'eaon@example.com', '=?UTF-8?B?TMO8bmNoPw==?=', 'Are you free on Friday?\r\n\r\nJo'))

  const state = await h.email.refresh()
  assert.equal(state.recent.length, 1)
  const [message] = state.recent
  assert.equal(message.from, 'Jo Smith <jo@gmail.com>')
  assert.equal(message.subject, 'Lünch?', 'encoded subjects are decoded')
  assert.match(message.preview, /Are you free on Friday/)
  assert.equal(message.unread, true)
  assert.equal(state.unread, 1)

  const read = await h.email.read(message.id)
  assert.match(read.text ?? '', /Are you free on Friday\?/)
  assert.equal(h.email.state().unread, 0)
  assert.equal((await h.email.refresh()).unread, 0, 'read state is remembered in Eaon')
  assert.ok(h.saved()!.read.includes(message.id))
})

test('the Worker keeps a message under the inverted-clock key with its metadata', async () => {
  const h = await setup()
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' })
  await deliver(h.fake, { from: 'bounce@x.io', to: 'Eaon@Example.com' }, mail('A <a@x.io>', 'eaon@example.com', 'Hi', 'hello'))
  const [key] = [...h.fake.kv.keys()]
  assert.match(key, /^m\/\d{13}-[0-9a-f]{8}$/)
  const meta = h.fake.kv.get(key)!.metadata!
  assert.equal(meta.d, 'in')
  assert.equal(meta.r, 'eaon@example.com', 'the envelope recipient, lowercased')
  assert.equal(meta.f, 'A <a@x.io>')
  assert.ok(JSON.stringify(meta).length < 1024, 'within KV’s metadata limit')
})

test('sending goes through Email Sending as the address, and a copy is kept', async () => {
  const h = await setup()
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon', displayName: 'Eaon' })
  await h.email.send({ to: ['jo@gmail.com'], cc: ['sam@x.io'], subject: 'Friday', text: 'Friday works.' })
  assert.deepEqual(h.fake.sent[0], { from: { address: 'eaon@example.com', name: 'Eaon' }, to: ['jo@gmail.com'], cc: ['sam@x.io'], subject: 'Friday', text: 'Friday works.' })
  assert.equal(h.email.state().sentToday, 1)
  const listed = await h.email.list()
  assert.equal(listed[0].sent, true)
  assert.equal(listed[0].subject, 'Friday')
  assert.equal(listed[0].unread, false)
})

test('a reply goes to the sender, in the thread', async () => {
  const h = await setup()
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' })
  await deliver(
    h.fake,
    { from: 'jo@gmail.com', to: 'eaon@example.com' },
    mail('Jo <jo@gmail.com>', 'eaon@example.com, sam@x.io', 'Lunch?', 'Free Friday?', 'References: <first@mail.gmail.com>\r\nCc: kim@y.io')
  )
  const [incoming] = (await h.email.refresh()).recent
  await h.email.reply(incoming.id, 'Yes, Friday works.', true)
  const reply = h.fake.sent[0]
  assert.deepEqual(reply.to, ['jo@gmail.com'])
  assert.deepEqual(reply.cc, ['sam@x.io', 'kim@y.io'], 'reply-all includes the others, never Eaon itself')
  assert.equal(reply.subject, 'Re: Lunch?')
  assert.deepEqual(reply.headers, { 'In-Reply-To': '<abc123@mail.gmail.com>', References: '<first@mail.gmail.com> <abc123@mail.gmail.com>' })
})

test('without the Workers Paid plan, Cloudflare’s refusal explains the plan', async () => {
  const h = await setup()
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' })
  h.fake.paid = false
  await assert.rejects(h.email.send({ to: ['jo@gmail.com'], subject: 'Hi', text: 'Hello' }), /Cloudflare didn’t send it: Sending to unverified destination addresses requires a Workers Paid plan\. .*Workers Paid plan \(\$5 a month/)
  assert.equal(h.email.state().sentToday, 0, 'a failed send isn’t counted')
})

// — Workers' own addresses ———————————————————————————————————————

test('a worker gets its own address: routed, read and sent from as itself', async () => {
  const h = await setup()
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' })
  const state = await h.email.setWorkerAddress('w1', { username: 'nova', displayName: 'Nova' })
  assert.deepEqual(state.workerAddresses, [{ workerId: 'w1', inbox: { id: 'nova@example.com', address: 'nova@example.com', displayName: 'Nova' } }])
  assert.ok(h.fake.rules.get('zone1')!.some((r) => r.matchers[0].value === 'nova@example.com' && r.actions[0].value[0] === 'eaon-mail'))
  await assert.rejects(h.email.setWorkerAddress('w2', { username: 'nova' }), /already belongs to another worker/)
  await assert.rejects(h.email.setWorkerAddress('w2', { username: 'eaon' }), /Eaon’s own address/)

  await deliver(h.fake, { from: 'jo@gmail.com', to: 'nova@example.com' }, mail('Jo <jo@gmail.com>', 'nova@example.com', 'For Nova', 'Hi Nova'))
  await deliver(h.fake, { from: 'jo@gmail.com', to: 'eaon@example.com' }, mail('Jo <jo@gmail.com>', 'eaon@example.com', 'For Eaon', 'Hi Eaon'))
  assert.deepEqual((await h.email.list({}, 'w1')).map((m) => m.subject), ['For Nova'], 'the worker sees its own mail')
  assert.deepEqual((await h.email.list({})).map((m) => m.subject), ['For Eaon'], 'and Eaon only its own')

  // Through the tools, on the worker's turn.
  const tools = emailToolSource(h.email)
  const query = { mode: 'work', depth: 0, request: { workerId: 'w1' } } as unknown as ToolQuery
  const byName = Object.fromEntries(tools.tools(query).map((t) => [t.name, t]))
  const ctx = { request: { chatId: 'worker:w1', workerId: 'w1' } } as unknown as ToolContext
  assert.match(tools.guidance!(query)!, /your own email address, nova@example\.com/)
  assert.match(String(await byName.email_inbox.run({}, ctx)), /For Nova/)
  assert.equal(byName.email_send.catastrophic?.({}, ctx), true, 'a worker still always asks before sending')
  await byName.email_send.run({ to: ['jo@gmail.com'], subject: 'From Nova', text: 'Hello' }, ctx)
  assert.deepEqual(h.fake.sent.at(-1)!.from, { address: 'nova@example.com', name: 'Nova' })

  await h.email.removeWorkerAddress('w1')
  assert.deepEqual(h.email.state().workerAddresses, [])
  assert.ok(!h.fake.rules.get('zone1')!.some((r) => r.matchers[0].value === 'nova@example.com'), 'the address stops receiving')
  assert.equal(h.email.addressFor('w1')?.address, 'eaon@example.com', 'the worker is back on Eaon’s address')
})

// — Switching ————————————————————————————————————————————————————

test('switching from AgentMail keeps its key; disconnecting Cloudflare goes back to it', async () => {
  const h = await setup()
  h.vault.set('agentmail', 'am_kept_key')
  // A saved AgentMail account, as if it were connected.
  const loaded = new EmailService({
    createClient: (key) => new AgentMailClient(key, { baseUrl: 'http://127.0.0.1:9', retryDelayMs: 0 }),
    getKey: () => h.vault.get('agentmail'),
    setKey: (key) => (key ? h.vault.set('agentmail', key) : h.vault.delete('agentmail')),
    createCloudflare: (token, getConfig, saveConfig, auth) => new CloudflareMailClient(token, getConfig, saveConfig, { baseUrl: h.fake.url, retryDelayMs: 0, ...auth }),
    tokenSettleMs: 0,
    getCloudflareToken: () => h.vault.get('cloudflare'),
    setCloudflareToken: (token) => (token ? h.vault.set('cloudflare', token) : h.vault.delete('cloudflare')),
    load: () => null,
    save: () => {}
  })
  loaded.load()
  const on = await loaded.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' })
  assert.equal(on.cloudflare?.returnsToAgentMail, true)
  assert.equal(h.vault.get('agentmail'), 'am_kept_key')
  const off = loaded.disconnect()
  assert.equal(off.provider, 'agentmail')
  assert.equal(h.vault.get('cloudflare'), undefined, 'the Cloudflare token is forgotten')
  assert.notEqual(off.status, 'off', 'AgentMail is back')
})

test('the email.json of the Cloudflare setup survives a restart', async () => {
  const h = await setup()
  await h.email.setUpCloudflare({ token: TOKEN, zoneId: 'zone1', username: 'eaon' })
  await h.email.setWorkerAddress('w1', { username: 'nova' })
  const again = new EmailService({
    createClient: (key) => new AgentMailClient(key),
    getKey: () => undefined,
    setKey: () => {},
    createCloudflare: (token, getConfig, saveConfig, auth) => new CloudflareMailClient(token, getConfig, saveConfig, { baseUrl: h.fake.url, ...auth }),
    tokenSettleMs: 0,
    getCloudflareToken: () => h.vault.get('cloudflare'),
    setCloudflareToken: () => {},
    load: () => h.saved(),
    save: () => {}
  })
  again.load()
  const state = again.state()
  assert.equal(state.status, 'ready')
  assert.equal(state.provider, 'cloudflare')
  assert.equal(state.inbox?.address, 'eaon@example.com')
  assert.equal(again.addressFor('w1')?.address, 'nova@example.com')
})

// — Pieces ——————————————————————————————————————————————————————

test('MIME parsing: HTML-only mail, attachments and encoded names', async () => {
  const raw = [
    'From: =?UTF-8?Q?Ren=C3=A9e?= <renee@x.io>',
    'To: eaon@example.com',
    'Subject: Report',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>The <b>report</b> is attached.</p>',
    '--b1',
    'Content-Type: application/pdf; name="q3.pdf"',
    'Content-Disposition: attachment; filename="q3.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 fake').toString('base64'),
    '--b1--'
  ].join('\r\n')
  const parsed = await summarize(raw)
  assert.equal(parsed.from, 'Renée <renee@x.io>')
  assert.match(parsed.text, /The report is attached\./)
  assert.deepEqual(parsed.attachments.map((a) => [a.filename, a.content_type, a.size]), [['q3.pdf', 'application/pdf', 13]])
})

test('the token page link pre-fills the permissions Cloudflare knows by key', () => {
  const url = new URL(CLOUDFLARE_TOKEN_URL)
  assert.equal(url.origin + url.pathname, 'https://dash.cloudflare.com/profile/api-tokens')
  assert.deepEqual(JSON.parse(url.searchParams.get('permissionGroupKeys')!).map((p: { key: string }) => p.key), ['zone', 'dns', 'workers_scripts', 'workers_kv_storage'])
  assert.equal(url.searchParams.get('name'), 'Eaon email')
})
