#!/usr/bin/env node
/**
 * Checks every entry in the curated model library against the live registries.
 *
 *   node scripts/verify-model-library.mjs
 *
 * For each model:
 *   - the official Hugging Face repo answers 200, and so does its ollama.com page;
 *   - Hugging Face variants: the GGUF repo answers 200, every listed file is in
 *     its `siblings`, and the `hf.co/<repo>:<quant>` manifest Ollama will pull
 *     resolves to exactly those files, with the catalog's total size;
 *   - Ollama variants: the library manifest exists, hashes to the catalog's
 *     digest (the ID `ollama list` shows), and its layers add up to the
 *     catalog's size.
 *
 * Exits non-zero if anything fails. The catalog is TypeScript, so it is bundled
 * with esbuild first, the same way scripts/test-main.mjs loads main-process code.
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const outDir = join(root, 'out', 'verify')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
await build({
  entryPoints: [join(root, 'src/main/modelLibrary/catalog.ts')],
  outfile: join(outDir, 'catalog.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@shared': join(root, 'src/shared') },
  logLevel: 'warning'
})
const { LIBRARY } = await import(pathToFileURL(join(outDir, 'catalog.mjs')).href)

const MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json'
// registry.ollama.ai answers 401 to an `ollama/…` user agent (it expects the
// CLI's signed requests); an ordinary one gets the public manifests.
const UA = { 'User-Agent': 'eaon-verify-model-library' }

async function request(url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(30_000) })
      if (response.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      return response
    } catch (error) {
      if (attempt >= 2) throw error
    }
  }
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`

async function checkHfRepo(repo) {
  const response = await request(`https://huggingface.co/api/models/${repo}?blobs=true`)
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
  const info = await response.json()
  return { ok: true, siblings: new Map((info.siblings ?? []).map((s) => [s.rfilename, s.size])) }
}

async function checkHfVariant(variant) {
  const { repo, quant, files } = variant.source
  const problems = []
  const repoCheck = await checkHfRepo(repo)
  if (!repoCheck.ok) return [`${repo}: ${repoCheck.detail}`]
  for (const file of files) if (!repoCheck.siblings.has(file)) problems.push(`${repo} has no ${file}`)

  const response = await request(`https://hf.co/v2/${repo}/manifests/${quant}`, { Accept: MANIFEST })
  if (!response.ok) return [...problems, `hf.co/${repo}:${quant} manifest: HTTP ${response.status}`]
  const manifest = await response.json()
  const layers = manifest.layers ?? []
  const model = layers.find((l) => l.mediaType.endsWith('.model'))
  const projector = layers.find((l) => l.mediaType.endsWith('.projector'))
  if (model?.size !== repoCheck.siblings.get(files[0])) problems.push(`hf.co/${repo}:${quant} pulls a model layer that is not ${files[0]}`)
  if (Boolean(projector) !== Boolean(files[1])) problems.push(`hf.co/${repo}:${quant} projector ${projector ? 'present' : 'absent'}, catalog lists ${files[1] ?? 'none'}`)
  else if (projector && projector.size !== repoCheck.siblings.get(files[1])) problems.push(`hf.co/${repo}:${quant} projector is not ${files[1]}`)
  const total = layers.reduce((sum, l) => sum + l.size, 0) + (manifest.config?.size ?? 0)
  if (total !== variant.sizeBytes) problems.push(`hf.co/${repo}:${quant} is ${total} bytes, catalog says ${variant.sizeBytes}`)
  return problems
}

async function checkOllamaVariant(variant) {
  const { tag, digest } = variant.source
  const [name, version] = tag.split(':')
  const response = await request(`https://registry.ollama.ai/v2/library/${name}/manifests/${version}`, { Accept: MANIFEST })
  if (!response.ok) return [`${tag}: HTTP ${response.status}`]
  const raw = Buffer.from(await response.arrayBuffer())
  const problems = []
  const actual = createHash('sha256').update(raw).digest('hex').slice(0, 12)
  if (actual !== digest) problems.push(`${tag} digest is ${actual}, catalog says ${digest}`)
  const manifest = JSON.parse(raw.toString('utf8'))
  const total = (manifest.layers ?? []).reduce((sum, l) => sum + l.size, 0) + (manifest.config?.size ?? 0)
  if (total !== variant.sizeBytes) problems.push(`${tag} is ${total} bytes, catalog says ${variant.sizeBytes}`)
  return problems
}

async function checkModel(model) {
  const lines = []
  let failed = false
  const note = (ok, text) => {
    if (!ok) failed = true
    lines.push(`   ${ok ? '✓' : '✗'} ${text}`)
  }

  if (model.links.huggingFace) {
    const repo = await checkHfRepo(model.links.huggingFace)
    note(repo.ok, `huggingface.co/${model.links.huggingFace}${repo.ok ? '' : ` — ${repo.detail}`}`)
  }
  if (model.links.ollama) {
    const response = await request(`https://ollama.com/library/${model.links.ollama}`)
    note(response.ok, `ollama.com/library/${model.links.ollama}${response.ok ? '' : ` — HTTP ${response.status}`}`)
  }
  for (const variant of model.variants) {
    const problems = variant.source.kind === 'hf' ? await checkHfVariant(variant) : await checkOllamaVariant(variant)
    const ref = variant.source.kind === 'hf' ? `hf.co/${variant.source.repo}:${variant.source.quant}` : variant.source.tag
    const label = `${variant.quant.padEnd(13)} ${ref} (${gb(variant.sizeBytes)}${variant.source.kind === 'ollama' ? `, ${variant.source.digest}` : `, ${variant.source.files.join(' + ')}`})`
    note(problems.length === 0, problems.length ? `${label}\n       ${problems.join('\n       ')}` : label)
  }
  return { model, lines, failed }
}

// A few at a time: enough to finish quickly, few enough to stay clear of rate limits.
const queue = [...LIBRARY]
const results = new Map()
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let model = queue.shift(); model; model = queue.shift()) results.set(model.id, await checkModel(model))
  })
)

let failures = 0
let variants = 0
for (const model of LIBRARY) {
  const result = results.get(model.id)
  if (result.failed) failures++
  variants += model.variants.length
  console.log(`${result.failed ? '✗' : '✓'} ${model.name}${model.featured ? ' (featured)' : ''} — ${model.org}`)
  for (const line of result.lines) console.log(line)
}
console.log(`\n${LIBRARY.length} models, ${variants} variants: ${failures === 0 ? 'all resolve' : `${failures} model(s) with problems`}`)
process.exit(failures === 0 ? 0 : 1)
