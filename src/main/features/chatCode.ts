import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { nativeImage, shell } from 'electron'
import { store } from '../store'
import type { Feature } from './types'
import { allowed } from './workspaceFiles'
import { changes } from './ade/git'
import { github, untrackedDiffs } from './ade/review'
import { parseUnifiedDiff } from '@shared/adeReview'
import { makeRunner, problemOf } from './ade/runner'
import { sshHosts } from './ade'
import { findOnPath } from './eaonCode/locate'
import {
  FILES_CAP,
  SEARCH_CAP,
  makeTargets,
  packageRunner,
  packageScripts,
  parseBranches,
  parseGrep,
  scriptIcon,
  type ChatBranches,
  type ChatDiffResult,
  type ChatPullRequest,
  type ChatGitResult,
  type ChatGitStatus,
  type OpenTarget,
  type ProjectScript,
  type ScriptSuggestion,
  type SearchMatch,
  type SearchOptions,
  type SearchResult
} from '@shared/chatCode'

/**
 * Chat's coding controls (shared/chatCode.ts): git in the chat's folder —
 * where it stands, its branches, switching and making one — the editors to
 * open it in, finding text across it, its files for the @ menu, and the
 * scripts saved for it. Every call names its folder, and the folder must be
 * one the agent works in (workspaceFiles.allowed), so none of it reaches the
 * rest of the disk.
 */

const run = makeRunner(sshHosts)
const SCRIPTS_FILE = 'chat-code-scripts.json'
/** Never searched or listed when the folder isn't a repository: what every project has and no one means. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'target', 'vendor', '.venv', 'venv', '__pycache__', 'coverage'])

/* ---------------------------------------------------------------- git */

async function gitStatus(cwd: string): Promise<ChatGitStatus> {
  const inside = await run(cwd, 'git', ['rev-parse', '--is-inside-work-tree'], 5000)
  if (!inside.ok) return { repo: false, branch: null, detached: null, upstream: null, ahead: 0, behind: 0, remote: false, changes: null }
  const [branch, upstream, remote, uncommitted] = await Promise.all([
    run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5000),
    run(cwd, 'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 5000),
    run(cwd, 'git', ['remote', 'get-url', 'origin'], 5000),
    changes(cwd)
  ])
  let ahead = 0
  let behind = 0
  if (upstream.ok) {
    const counts = await run(cwd, 'git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], 5000)
    const [b, a] = counts.stdout.trim().split(/\s+/).map(Number)
    behind = b || 0
    ahead = a || 0
  }
  const detached = branch.ok ? null : (await run(cwd, 'git', ['rev-parse', '--short', 'HEAD'], 5000)).stdout.trim() || null
  return {
    repo: true,
    branch: branch.ok ? branch.stdout.trim() || null : null,
    detached,
    upstream: upstream.ok ? upstream.stdout.trim() || null : null,
    ahead,
    behind,
    remote: remote.ok,
    changes: uncommitted
  }
}

async function branches(cwd: string): Promise<ChatBranches> {
  const format = '--format=%(refname:short)\t%(committerdate:unix)'
  const [current, local, remote] = await Promise.all([
    run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5000),
    run(cwd, 'git', ['for-each-ref', '--sort=-committerdate', format, 'refs/heads'], 10_000),
    run(cwd, 'git', ['for-each-ref', '--sort=-committerdate', format, 'refs/remotes/origin'], 10_000)
  ])
  return { current: current.ok ? current.stdout.trim() || null : null, branches: parseBranches(local.stdout, remote.stdout).slice(0, 400) }
}

/** A branch name to hand git: never something it would read as an option or a range. */
function branchName(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.][\w./-]{0,250}$/.test(value) || value.includes('..') || value.endsWith('.lock') || value.endsWith('/'))
    throw new Error('That isn’t a branch name git accepts.')
  return value
}

async function checkout(cwd: string, name: string, create: boolean): Promise<ChatGitResult> {
  const res = await run(cwd, 'git', create ? ['switch', '-c', name] : ['switch', name], 60_000)
  if (!res.ok) return { ok: false, error: problemOf(res, `Couldn’t switch to ${name}.`) }
  return { ok: true, message: create ? `Made ${name} and switched to it.` : `Switched to ${name}.` }
}

