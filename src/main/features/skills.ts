import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import type { SkillDraft, SkillInfo, SkillSource } from '@shared/skills'
import { registerToolSource, type AgentTool } from '../agent/tools'
import { secrets } from '../secrets'
import { store } from '../store'
import type { Feature } from './types'

/**
 * Skills: folders with a SKILL.md that teach the agent one kind of work.
 *
 * The prompt carries only one line per skill — its name and description —
 * and the agent calls `load_skill` for the body when a task needs it. A
 * library of fifty skills then costs fifty short lines per request instead of
 * fifty documents, which is the whole point of the format.
 *
 * Skills are read from Eaon's folder and Claude Code's, both personal (home)
 * and per project (the Work folder), so one written for either tool works in
 * both. Project skills win a name clash, being the more specific.
 */

const LISTED_IN_PROMPT = 40

export const personalSkillsDir = (): string => join(homedir(), '.eaon', 'skills')

function roots(cwd: string | null): { dir: string; source: SkillSource }[] {
  const home = homedir()
  return [
    ...(cwd
      ? [
          { dir: join(cwd, '.eaon', 'skills'), source: 'project-eaon' as const },
          { dir: join(cwd, '.claude', 'skills'), source: 'project-claude' as const }
        ]
      : []),
    { dir: join(home, '.eaon', 'skills'), source: 'eaon' as const },
    { dir: join(home, '.claude', 'skills'), source: 'claude' as const }
  ]
}

/* ------------------------------------------------------------ Frontmatter */

const unquote = (value: string): string => {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(v.startsWith('"') ? /\\"/g : /''/g, v.startsWith('"') ? '"' : "'")
  }
  return v
}

/**
 * The YAML subset SKILL.md frontmatter actually uses: `key: value`, quoted
 * values, `>`/`|` block scalars, and plain values wrapped onto indented lines.
 * Not a YAML parser, and doesn't need to be — only name and description are read.
 */
export function parseSkillFile(text: string): { meta: Record<string, string>; body: string } {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    const [, key, rest] = kv
    const continuation: string[] = []
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
      continuation.push(lines[++i].trim())
    }
    if (/^[>|][+-]?$/.test(rest.trim())) {
      meta[key] = rest.trim().startsWith('|') ? continuation.join('\n').trim() : continuation.filter(Boolean).join(' ')
    } else {
      meta[key] = unquote([rest, ...continuation].filter(Boolean).join(' '))
    }
  }
  return { meta, body: text.slice(match[0].length) }
}

/* -------------------------------------------------------------- Discovery */

