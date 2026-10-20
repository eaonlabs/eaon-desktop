import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { USAGE_PROVIDERS, type ProviderTokens, type TokenSpan, type UsageProviderId } from '@shared/providerUsage'
import { cliLogs } from '../usage/cliLogs'
import { localDay } from '../usage/ledger'

/**
 * Recent token totals per tool — today, the last 7 days and the last 30 —
 * from the CLI logs Settings → Usage already reads (`usage/cliLogs.ts`). For
 * Claude Code and Codex, which keep one transcript per session, the sessions
 * those days held are counted too, from the transcripts' modified times.
 */

const DAY = 86_400_000

function dayKeys(days: number, now: Date): Set<string> {
  const keys = new Set<string>()
  for (let i = 0; i < days; i++) keys.add(localDay(new Date(now.getTime() - i * DAY)))
  return keys
}

/** Transcript modified times, at most `limit` files, within the last 30 days. */
async function transcriptTimes(root: string, depth: number, since: number, limit = 4000): Promise<number[]> {
  const out: number[] = []
  const walk = async (dir: string, level: number): Promise<void> => {
    if (out.length >= limit) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && level < depth) await walk(full, level + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const mtime = await stat(full).then((s) => s.mtimeMs, () => 0)
        if (mtime >= since) out.push(mtime)
      }
    }
  }
  await walk(root, 0)
  return out
}

async function sessionTimes(id: UsageProviderId, since: number): Promise<number[] | null> {
  const home = os.homedir()
  if (id === 'claude') return transcriptTimes(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects'), 1, since)
  if (id === 'codex') return transcriptTimes(path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions'), 3, since)
  return null
}

export async function providerTokens(now = new Date()): Promise<Partial<Record<UsageProviderId, ProviderTokens>>> {
  const { days } = cliLogs()
  const spans = { day: dayKeys(1, now), week: dayKeys(7, now), month: dayKeys(30, now) }
  const out: Partial<Record<UsageProviderId, ProviderTokens>> = {}
  for (const provider of USAGE_PROVIDERS) {
    if (!provider.logs) continue
    const key = `cli:${provider.logs}`
    const totals = { day: 0, week: 0, month: 0 }
    for (const [day, sources] of Object.entries(days)) {
      const byModel = sources[key]
      if (!byModel) continue
      let tokens = 0
      for (const counts of Object.values(byModel)) tokens += counts.input + counts.output + counts.cacheRead + counts.cacheWrite
      for (const span of ['day', 'week', 'month'] as const) if (spans[span].has(day)) totals[span] += tokens
    }
    if (totals.month === 0) continue
    const times = await sessionTimes(provider.id, now.getTime() - 30 * DAY)
    const sessions = (ms: number): number | null => (times ? times.filter((t) => t >= now.getTime() - ms).length : null)
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const span = (tokens: number, ms: number): TokenSpan => ({ tokens, sessions: sessions(ms) })
    out[provider.id] = {
      day: span(totals.day, now.getTime() - startOfToday),
      week: span(totals.week, 7 * DAY),
      month: span(totals.month, 30 * DAY)
    }
  }
  return out
}

/** Tokens by model over the last `span` days, from the coding CLIs' logs, busiest first. */
export function cliModelTokens(span = 90, now = new Date()): { tool: string; model: string; tokens: number }[] {
  const { days } = cliLogs()
  const keep = dayKeys(span, now)
  const totals = new Map<string, { tool: string; model: string; tokens: number }>()
  for (const [day, sources] of Object.entries(days)) {
    if (!keep.has(day)) continue
    for (const [source, byModel] of Object.entries(sources)) {
      if (!source.startsWith('cli:')) continue
      for (const [model, c] of Object.entries(byModel)) {
        const key = `${source}/${model}`
        const row = totals.get(key) ?? { tool: source.slice(4), model, tokens: 0 }
        row.tokens += c.input + c.output + c.cacheRead + c.cacheWrite
        totals.set(key, row)
      }
    }
  }
  return [...totals.values()].filter((r) => r.tokens > 0).sort((a, b) => b.tokens - a.tokens)
}