async function pull(cwd: string): Promise<ChatGitResult> {
  const res = await run(cwd, 'git', ['pull', '--ff-only'], 120_000)
  if (!res.ok) return { ok: false, error: problemOf(res, 'Couldn’t pull.') }
  return { ok: true, message: /Already up to date/i.test(res.stdout) ? 'Already up to date.' : 'Pulled.' }
}

/* ------------------------------------------------------------ editors */

interface TargetDef extends OpenTarget {
  /** macOS app bundle names, in /Applications or ~/Applications. */
  apps?: string[]
  /** Its command-line launcher, for other systems and for opening a file at a line. */
  cli?: string[]
  /** How its launcher takes a file and line. */
  line?: 'goto' | 'colon' | 'jetbrains'
}

const TARGETS: TargetDef[] = [
  { id: 'vscode', label: 'VS Code', kind: 'editor', apps: ['Visual Studio Code.app'], cli: ['code'], line: 'goto' },
  { id: 'cursor', label: 'Cursor', kind: 'editor', apps: ['Cursor.app'], cli: ['cursor'], line: 'goto' },
  { id: 'windsurf', label: 'Windsurf', kind: 'editor', apps: ['Windsurf.app'], cli: ['windsurf'], line: 'goto' },
  { id: 'zed', label: 'Zed', kind: 'editor', apps: ['Zed.app', 'Zed Preview.app'], cli: ['zed', 'zeditor'], line: 'colon' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', kind: 'editor', apps: ['Visual Studio Code - Insiders.app'], cli: ['code-insiders'], line: 'goto' },
  { id: 'vscodium', label: 'VSCodium', kind: 'editor', apps: ['VSCodium.app'], cli: ['codium'], line: 'goto' },
  { id: 'sublime', label: 'Sublime Text', kind: 'editor', apps: ['Sublime Text.app'], cli: ['subl'], line: 'colon' },
  { id: 'nova', label: 'Nova', kind: 'editor', apps: ['Nova.app'] },
  { id: 'xcode', label: 'Xcode', kind: 'editor', apps: ['Xcode.app'] },
  { id: 'idea', label: 'IntelliJ IDEA', kind: 'editor', apps: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app', 'IntelliJ IDEA Ultimate.app'], cli: ['idea'], line: 'jetbrains' },
  { id: 'webstorm', label: 'WebStorm', kind: 'editor', apps: ['WebStorm.app'], cli: ['webstorm'], line: 'jetbrains' },
  { id: 'pycharm', label: 'PyCharm', kind: 'editor', apps: ['PyCharm.app', 'PyCharm CE.app', 'PyCharm Professional Edition.app'], cli: ['pycharm'], line: 'jetbrains' },
  { id: 'goland', label: 'GoLand', kind: 'editor', apps: ['GoLand.app'], cli: ['goland'], line: 'jetbrains' },
  { id: 'rustrover', label: 'RustRover', kind: 'editor', apps: ['RustRover.app'], cli: ['rustrover'], line: 'jetbrains' },
  { id: 'clion', label: 'CLion', kind: 'editor', apps: ['CLion.app'], cli: ['clion'], line: 'jetbrains' },
  { id: 'phpstorm', label: 'PhpStorm', kind: 'editor', apps: ['PhpStorm.app'], cli: ['phpstorm'], line: 'jetbrains' },
  { id: 'rider', label: 'Rider', kind: 'editor', apps: ['Rider.app'], cli: ['rider'], line: 'jetbrains' },
  { id: 'android-studio', label: 'Android Studio', kind: 'editor', apps: ['Android Studio.app'], cli: ['studio'], line: 'jetbrains' },
  { id: 'terminal', label: 'Terminal', kind: 'terminal', apps: ['Utilities/Terminal.app', 'Terminal.app'] },
  { id: 'iterm', label: 'iTerm', kind: 'terminal', apps: ['iTerm.app'] },
  { id: 'warp', label: 'Warp', kind: 'terminal', apps: ['Warp.app'] },
  { id: 'ghostty', label: 'Ghostty', kind: 'terminal', apps: ['Ghostty.app'] }
]

const FILES_TARGET: OpenTarget = {
  id: 'files',
  label: process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' ? 'File Explorer' : 'Files',
  kind: 'files'
}

const FINDER = '/System/Library/CoreServices/Finder.app'

/** Where a macOS app is installed, if it is. */
function appPath(names: string[] | undefined): string | null {
  if (process.platform !== 'darwin' || !names) return null
  const dirs = ['/Applications', '/System/Applications', join(homedir(), 'Applications')]
  for (const dir of dirs) for (const name of names) if (existsSync(join(dir, name))) return join(dir, name)
  return null
}

const cliOf = (def: TargetDef): string | null => {
  for (const name of def.cli ?? []) {
    const found = findOnPath(name)
    if (found) return found
  }
  return null
}

/**
 * A macOS app's own icon, as the Finder shows it, at twice the size it's
 * drawn. Null when it can't be read; the menu draws a stand-in.
 */
async function appIcon(path: string | null): Promise<string | null> {
  if (!path) return null
  let timer: NodeJS.Timeout | undefined
  try {
    const image = await Promise.race([
      nativeImage.createThumbnailFromPath(path, { width: 64, height: 64 }),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), 3000)))
    ])
    return image.isEmpty() ? null : image.toDataURL()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Looked for once a session: installing an editor while Eaon is open is rare, and a restart finds it. */
