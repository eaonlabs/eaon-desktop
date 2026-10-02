import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIBRARY } from '../src/main/modelLibrary/catalog'
import { tmpdir } from 'node:os'
import { freeBytes } from '../src/main/modelHub'
import {
  LIBRARY_CATEGORIES,
  diskShortfall,
  findInstalled,
  findInstalledVariant,
  fitFor,
  formatContext,
  formatModelSize,
  libraryProgressKey,
  mainFile,
  minRamGB,
  pickVariant,
  projectorFile,
  runtimeGap,
  suggestFor,
  type RuntimeInfo,
  type InstalledModel,
  type LibraryModel
} from '@shared/modelLibrary'

const GiB = 1024 ** 3
const GB = 1e9
const model = (id: string): LibraryModel => {
  const found = LIBRARY.find((m) => m.id === id)
  assert.ok(found, `catalog has ${id}`)
  return found
}
const installed = (repoId: string, filename: string): InstalledModel => ({
  id: `${repoId}:${filename}`,
  label: filename,
  repoId,
  filename,
  quant: '',
  sizeBytes: 1,
  downloadedAt: 0,
  vision: false,
  embedding: false
})
const runtime = (pulls: number[]): RuntimeInfo => ({ available: true, version: null, pulls, loaded: null })

/* ---------------------------------------------------------------- fit */

test('fit: a model well inside the GPU share fits well, one near RAM is tight, past it too big', () => {
  const ram = 24 * GiB
  assert.equal(fitFor(1.6 * GB, ram), 'good')
  // Qwen3.8 27B's unsloth UD-Q3_K_XL with its vision projector: just inside the GPU share.
  assert.equal(fitFor(14.08 * GB, ram), 'good')
  // The Ollama 27b tag: runs on 24 GB, but not entirely on the GPU.
  assert.equal(fitFor(17.74 * GB, ram), 'tight')
  // A Q8_0 27B cannot run on 24 GB at all.
  assert.equal(fitFor(29.98 * GB, ram), 'too-big')
})

test('fit: thresholds scale with RAM and move monotonically', () => {
  const order = { good: 0, tight: 1, 'too-big': 2 } as const
  for (const size of [0.3, 2, 5, 9, 14, 18, 25, 35].map((g) => g * GB)) {
    let previous = 2
    for (const ram of [8, 16, 24, 32, 48, 64, 128]) {
      const level = order[fitFor(size, ram * GiB)]
      assert.ok(level <= previous, `${size / GB} GB got worse going to ${ram} GB`)
      previous = level
    }
  }
})

/* ------------------------------------------------------ quant selection */

test('pickVariant takes the curated pick for the largest tier this machine reaches', () => {
  const qwen = model('qwen3.8-27b')
  assert.equal(pickVariant(qwen, 24 * GiB).variant.id, 'ud-q3_k_xl')
  assert.equal(pickVariant(qwen, 32 * GiB).variant.id, 'q4_k_m')
  assert.equal(pickVariant(qwen, 36 * GiB).variant.id, 'q4_k_m')
  assert.equal(pickVariant(qwen, 64 * GiB).variant.id, 'q8_0')
  assert.equal(pickVariant(qwen, 24 * GiB).tierGB, 24)

  const mini = model('minicpm5-2b')
  assert.equal(pickVariant(mini, 8 * GiB).variant.id, 'q4_k_m')
  assert.equal(pickVariant(mini, 24 * GiB).variant.id, 'q8_0')
})

test('pickVariant below the minimum offers the smallest variant and says it is too big', () => {
  const pick = pickVariant(model('qwen3.8-27b'), 16 * GiB)
  assert.equal(pick.tierGB, null)
  assert.equal(pick.variant.id, 'ud-q3_k_xl')
  assert.equal(pick.fit, 'too-big')
})

test('pickVariant rounds reported RAM to the nominal size so a "16 GB" PC is in the 16 GB tier', () => {
  const pick = pickVariant(model('k2-horizon-7b'), 15.7 * GiB)
  assert.equal(pick.tierGB, 16)
  assert.equal(pick.variant.id, 'q4_k_m')
})

/* ----------------------------------------------------------- catalog */