function isDir(path: string): boolean {
  try {
    // statSync follows symlinks, and ~/.claude/skills is often a folder of them.
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readSkill(dir: string, source: SkillSource): SkillInfo | null {
  const path = join(dir, 'SKILL.md')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const { meta } = parseSkillFile(text)
  const folder = dir.split(/[\\/]/).pop() ?? dir
  return {
    name: (meta.name || folder).trim(),
    description: (meta.description ?? '').replace(/\s+/g, ' ').trim(),
    source,
    dir,
    path,
    removable: source === 'eaon'
  }
}

/** Every skill visible from `cwd`, first occurrence of a name winning. */
export function discoverSkills(cwd: string | null): SkillInfo[] {
  const seen = new Set<string>()
  const out: SkillInfo[] = []
  for (const root of roots(cwd)) {
    let names: string[]
    try {
      names = readdirSync(root.dir)
    } catch {
      continue
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      const dir = join(root.dir, name)
      if (!isDir(dir)) continue
      const skill = readSkill(dir, root.source)
      if (!skill || seen.has(skill.name.toLowerCase())) continue
      seen.add(skill.name.toLowerCase())
      out.push(skill)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// tools() and guidance() are both asked for on every request of a turn; a
// short-lived cache keeps that from re-reading every SKILL.md each time while
// still noticing a skill added a moment ago.
let cached: { cwd: string | null; at: number; skills: SkillInfo[] } | null = null

function skillsFor(cwd: string | null): SkillInfo[] {
  if (!cached || cached.cwd !== cwd || Date.now() - cached.at > 5000) {
    cached = { cwd, at: Date.now(), skills: discoverSkills(cwd) }
  }
  return cached.skills
}

export function invalidateSkillCache(): void {
  cached = null
}

function enabledSkills(cwd: string | null, disabled: string[]): SkillInfo[] {
  const off = new Set(disabled.map((d) => d.toLowerCase()))
  return skillsFor(cwd).filter((skill) => !off.has(skill.name.toLowerCase()))
}

/* ------------------------------------------------------------- The tool */

/** Other files in the skill's folder, which its instructions often point at. */
function listFiles(dir: string, limit = 200): string[] {
  const out: string[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > 5 || out.length >= limit) return
    let names: string[]
    try {
      names = readdirSync(current).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (out.length >= limit) return
      if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue
      const path = join(current, name)
      if (isDir(path)) walk(path, depth + 1)
      else if (!(depth === 0 && name === 'SKILL.md')) out.push(relative(dir, path))
    }
  }
  walk(dir, 0)
  return out
}

function findSkill(skills: SkillInfo[], name: string): SkillInfo | undefined {
  const wanted = name.trim().toLowerCase()
  return (
    skills.find((s) => s.name.toLowerCase() === wanted) ??
    skills.find((s) => (s.dir.split(/[\\/]/).pop() ?? '').toLowerCase() === wanted)
  )
}

export function loadSkillText(skill: SkillInfo): string {
  const { body } = parseSkillFile(readFileSync(skill.path, 'utf8'))
  const files = listFiles(skill.dir)
  const cappedBody = body.length > 60_000 ? `${body.slice(0, 60_000)}\n\n…[SKILL.md continues; read the rest with read_file ${skill.path}]` : body
  return [
    `# Skill: ${skill.name}`,
    `Folder: ${skill.dir}`,
    '',
    cappedBody.trim(),
    '',
    files.length > 0
      ? `Other files in this skill's folder (paths relative to it; read them with read_file when the instructions call for it):\n${files.map((f) => `- ${f}`).join('\n')}${files.length >= 200 ? '\n- …' : ''}`
      : 'This skill has no other files.'
  ].join('\n')
}

const loadSkill: AgentTool = {
  name: 'load_skill',
  description:
    'Load a skill — instructions for one kind of task — by name. Do this before starting work a listed skill covers, then follow what it says.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The skill name, as listed' } },
    required: ['name']
  },
  mutating: false,
  describe: (input) => String(input.name ?? ''),
  run: async (input, ctx) => {
    const name = typeof input.name === 'string' ? input.name : ''
    const all = skillsFor(ctx.cwd)
    const skill = findSkill(all, name)
    const available = enabledSkills(ctx.cwd, ctx.settings.disabledSkills)
    if (!skill) {
      return {
        text: `No skill named "${name}". Available: ${available.map((s) => s.name).join(', ') || 'none'}.`,
        isError: true
      }
    }
    if (!available.includes(skill)) return { text: `The skill "${skill.name}" is turned off in Eaon's settings.`, isError: true }
    try {
      return loadSkillText(skill)
    } catch (error) {
      return { text: `Could not read ${skill.path}: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  }
}

registerToolSource({
  id: 'skills',
  tools: (query) => (query.mode === 'work' && enabledSkills(query.cwd, query.settings.disabledSkills).length > 0 ? [loadSkill] : []),
  guidance: (query) => {
    const skills = enabledSkills(query.cwd, query.settings.disabledSkills)
    if (skills.length === 0) return null
    const lines = skills.slice(0, LISTED_IN_PROMPT).map((s) => {
      const description = s.description.length > 150 ? `${s.description.slice(0, 147)}…` : s.description
      return `- ${s.name}${description ? `: ${description}` : ''}`
    })
    const more = skills.length - LISTED_IN_PROMPT
    return [
      'Skills are instructions for particular kinds of work. When a task matches one, call load_skill with its name before starting and follow it.',
      ...lines,
      ...(more > 0 ? [`(${more} more — call load_skill with a name to load one, or with any name to list them all.)`] : [])
    ].join('\n')
  }
})

/* --------------------------------------------------------- Create, install */

export const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

/** YAML-safe scalar: quoted whenever plain text could be misread. */
const yamlValue = (value: string): string =>
  /^[\w][\w .,()/-]*$/.test(value) && !/:\s/.test(value) ? value : JSON.stringify(value)

export function createSkill(draft: SkillDraft): SkillInfo {
  const slug = slugify(draft.name)
  if (!slug) throw new Error('Give the skill a name')
  if (!draft.description.trim()) throw new Error('Describe when the skill should be used — that line is all the agent sees until it loads the skill')
  const dir = join(personalSkillsDir(), slug)
  if (existsSync(dir)) throw new Error(`A skill folder named "${slug}" already exists`)
  mkdirSync(dir, { recursive: true })
  const body = draft.body.trim() || `# ${draft.name.trim()}\n\nDescribe the steps to follow here.`
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${yamlValue(slug)}\ndescription: ${yamlValue(draft.description.replace(/\s+/g, ' ').trim())}\n---\n\n${body}\n`
  )
  invalidateSkillCache()
  const skill = readSkill(dir, 'eaon')
  if (!skill) throw new Error('The skill was written but could not be read back')
  return skill
}

interface GithubLocation {
  owner: string
  repo: string
  /** Candidate (ref, path) pairs: a branch name may itself contain slashes. */
  candidates: { ref: string | null; path: string }[]
}

/** Understands repo, tree (folder) and blob (file) links on github.com. */
export function parseGithubUrl(input: string): GithubLocation {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('That is not a link')
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') throw new Error('Paste a github.com link to the skill’s folder')
  const [owner, rawRepo, kind, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (!owner || !rawRepo) throw new Error('Paste a link to a repository or a folder inside one')
  const repo = rawRepo.replace(/\.git$/, '')
  if (!kind) return { owner, repo, candidates: [{ ref: null, path: '' }] }
  if (kind !== 'tree' && kind !== 'blob') throw new Error('Paste a link to a folder (…/tree/…) or its SKILL.md (…/blob/…)')
  // A blob link points at a file — the skill is the folder around it.
  const segments = kind === 'blob' ? rest.slice(0, -1) : rest
  const candidates = []
  for (let split = 1; split <= Math.min(segments.length, 4); split++) {
    candidates.push({ ref: segments.slice(0, split).join('/'), path: segments.slice(split).join('/') })
  }
  if (candidates.length === 0) throw new Error('That link has no branch in it')
  return { owner, repo, candidates }
}

interface ContentItem {
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  name: string
  path: string
  size: number
  download_url: string | null
}

function githubHeaders(): Record<string, string> {
  // A connected GitHub plugin's token lifts the anonymous 60-requests-an-hour
  // limit and reaches private repos; it only ever goes to api.github.com.
  const token = secrets.get('plugin:github')
  return {
    'User-Agent': 'Eaon',
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

async function contents(owner: string, repo: string, path: string, ref: string | null): Promise<ContentItem[] | null> {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`)
  if (ref) url.searchParams.set('ref', ref)
  const res = await fetch(url, { headers: githubHeaders(), signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) return null
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      res.headers.get('x-ratelimit-remaining') === '0'
        ? 'GitHub’s hourly limit for anonymous downloads is used up. Connect the GitHub plugin, or try again later.'
        : `GitHub refused the request (${res.status})`
    )
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const body = (await res.json()) as ContentItem | ContentItem[]
  return Array.isArray(body) ? body : [body]
}

const MAX_FILES = 300
const MAX_BYTES = 20 * 1024 * 1024

/**
 * Where a downloaded file goes in the skill folder `dir`, or null if its
 * path from GitHub would put it anywhere else. A git file name may hold `\`
 * or `:`, which are separators and drives on Windows (`..\..\x`, `C:x`), so
 * those are refused before resolving; the separator after `dir` keeps
 * `/skills-evil` from passing for `/skills`.
 */
export function skillFileTarget(dir: string, rel: string): string | null {
  if (!rel || /[\\:]/.test(rel) || rel.split('/').includes('..') || posix.isAbsolute(rel)) return null
  const root = resolve(dir)
  const target = resolve(root, rel)
  return target.startsWith(root + sep) ? target : null
}

/**
 * Installs a skill from a GitHub folder into ~/.eaon/skills, fetched through
 * the contents API one directory at a time (no git, no archive tools). An
 * existing install of the same skill is moved to the Trash first, so
 * re-installing is how a skill is updated.
 */
export async function installSkillFromGithub(link: string): Promise<SkillInfo> {
  const { owner, repo, candidates } = parseGithubUrl(link)
  let root: { ref: string | null; path: string; items: ContentItem[] } | null = null
  for (const candidate of candidates) {
    const items = await contents(owner, repo, candidate.path, candidate.ref)
    if (items) {
      root = { ...candidate, items }
      break
    }
  }
  if (!root) throw new Error(`Couldn’t find that folder on GitHub (${owner}/${repo}). Is the repository public?`)

  if (!root.items.some((item) => item.type === 'file' && item.name === 'SKILL.md')) {
    const nested = root.items.filter((item) => item.type === 'dir').map((item) => item.name)
    throw new Error(
      nested.length > 0
        ? `There’s no SKILL.md in that folder. If it holds several skills, paste the link to one of them (it has: ${nested.slice(0, 8).join(', ')}${nested.length > 8 ? ', …' : ''}).`
        : 'There’s no SKILL.md in that folder.'
    )
  }

  // Gather every file first, so a failure halfway leaves nothing installed.
  const files: { rel: string; data: Buffer }[] = []
  let bytes = 0
  const basePath = root.path
  const walk = async (items: ContentItem[], depth: number): Promise<void> => {
    for (const item of items) {
      // GitHub paths are always forward-slashed, whatever the local OS.
      const rel = basePath ? posix.relative(basePath, item.path) : item.path
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || /[\\:]/.test(rel)) continue
      if (item.type === 'dir') {
        if (depth >= 6) continue
        await walk((await contents(owner, repo, item.path, root!.ref)) ?? [], depth + 1)
      } else if (item.type === 'file' && item.download_url) {
        if (files.length >= MAX_FILES) throw new Error(`That skill has more than ${MAX_FILES} files`)
        bytes += item.size
        if (bytes > MAX_BYTES) throw new Error('That skill is larger than 20 MB')
        const res = await fetch(item.download_url, { headers: { 'User-Agent': 'Eaon' }, signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`Couldn’t download ${item.path} (${res.status})`)
        files.push({ rel, data: Buffer.from(await res.arrayBuffer()) })
      }
    }
  }
  await walk(root.items, 0)

  const skillMd = files.find((f) => f.rel === 'SKILL.md')
  const { meta } = parseSkillFile(skillMd?.data.toString('utf8') ?? '')
  const folderName = root.path.split('/').filter(Boolean).pop() ?? repo
  const slug = slugify(meta.name || folderName) || slugify(folderName)
  const dir = join(personalSkillsDir(), slug)
  if (existsSync(dir)) await shell.trashItem(dir)
  for (const file of files) {
    // Belt and braces against a crafted path escaping the skill folder.
    const target = skillFileTarget(dir, file.rel)
    if (!target) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }
  invalidateSkillCache()
  const skill = readSkill(dir, 'eaon')
  if (!skill) throw new Error('The skill was downloaded but its SKILL.md could not be read')
  return skill
}

async function removeSkill(name: string): Promise<void> {
  const skill = discoverSkills(null).find((s) => s.name === name && s.removable)
  if (!skill) throw new Error('Only skills in Eaon’s own skills folder can be removed here')
  await shell.trashItem(skill.dir)
  invalidateSkillCache()
}

export const skillsFeature: Feature = {
  id: 'skills',
  register: ({ ipcMain }) => {
    ipcMain.handle('skills:list', (_e, cwd: string | null): SkillInfo[] => {
      invalidateSkillCache()
      return skillsFor(cwd ?? null)
    })
    ipcMain.handle('skills:create', (_e, draft: SkillDraft) => createSkill(draft))
    ipcMain.handle('skills:install', (_e, url: string) => installSkillFromGithub(url))
    ipcMain.handle('skills:remove', (_e, name: string) => removeSkill(name))
    ipcMain.handle('skills:open-folder', async () => {
      mkdirSync(personalSkillsDir(), { recursive: true })
      const error = await shell.openPath(personalSkillsDir())
      if (error) throw new Error(error)
    })
    ipcMain.handle('skills:reveal', (_e, path: string) => {
      // Only ever a skill folder we listed, not an arbitrary path from the renderer.
      const known = discoverSkills(store.getWorkspaces().find((w) => w.kind === 'chat')?.cwd ?? null)
      if (known.some((s) => s.path === path || s.dir === path)) shell.showItemInFolder(path)
    })
  }
}