let found: Promise<OpenTarget[]> | null = null

function openTargets(): Promise<OpenTarget[]> {
  found ??= (async () => {
    const mac = process.platform === 'darwin'
    const here = TARGETS.filter((def) => (mac ? appPath(def.apps) !== null : def.kind !== 'terminal' && cliOf(def) !== null))
    const list: OpenTarget[] = [...here.map(({ id, label, kind }) => ({ id, label, kind })), FILES_TARGET]
    if (!mac) return list
    const icons = await Promise.all(list.map((t) => appIcon(t === FILES_TARGET ? FINDER : appPath(TARGETS.find((def) => def.id === t.id)?.apps))))
    return list.map((t, i) => (icons[i] ? { ...t, icon: icons[i] } : t))
  })()
  return found
}

function launch(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Opens the folder, or a file in it at a line, in the chosen app. */
async function openIn(folder: string, targetId: string, file: string | null, line: number | null): Promise<void> {
  const target = file ?? folder
  if (targetId === 'files') {
    if (file) shell.showItemInFolder(file)
    else {
      const problem = await shell.openPath(folder)
      if (problem) throw new Error(problem)
    }
    return
  }
  const def = TARGETS.find((t) => t.id === targetId)
  if (!def) throw new Error('That app isn’t one Eaon knows how to open.')
  const cli = cliOf(def)
  // A file at a line goes through the editor's own launcher, which knows how to jump there.
  if (file && line && cli && def.line) {
    const args =
      def.line === 'goto' ? ['--goto', `${file}:${line}`] : def.line === 'colon' ? [`${file}:${line}`] : ['--line', String(line), file]
    // The folder first, so the file opens in the project's window rather than a window of its own.
    return launch(cli, [folder, ...args], folder)
  }
  const app = appPath(def.apps)
  if (app) return launch('open', ['-a', app, target], folder)
  if (cli) return launch(cli, [target], folder)
  throw new Error(`${def.label} isn’t installed on this computer.`)
}

/* ------------------------------------------------------------- search */

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function search(cwd: string, query: string, options: SearchOptions): Promise<SearchResult> {
  const inside = await run(cwd, 'git', ['rev-parse', '--is-inside-work-tree'], 5000)
  if (inside.ok) {
    // -z puts NULs after the path and the line number, which parseGrep reads; paths come relative to `cwd`.
    const args = ['grep', '-n', '-I', '-z', '--no-color', '--untracked', '--exclude-standard']
    if (!options.caseSensitive) args.push('-i')
    if (options.word) args.push('-w')
    args.push(options.regex ? '-E' : '-F', '-e', query, '--', '.')
    const res = await run(cwd, 'git', args, 30_000)
    // Exit 1 is "nothing found"; anything else that failed said why.
    if (!res.ok && res.code !== 1) return { matches: [], truncated: false, error: problemOf(res, 'The search didn’t run.') }
    return parseGrep(res.stdout)
  }
  return walkSearch(cwd, query, options)
}

/** Search without git: the folder walked, skipping what every project has and no one means. */
async function walkSearch(root: string, query: string, options: SearchOptions): Promise<SearchResult> {
  let pattern: RegExp
  try {
    const source = options.regex ? query : escapeRegex(query)
    pattern = new RegExp(options.word ? `\\b(?:${source})\\b` : source, options.caseSensitive ? '' : 'i')
  } catch (error) {
    return { matches: [], truncated: false, error: error instanceof Error ? error.message : 'That isn’t a pattern.' }
  }
  const matches: SearchMatch[] = []
  let truncated = false
  for await (const file of walk(root, 8000)) {
    const info = await stat(file).catch(() => null)
    if (!info || info.size > 1_000_000) continue
    const buffer = await readFile(file).catch(() => null)
    if (!buffer || buffer.subarray(0, 8000).includes(0)) continue
    const lines = buffer.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!pattern.test(lines[i])) continue
      if (matches.length >= SEARCH_CAP) {
        truncated = true
        break
      }
      matches.push({ path: relative(root, file).split(sep).join('/'), line: i + 1, text: lines[i].slice(0, 400) })
    }
    if (truncated) break
  }
  return { matches, truncated }
}