test('catalog: the three models the user named are present and featured', () => {
  const featured = LIBRARY.filter((m) => m.featured).map((m) => m.name)
  assert.deepEqual(featured, ['MiniCPM5 2B', 'K2 Horizon 7B', 'Qwen3.8 27B'])
})

test('catalog: 15–25 further models, covering every category', () => {
  const others = LIBRARY.filter((m) => !m.featured)
  assert.ok(others.length >= 15 && others.length <= 25, `${others.length} non-featured models`)
  for (const category of LIBRARY_CATEGORIES) {
    assert.ok(LIBRARY.some((m) => m.categories.includes(category.id)), `nothing in ${category.label}`)
  }
})

test('catalog: every entry is complete and internally consistent', () => {
  const ids = new Set<string>()
  for (const m of LIBRARY) {
    assert.ok(!ids.has(m.id), `duplicate id ${m.id}`)
    ids.add(m.id)
    assert.ok(m.description.length > 40 && m.description.length < 240, `${m.id} description length`)
    assert.match(m.released, /^20\d\d-\d\d-\d\d$/, `${m.id} released`)
    assert.ok(m.contextLength >= 512, `${m.id} context`)
    assert.ok(m.license.name, `${m.id} license`)
    assert.ok(m.links.huggingFace, `${m.id} links`)
    assert.ok(m.categories.length > 0 && m.capabilities.length > 0, `${m.id} categories/capabilities`)

    const variantIds = new Set(m.variants.map((v) => v.id))
    assert.equal(variantIds.size, m.variants.length, `${m.id} duplicate variant ids`)
    for (const v of m.variants) {
      assert.ok(v.sizeBytes > 50e6, `${m.id}/${v.id} size`)
      // Every variant is Hugging Face GGUF files, run by Eaon's llama.cpp.
      assert.equal(v.source.kind, 'hf')
      assert.match(v.source.repo, /^[\w.-]+\/[\w.-]+$/, `${m.id}/${v.id} repo`)
      assert.ok(v.source.files.length > 0 && v.source.files.every((f) => f.endsWith('.gguf')), `${m.id}/${v.id} files`)
      // Speculative-decoding drafts are not the model.
      assert.doesNotMatch(mainFile(v), /(^|\/)(mtp|dflash)[-_/]/i, `${m.id}/${v.id} main file is a draft model`)
      // A model that sees images brings its projector with every variant.
      if (m.capabilities.includes('vision')) assert.ok(projectorFile(v), `${m.id}/${v.id} has no mmproj`)
    }

    assert.ok(m.recommended.length > 0, `${m.id} has no tiers`)
    let previousRam = 0
    let previousSize = 0
    for (const tier of m.recommended) {
      assert.ok(tier.ramGB > previousRam, `${m.id} tiers must ascend`)
      const variant = m.variants.find((v) => v.id === tier.variant)
      assert.ok(variant, `${m.id} tier ${tier.ramGB} names unknown variant ${tier.variant}`)
      assert.ok(variant.sizeBytes >= previousSize, `${m.id} tier ${tier.ramGB} recommends a smaller file than the tier below`)
      // Every curated pick has to at least run at its own tier.
      assert.notEqual(fitFor(variant.sizeBytes, tier.ramGB * GiB), 'too-big', `${m.id} ${tier.variant} is too big at ${tier.ramGB} GB`)
      previousRam = tier.ramGB
      previousSize = variant.sizeBytes
    }
    assert.equal(minRamGB(m), m.recommended[0].ramGB)
  }
})

test('catalog: K2 Horizon needs the llama.cpp PR that Eaon builds in; nothing is unsupported outright', () => {
  assert.deepEqual(LIBRARY.filter((m) => m.unsupported).map((m) => m.id), [])
  assert.deepEqual(
    LIBRARY.filter((m) => m.requires).map((m) => [m.id, m.requires?.pull]),
    [['k2-horizon-7b', 29535]]
  )
})

