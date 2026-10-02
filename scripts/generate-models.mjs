#!/usr/bin/env node
/**
 * Regenerates the built-in model catalog, src/main/providers/catalog.generated.json.
 *
 *   npm run generate:models
 *
 * Sources, the way Pi (Eaon Code's upstream) builds its own catalog:
 *  - Pi's published provider data (`@earendil-works/pi-ai`, dist/providers/data),
 *    which is models.dev plus Pi's hand corrections — limits, which effort
 *    levels each endpoint really takes. Used for every provider Pi covers.
 *  - models.dev (https://models.dev/api.json) for the providers Pi doesn't,
 *    and for release dates, so the list is newest first.
 *
 * Mappings and conversion live in src/main/providers/catalogSources.ts, which
 * the app also runs when it refreshes models.dev at runtime. Run this before a
 * release; the app picks up models released after it on its own.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'out', 'generate-models')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [join(root, 'src/main/providers/catalogSources.ts')],
  outfile: join(out, 'catalogSources.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@shared': join(root, 'src/shared') },
  logLevel: 'error'
})
const { PI_SOURCES, MODELS_DEV_SOURCES, fromPiData, fromModelsDev } = await import(pathToFileURL(join(out, 'catalogSources.mjs')).href)

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

console.log('Fetching Pi provider data…')
const pkg = await json('https://registry.npmjs.org/@earendil-works/pi-ai/latest')
const tarball = join(out, 'pi-ai.tgz')
writeFileSync(tarball, Buffer.from(await (await fetch(pkg.dist.tarball)).arrayBuffer()))
execFileSync('tar', ['-xzf', tarball, '-C', out])
const dataDir = join(out, 'package', 'dist', 'providers', 'data')
const pi = Object.fromEntries(
  readdirSync(dataDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dataDir, f), 'utf8'))])
)

console.log('Fetching models.dev…')
const modelsDev = await json('https://models.dev/api.json')

const providers = {}
const ids = [...new Set([...Object.keys(PI_SOURCES), ...Object.keys(MODELS_DEV_SOURCES)])].sort()
for (const id of ids) {
  // The ChatGPT plan serves OpenAI's models; models.dev has no entry of its own for it.
  const devId = MODELS_DEV_SOURCES[id] ?? (id === 'chatgpt' || id === 'openai-codex' ? 'openai' : undefined)
  const fresh = devId ? fromModelsDev(modelsDev[devId], id) : []
  let models
  if (PI_SOURCES[id]) {
    if (!pi[PI_SOURCES[id]]) throw new Error(`Pi has no data file "${PI_SOURCES[id]}" (for ${id}) — update PI_SOURCES`)
    // Pi has no release dates; borrow models.dev's to sort newest first.
    const released = new Map(fresh.map((m) => [m.id, m.released]))
    const loose = (s) => s.toLowerCase().replace(/[.]/g, '-')
    const releasedLoose = new Map(fresh.map((m) => [loose(m.id), m.released]))
    models = fromPiData(pi[PI_SOURCES[id]]).map((m) => {
      const date = released.get(m.id) ?? releasedLoose.get(loose(m.id))
      return date ? { ...m, released: date } : m
    })
    models.sort((a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.label.localeCompare(b.label))
  } else {
    if (!modelsDev[MODELS_DEV_SOURCES[id]]) throw new Error(`models.dev has no provider "${MODELS_DEV_SOURCES[id]}" (for ${id})`)
    models = fresh
  }
  providers[id] = models
  console.log(`  ${id.padEnd(22)} ${String(models.length).padStart(4)} models  (${PI_SOURCES[id] ? `pi:${PI_SOURCES[id]}` : `models.dev:${MODELS_DEV_SOURCES[id]}`})`)
}

const target = join(root, 'src/main/providers/catalog.generated.json')
writeFileSync(target, JSON.stringify({ generatedAt: new Date().toISOString(), pi: pkg.version, providers }) + '\n')
console.log(`Wrote ${target} (Pi ${pkg.version}, ${Object.values(providers).reduce((n, m) => n + m.length, 0)} models)`)
rmSync(out, { recursive: true, force: true })
