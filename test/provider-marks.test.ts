import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MARK } from '../src/renderer/src/components/composer/markFiles'
import { TOOL_LABEL, toolMark } from '../src/renderer/src/components/settings/pages/usageTools'
import { USAGE_PROVIDERS } from '../src/shared/providerUsage'
import { BUILT_IN } from '../src/main/providers/catalog'
import type { UsageTool } from '../src/shared/usage'

/**
 * Every provider and coding agent Eaon lists is drawn with its own mark, not
 * the first letter of its name in a ring (ProviderMark's fallback): Settings →
 * Usage & limits showed an "A" for Antigravity, whose mark was shipped and
 * never named, and a "D" for Devin, which had none.
 */

const files = new Set(readdirSync(join(process.cwd(), 'src', 'renderer', 'src', 'assets', 'providers', 'marks')).map((f) => f.replace(/\.(png|svg)$/, '')))
const drawn = (id: string): boolean => files.has(MARK[id] ?? '')

test('every plan and balance in Usage & limits has a mark', () => {
  assert.deepEqual(USAGE_PROVIDERS.filter((p) => !drawn(p.mark)).map((p) => p.name), [])
})

test('every coding CLI Settings → Usage counts has a mark', () => {
  const tools = Object.keys(TOOL_LABEL) as UsageTool[]
  assert.deepEqual(tools.filter((tool) => !drawn(toolMark(tool))), [])
})

test('every built-in model provider has a mark in the model picker', () => {
  // MLX has no logo of its own to draw; its tile elsewhere spells out the name.
  const missing = BUILT_IN.filter((p) => p.id !== 'mlx' && !drawn(p.id)).map((p) => p.id)
  assert.deepEqual(missing, [])
})

test('every mark named is shipped, and every mark shipped is named', () => {
  assert.deepEqual(Object.entries(MARK).filter(([, file]) => !files.has(file)), [])
  const named = new Set(Object.values(MARK))
  assert.deepEqual([...files].filter((file) => !named.has(file)), [])
})
