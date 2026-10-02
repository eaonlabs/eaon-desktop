#!/usr/bin/env node
/**
 * Checks the curated model library against Hugging Face: every variant's repo
 * exists, every file it names is in the repo, and the catalog's size is the
 * sum of those files. Run it after touching src/main/modelLibrary/catalog.ts.
 *
 *   node scripts/verify-model-library.mjs
 *
 * The catalog is TypeScript, so it is bundled with esbuild first, the same way
 * scripts/test-main.mjs loads main-process code.
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'out', 'verify')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
await build({
  entryPoints: [join(root, 'src/main/modelLibrary/catalog.ts')],
  outfile: join(out, 'catalog.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@shared': join(root, 'src/shared') },
  logLevel: 'error'
})
const { LIBRARY } = await import(pathToFileURL(join(out, 'catalog.mjs')).href)

const trees = new Map()
async function tree(repo) {
  if (!trees.has(repo)) {
    const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`)
    trees.set(repo, response.ok ? new Map((await response.json()).filter((e) => e.type === 'file').map((e) => [e.path, e.lfs?.size ?? e.size ?? 0])) : null)
  }
  return trees.get(repo)
}

let problems = 0
for (const model of LIBRARY) {
  for (const variant of model.variants) {
    const where = `${model.id}/${variant.id}`
    const files = await tree(variant.source.repo)
    if (!files) {
      console.log(`✖ ${where}: repo ${variant.source.repo} not found`)
      problems++
      continue
    }
    const missing = variant.source.files.filter((f) => !files.has(f))
    if (missing.length) {
      console.log(`✖ ${where}: missing ${missing.join(', ')}`)
      problems++
      continue
    }
    const size = variant.source.files.reduce((sum, f) => sum + files.get(f), 0)
    if (size !== variant.sizeBytes) {
      console.log(`✖ ${where}: size ${variant.sizeBytes} in the catalog, ${size} on Hugging Face`)
      problems++
      continue
    }
    console.log(`✓ ${where}  ${(size / 1e9).toFixed(2)} GB  ${variant.source.repo}`)
  }
}
console.log(problems ? `\n${problems} problem(s)` : '\nEvery variant matches Hugging Face.')
process.exit(problems ? 1 : 0)