async function* walk(root: string, limit: number): AsyncGenerator<string> {
  const queue = [root]
  let count = 0
  while (queue.length) {
    const dir = queue.shift()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full)
      } else if (entry.isFile()) {
        if (++count > limit) return
        yield full
      }
    }
  }
}

/** The project's files, relative, for the @ menu: git's list (ignored files left out) or a walk. */
async function files(cwd: string): Promise<string[]> {
  const res = await run(cwd, 'git', ['ls-files', '-co', '--exclude-standard', '-z'], 15_000)
  if (res.ok) return res.stdout.split('\0').filter(Boolean).slice(0, FILES_CAP)
  const out: string[] = []
  for await (const file of walk(cwd, FILES_CAP)) out.push(relative(cwd, file).split(sep).join('/'))
  return out
}

/* ------------------------------------------------------------ scripts */

const savedScripts = (): Record<string, ProjectScript[]> => store.getJson<Record<string, ProjectScript[]>>(SCRIPTS_FILE, {})

function cleanScripts(value: unknown): ProjectScript[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((s): s is ProjectScript => typeof s?.id === 'string' && typeof s?.name === 'string' && typeof s?.command === 'string')
    .slice(0, 40)
    .map((s) => ({
      id: s.id.slice(0, 64),
      name: s.name.trim().slice(0, 60) || 'Script',
      command: s.command.slice(0, 4000),
      icon: (['play', 'test', 'build', 'lint', 'debug', 'terminal'] as const).includes(s.icon) ? s.icon : scriptIcon(s.name)
    }))
}

async function suggestions(cwd: string): Promise<ScriptSuggestion[]> {
  const names = await readdir(cwd).catch(() => [] as string[])
  const out: ScriptSuggestion[] = []
  if (names.includes('package.json')) {
    const json = await readFile(join(cwd, 'package.json'), 'utf8').catch(() => '')
    out.push(...packageScripts(json, packageRunner(names)))
  }
  const makefile = names.find((n) => n === 'Makefile' || n === 'makefile')
  if (makefile) out.push(...makeTargets(await readFile(join(cwd, makefile), 'utf8').catch(() => '')))
  if (names.includes('Cargo.toml'))
    out.push({ name: 'build', command: 'cargo build', icon: 'build' }, { name: 'test', command: 'cargo test', icon: 'test' }, { name: 'run', command: 'cargo run', icon: 'play' })
  if (names.includes('go.mod')) out.push({ name: 'test', command: 'go test ./...', icon: 'test' }, { name: 'build', command: 'go build ./...', icon: 'build' })
  return out
}

