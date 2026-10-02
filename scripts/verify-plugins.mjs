#!/usr/bin/env node
/**
 * Checks every entry in the plugin catalog against the vendor's live server.
 *
 *   node scripts/verify-plugins.mjs                 every catalog entry
 *   node scripts/verify-plugins.mjs notion linear   only these ids
 *   node scripts/verify-plugins.mjs --url https://mcp.example.com/mcp [--url …]
 *                                                   vet a candidate before adding it
 *                                                   (the auth mode is inferred: an
 *                                                   anonymous 200 means none needed)
 *   --no-register   skip Dynamic Client Registration (it creates a real, if
 *                   harmless, client record on the vendor's server each run)
 *   --json          print the raw results as JSON instead of a table
 *
 * For each endpoint it records what an unauthenticated MCP `initialize` gets
 * back (status and WWW-Authenticate), then walks the same discovery the app's
 * sign-in does — RFC 9728 protected-resource metadata, RFC 8414 authorization
 * server metadata — using the MCP SDK's own functions, so a pass here means
 * the app's code path works too, not a hand-rolled approximation of it. For
 * servers with a registration endpoint it registers a client exactly as the
 * app would and builds the PKCE authorization URL, then requests that URL to
 * prove the vendor accepts it (a login page or a redirect to one, not an
 * `invalid_client` error). Servers that need no auth are connected to for
 * real and their tools listed.
 *
 * Exit code is non-zero when any entry fails, so this can gate a release.
 */
import { build } from 'esbuild'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  registerClient,
  selectResourceURL,
  startAuthorization
} from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const noRegister = args.includes('--no-register')
const asJson = args.includes('--json')
const urls = args.flatMap((arg, i) => (arg === '--url' && args[i + 1] ? [args[i + 1]] : []))
const only = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--url')

/** The catalog is TypeScript; bundle it on the fly so this stays a plain node script. */
async function loadCatalog() {
  const result = await build({
    entryPoints: [join(root, 'src/shared/mcpCatalog.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const TIMEOUT = 20_000
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eaon-verify', version: '1' } }
})

const errorText = (error) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 160)

async function probe(endpoint, headers) {
  const res = await fetch(endpoint, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: INITIALIZE
  })
  await res.body?.cancel().catch(() => {})
  return res
}

/** Requests the authorization URL and classifies the answer. */
async function tryAuthorize(url) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) })
  const location = res.headers.get('location') ?? ''
  const body = await res.text().catch(() => '')
  // An authorization server reports a bad client as a 4xx page, by
  // redirecting back with ?error=, or — some of them — as a 200 page that
  // just prints the OAuth error code. Any of those means the flow would not
  // start for a real user.
  const redirectError = /[?&#]error=([^&]+)/.exec(location)?.[1]
  const pageError = /\b(invalid_client|invalid_request|unauthorized_client|invalid_redirect_uri|redirect_uri_mismatch)\b/.exec(body)?.[1]
  const accepted = res.status < 400 && !redirectError && !pageError
  const detail = redirectError
    ? `redirect error=${redirectError}`
    : pageError
      ? `page says ${pageError}`
      : res.status >= 400
        ? `${res.status}: ${body.replace(/\s+/g, ' ').slice(0, 100)}`
        : location
          ? `authorize → ${new URL(location, url).host}`
          : `authorize ${res.status} (login page)`
  return { status: res.status, accepted, detail }
}

async function listToolsLive(endpoint, headers = {}) {
  const client = new Client({ name: 'eaon-verify', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers } })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    return tools.map((t) => t.name)
  } finally {
    await client.close().catch(() => {})
  }
}

