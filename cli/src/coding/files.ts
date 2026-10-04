import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The project's files, for @-mentions in the composer: ripgrep's list
 * (which honours .gitignore) or git's, falling back to a bounded walk; kept
 * for a few seconds since the menu asks on every keystroke.
 */

const cache = new Map<string, { at: number; files: string[] }>()
const SKIP = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__', 'target'])

function list(cwd: string): string[] {
  const rg = spawnSync('rg', ['--files', '--hidden', '-g', '!.git'], { cwd, encoding: 'utf8', timeout: 4000, maxBuffer: 32 * 1024 * 1024 })
  if (rg.status === 0 && rg.stdout) return rg.stdout.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''))
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', timeout: 4000, maxBuffer: 32 * 1024 * 1024 })
  if (git.status === 0 && git.stdout) return git.stdout.split('\n').filter(Boolean)
  const out: string[] = []
  const queue = ['']
  while (queue.length && out.length < 20_000) {
    const rel = queue.shift()!
    let entries
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) queue.push(path)
      } else out.push(path)
    }
  }
  return out
}

export function projectFiles(cwd: string): string[] {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < 15_000) return hit.files
  const files = list(cwd).slice(0, 50_000)
  cache.set(cwd, { at: Date.now(), files })
  return files
}

/**
 * Fuzzy match: every query character in order. Matches in the file name,
 * at word starts and in runs score higher; shorter paths win ties.
 */
export function fuzzyFiles(query: string, files: string[], limit = 8): string[] {
  const q = query.toLowerCase()
  if (!q) return files.slice(0, limit)
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const nameStart = lower.lastIndexOf('/') + 1
    let score = 0
    let at = -1
    let run = 0
    let ok = true
    for (const ch of q) {
      const next = lower.indexOf(ch, at + 1)
      if (next === -1) {
        ok = false
        break
      }
      run = next === at + 1 ? run + 1 : 0
      score += 1 + run * 2 + (next >= nameStart ? 3 : 0) + (next === 0 || /[/_.-]/.test(lower[next - 1]) ? 4 : 0)
      at = next
    }
    if (!ok) continue
    if (lower.slice(nameStart).startsWith(q)) score += 20
    scored.push({ path, score: score - path.length * 0.05 })
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.path)
}