/** git's own name for the tree with nothing in it: what a repository with no commits is compared to. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** What isn't committed, against HEAD, new files included. */
async function uncommittedDiff(cwd: string): Promise<ChatDiffResult> {
  const head = await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', 'HEAD'], 5000)
  if (!head.ok && (head.code === null || /not a git repository/i.test(head.stderr))) return { ok: false, error: problemOf(head, 'This folder isn’t in a git repository.') }
  const [diff, untracked] = await Promise.all([
    run(cwd, 'git', ['diff', head.ok ? 'HEAD' : EMPTY_TREE, '--no-color', '--no-ext-diff', '-M', '-U3', '--'], 30_000),
    untrackedDiffs(run, cwd)
  ])
  if (!diff.ok) return { ok: false, error: problemOf(diff, 'git diff failed.') }
  return { ok: true, files: [...parseUnifiedDiff(diff.stdout), ...untracked].sort((a, b) => a.path.localeCompare(b.path)) }
}

async function pullRequest(cwd: string): Promise<ChatPullRequest> {
  const branch = await run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5000)
  const state = await github(run, cwd, branch.ok ? branch.stdout.trim() || null : null)
  return state.github ? { ok: true, pr: state.github.pr } : { ok: false, problem: state.githubProblem ?? 'GitHub couldn’t be asked about a pull request.' }
}

/* ---------------------------------------------------------------- ipc */

const textArg = (value: unknown, what: string, max = 4096): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Expected ${what}.`)
  return value
}

export const chatCodeFeature: Feature = {
  id: 'chat-code',
  register: ({ ipcMain }) => {
    ipcMain.handle('chat-code:status', async (_e, cwd: unknown) => gitStatus(await allowed(cwd)))
    ipcMain.handle('chat-code:branches', async (_e, cwd: unknown) => branches(await allowed(cwd)))
    ipcMain.handle('chat-code:switch', async (_e, cwd: unknown, name: unknown, create: unknown) => checkout(await allowed(cwd), branchName(name), create === true))
    ipcMain.handle('chat-code:pull', async (_e, cwd: unknown) => pull(await allowed(cwd)))
    ipcMain.handle('chat-code:diff', async (_e, cwd: unknown) => uncommittedDiff(await allowed(cwd)))
    ipcMain.handle('chat-code:pull-request', async (_e, cwd: unknown) => pullRequest(await allowed(cwd)))
    ipcMain.handle('chat-code:open-targets', () => openTargets())
    ipcMain.handle('chat-code:open-in', async (_e, cwd: unknown, target: unknown, file: unknown, line: unknown) => {
      const folder = await allowed(cwd)
      const path = typeof file === 'string' && file ? await allowed(file) : null
      await openIn(folder, textArg(target, 'an app', 64), path, typeof line === 'number' && line > 0 ? Math.floor(line) : null)
    })
    ipcMain.handle('chat-code:search', async (_e, cwd: unknown, query: unknown, options: SearchOptions | undefined) =>
      search(await allowed(cwd), textArg(query, 'something to find', 500), {
        caseSensitive: options?.caseSensitive === true,
        regex: options?.regex === true,
        word: options?.word === true
      })
    )
    ipcMain.handle('chat-code:files', async (_e, cwd: unknown) => files(await allowed(cwd)))
    // A reply's HTML, opened in the user's browser with its scripts running (the in-app preview keeps them off).
    ipcMain.handle('chat-code:open-html', async (_e, html: unknown) => {
      if (typeof html !== 'string' || !html.trim() || html.length > 5_000_000) throw new Error('Nothing to open.')
      const dir = join(tmpdir(), 'eaon-html-previews')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `preview-${createHash('sha256').update(html).digest('hex').slice(0, 16)}.html`)
      await writeFile(file, html, 'utf8')
      const problem = await shell.openPath(file)
      if (problem) throw new Error(problem)
    })
    ipcMain.handle('chat-code:scripts', async (_e, cwd: unknown) => {
      const folder = await allowed(cwd)
      return { scripts: savedScripts()[folder] ?? [], suggestions: await suggestions(folder) }
    })
    ipcMain.handle('chat-code:save-scripts', async (_e, cwd: unknown, scripts: unknown) => {
      const folder = await allowed(cwd)
      const all = savedScripts()
      const list = cleanScripts(scripts)
      if (list.length) all[folder] = list
      else delete all[folder]
      store.setJson(SCRIPTS_FILE, all)
      return list
    })
  }
}