async function verify(entry, clientMetadata, redirectUri) {
  const row = {
    id: entry.id,
    endpoint: entry.endpoint,
    authMode: entry.authMode,
    status: null,
    wwwAuthenticate: null,
    prm: null,
    authServer: null,
    registration: null,
    dcr: null,
    authorize: null,
    tools: null,
    verdict: 'FAIL',
    note: ''
  }
  let res
  // One retry: a single slow answer out of dozens of vendors is normal, and
  // should not read as a dead endpoint.
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try {
      res = await probe(entry.endpoint, entry.extraHeaders ?? {})
    } catch (error) {
      row.note = `unreachable: ${errorText(error)}`
    }
  }
  if (!res) return row
  row.note = ''
  row.status = res.status
  row.wwwAuthenticate = res.headers.get('www-authenticate')
  if (res.status >= 300 && res.status < 400) {
    row.note = `redirects to ${res.headers.get('location')}`
    return row
  }
  if (res.status === 404 || res.status >= 500) {
    row.note = `endpoint answered ${res.status}`
    return row
  }

  // Candidates passed with --url have no mode yet: an endpoint that answers
  // an anonymous initialize needs no auth; anything else is tried as OAuth.
  if (row.authMode === 'auto') row.authMode = entry.authMode = res.ok ? 'none' : 'oauth'

  if (entry.authMode === 'none') {
    try {
      const tools = await listToolsLive(entry.endpoint)
      row.tools = tools.length
      row.verdict = tools.length > 0 ? 'OK' : 'FAIL'
      row.note = tools.slice(0, 4).join(', ')
    } catch (error) {
      row.note = `connect failed: ${errorText(error)}`
    }
    return row
  }

  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res)
  let prm
  try {
    prm = await discoverOAuthProtectedResourceMetadata(entry.endpoint, { resourceMetadataUrl })
    row.prm = prm?.resource ?? 'yes'
  } catch (error) {
    row.prm = null
    row.note = 'no RFC 9728 metadata, fell back to the origin; '
    void error
  }
  const authServerUrl = prm?.authorization_servers?.[0] ?? new URL('/', entry.endpoint).href
  let metadata
  try {
    metadata = await discoverAuthorizationServerMetadata(authServerUrl)
  } catch (error) {
    row.note += `AS metadata error: ${errorText(error)}; `
  }
  row.authServer = metadata ? new URL(metadata.issuer ?? authServerUrl).host : null
  row.registration = Boolean(metadata?.registration_endpoint)

  if (entry.authMode === 'pastedToken' && res.ok) {
    // Some token servers (Tradier) let anyone connect and list tools, and
    // check the key on each call instead. Alive means it speaks MCP.
    try {
      const tools = await listToolsLive(entry.endpoint, entry.extraHeaders ?? {})
      row.tools = tools.length
      row.verdict = tools.length > 0 ? 'OK' : 'FAIL'
      row.note = `token checked per call (anonymous → ${res.status}); ${tools.length} tools`
    } catch (error) {
      row.note = `connect failed: ${errorText(error)}`
    }
    return row
  }
  if (entry.authMode === 'pastedToken') {
    // A token server is alive when it refuses an anonymous request as
    // unauthorised rather than 404ing or erroring.
    row.verdict = res.status === 401 || res.status === 403 || res.status === 400 ? 'OK' : 'FAIL'
    row.note += `token auth (anonymous → ${res.status})`
    return row
  }

  if (!metadata) {
    row.note += 'no authorization server metadata'
    return row
  }
  const resource = await selectResourceURL(entry.endpoint, {}, prm).catch(() => undefined)
  const wantedScope = scope || prm?.scopes_supported?.join(' ') || clientMetadata.scope

  let clientInformation
  if (entry.noDynamicRegistration && metadata.registration_endpoint) {
    // The catalog says to ask for a client id, but the vendor now registers
    // clients itself — worth knowing, since sign-in could be one click.
    row.note += 'registration_endpoint appeared (drop noDynamicRegistration?); '
  }
  if (entry.manualClientIdSetupURL && !metadata.registration_endpoint) {
    row.dcr = 'manual'
    // Nothing to register against; the user supplies a client id. Building the
    // URL still proves the endpoints and PKCE support line up.
    clientInformation = { client_id: 'eaon-verify-placeholder' }
  } else if (!metadata.registration_endpoint) {
    row.dcr = 'none'
    row.note += 'no registration_endpoint and no manual client id setup'
    return row
  } else if (noRegister) {
    row.dcr = 'skipped'
    clientInformation = { client_id: 'eaon-verify-placeholder' }
  } else {
    try {
      clientInformation = await registerClient(authServerUrl, { metadata, clientMetadata, scope: wantedScope })
      row.dcr = 'registered'
    } catch (error) {
      row.dcr = 'rejected'
      row.note += `DCR failed: ${errorText(error)}`
      return row
    }
  }

  try {
    const { authorizationUrl } = await startAuthorization(authServerUrl, {
      metadata,
      clientInformation,
      redirectUrl: redirectUri,
      scope: wantedScope,
      state: randomBytes(8).toString('hex'),
      resource
    })
    if (row.dcr === 'registered') {
      row.authorize = await tryAuthorize(authorizationUrl.href)
      row.verdict = row.authorize.accepted ? 'OK' : 'FAIL'
      row.note += row.authorize.detail
    } else {
      row.verdict = 'OK'
      // Whether the token endpoint takes a public client decides if the user
      // also has to paste their app's client secret.
      const publicClient = metadata.token_endpoint_auth_methods_supported?.includes('none') ?? false
      row.note += row.dcr === 'manual' ? `needs a client id${publicClient ? '' : ' + secret'} (no DCR)` : 'authorization URL built'
    }
  } catch (error) {
    row.note += `authorization URL: ${errorText(error)}`
  }
  return row
}

const catalog = await loadCatalog()
const entries = urls.length
  ? urls.map((url) => ({ id: new URL(url).host, endpoint: url, authMode: 'auto', extraHeaders: {} }))
  : catalog.MCP_CATALOG.filter((e) => only.length === 0 || only.includes(e.id))

const rows = []
// A few at a time: fast enough, and polite to vendors that rate-limit.
for (let i = 0; i < entries.length; i += 6) {
  rows.push(
    ...(await Promise.all(
      entries.slice(i, i + 6).map((entry) => verify(entry, catalog.MCP_OAUTH_CLIENT_METADATA, catalog.MCP_OAUTH_REDIRECT_URI))
    ))
  )
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|')
  console.log('| id | mode | anon status | RFC 9728 | auth server | DCR | result | note |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    console.log(
      `| ${r.id} | ${r.authMode} | ${cell(r.status)} | ${r.prm ? 'yes' : 'no'} | ${cell(r.authServer)} | ${cell(r.dcr ?? (r.registration ? 'available' : r.authMode === 'none' ? '' : 'no'))} | ${r.verdict}${r.tools != null ? ` (${r.tools} tools)` : ''} | ${cell(r.note)} |`
    )
  }
  const failed = rows.filter((r) => r.verdict !== 'OK')
  console.log(`\n${rows.length - failed.length}/${rows.length} passed${failed.length ? ` — failing: ${failed.map((r) => r.id).join(', ')}` : ''}`)
}
process.exit(rows.every((r) => r.verdict === 'OK') ? 0 : 1)