test('runtimeGap: a model needing a PR runs only on a build that carries it', () => {
  const k2 = model('k2-horizon-7b')
  assert.equal(runtimeGap(k2, runtime([29535])), null)
  assert.match(runtimeGap(k2, runtime([])) ?? '', /k2-horizon architecture.*#29535/)
  assert.equal(runtimeGap(model('minicpm5-2b'), runtime([])), null)
})

/* --------------------------------------------------------- suggestions */

test('suggestFor puts the featured models first, then distinct well-fitting chat models', () => {
  const ram = 24 * GiB
  const suggested = suggestFor(LIBRARY, ram)
  assert.deepEqual(
    suggested.slice(0, 3).map((m) => m.id),
    ['minicpm5-2b', 'k2-horizon-7b', 'qwen3.8-27b']
  )
  assert.equal(suggested.length, 6)
  const rest = suggested.slice(3)
  assert.equal(new Set(rest.map((m) => m.categories[0])).size, rest.length, 'one per primary category')
  for (const m of rest) {
    assert.equal(pickVariant(m, ram).fit, 'good', `${m.id} should fit well`)
    assert.ok(!m.categories.includes('embedding'))
    assert.ok(!m.unsupported)
  }
})

test('suggestFor on an 8 GB machine only adds models that fit it', () => {
  for (const m of suggestFor(LIBRARY, 8 * GiB).filter((m) => !m.featured)) {
    assert.equal(pickVariant(m, 8 * GiB).fit, 'good', m.id)
  }
})

/* ------------------------------------------------------ installed state */

test('mainFile and projectorFile tell the model from its vision projector', () => {
  const qwen = model('qwen3.8-27b').variants[0]
  assert.doesNotMatch(mainFile(qwen), /mmproj/i)
  assert.match(projectorFile(qwen) ?? '', /mmproj/i)
  assert.equal(projectorFile(model('minicpm5-2b').variants[0]), undefined)
})

test('findInstalled matches a download by repo and model file', () => {
  const mini = model('minicpm5-2b').variants[0]
  assert.ok(findInstalled(mini, [installed(mini.source.repo, mainFile(mini))]))
  assert.equal(findInstalled(mini, [installed(mini.source.repo, 'other.gguf')]), undefined)
  assert.equal(findInstalled(mini, [installed('someone/else', mainFile(mini))]), undefined)
})

test('findInstalledVariant reports whichever variant is installed, preferring the pick', () => {
  const qwen = model('qwen3.8-27b')
  const on = (v: (typeof qwen.variants)[number]): InstalledModel => installed(v.source.repo, mainFile(v))
  const [q3, q4, q8] = ['ud-q3_k_xl', 'q4_k_m', 'q8_0'].map((id) => qwen.variants.find((v) => v.id === id)!)
  assert.equal(findInstalledVariant(qwen, [on(q8), on(q4)], q4)?.variant.id, 'q4_k_m')
  assert.equal(findInstalledVariant(qwen, [on(q8)])?.variant.id, 'q8_0')
  assert.equal(findInstalledVariant(qwen, [on(q3)], q4)?.variant.id, 'ud-q3_k_xl')
  assert.equal(findInstalledVariant(qwen, []), undefined)
})

test('library progress rows are keyed per variant, under the model name', () => {
  const mini = model('minicpm5-2b')
  assert.deepEqual(libraryProgressKey(mini, mini.variants[0]), { repoId: 'library/MiniCPM5 2B', filename: 'openbmb/MiniCPM5-2B-GGUF:Q4_K_M' })
})

/* --------------------------------------------------------- formatting */

test('formatting matches how Hugging Face shows sizes and context', () => {
  assert.equal(formatModelSize(17_741_872_154), '18 GB')
  assert.equal(formatModelSize(1_561_319_197), '1.6 GB')
  assert.equal(formatModelSize(621_875_917), '622 MB')
  assert.equal(formatContext(262_144), '256K')
  assert.equal(formatContext(1_048_576), '1M')
  assert.equal(formatContext(128_000), '125K')
  assert.equal(formatContext(512), '512')
})

test('a download that would fill the disk is refused with the numbers', () => {
  const GiB = 1024 ** 3
  assert.equal(diskShortfall(5 * GiB, 100 * GiB), null)
  assert.equal(diskShortfall(5 * GiB, null), null, 'unknown free space never blocks')
  assert.match(diskShortfall(5 * GiB, 6 * GiB) ?? '', /^Needs 7\.5 GB free; this disk has 6\.4 GB\.$/)
})

test('free space is read for the models folder, and is null for a folder that does not exist', async () => {
  const free = await freeBytes(tmpdir())
  assert.ok(typeof free === 'number' && free > 0)
  assert.equal(await freeBytes('/no/such/folder/anywhere'), null)
})
