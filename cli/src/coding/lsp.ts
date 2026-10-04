import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cliHome } from '../runtime/paths'

/**
 * Diagnostics from real language servers after the agent edits a file, as
 * opencode does: the edit's result tells the model "LSP errors detected in
 * this file, please fix", with the errors, so a type error is fixed in the
 * same turn instead of found by the user later.
 *
 * A server is started per language and project root on first use and kept
 * for the session. The file is opened (or changed, with a new version) and
 * we wait a moment for the server to publish diagnostics for it: longer the
 * first time, while it loads the project. Servers that offer "pull"
 * diagnostics (TypeScript 7's) are asked for them instead of waited on.
 *
 * TypeScript uses the project's own compiler: 7 and later have a language
 * server built in (`tsc --lsp`); 6 and earlier go through
 * typescript-language-server with the project's tsserver. With no compiler
 * in the project, TypeScript and Python servers come from the PATH or a
 * one-time install into the CLI profile; gopls, rust-analyzer and clangd
 * are used when they are on the PATH.
 */

export interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity?: 1 | 2 | 3 | 4
  message: string
  source?: string
  code?: string | number
}

interface Launch {
  command: string
  args: string[]
  initializationOptions?: Record<string, unknown>
  settings?: Record<string, unknown>
}

interface ServerSpec {
  id: string
  extensions: string[]
  rootMarkers: string[]
  launch(root: string): Promise<Launch | null>
}

const LANGUAGE_ID: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp'
}

function onPath(bin: string): string | null {
  const names = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin]
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const full = join(dir, name)
      if (dir && existsSync(full)) return full
    }
  }
  return null
}

const toolDir = (): string => join(cliHome(), 'lsp')
const installing = new Map<string, Promise<boolean>>()

/** Installs npm packages into the profile's tool folder once; resolves true when they are there. */
function npmInstall(packages: string[]): Promise<boolean> {
  if (process.env.EAON_CLI_NO_LSP_DOWNLOAD === '1') return Promise.resolve(false)
  const key = packages.join(' ')
  const running = installing.get(key)
  if (running) return running
  const dir = toolDir()
  mkdirSync(dir, { recursive: true })
  const job = new Promise<boolean>((done) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['install', '--prefix', dir, '--no-audit', '--no-fund', '--silent', ...packages], { stdio: 'ignore' })
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
  })
  installing.set(key, job)
  return job
}

const binIn = (dir: string, bin: string): string | null => {
  const full = join(dir, 'node_modules', '.bin', process.platform === 'win32' ? `${bin}.cmd` : bin)
  return existsSync(full) ? full : null
}

/** The first `node_modules/<pkg>` up from `from`. */
function findUp(from: string, relative: string, stop?: string): string | null {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, relative)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir || dir === stop) return null
    dir = parent
  }
}

/** The server for the TypeScript package in `dir`: its own (7+), or typescript-language-server over its tsserver. */
async function typescriptIn(dir: string, root: string): Promise<Launch | null> {
  const tsserver = join(dir, 'lib', 'tsserver.js')
  if (!existsSync(tsserver)) {
    const tsc = join(dir, 'bin', 'tsc')
    return existsSync(tsc) ? { command: process.execPath, args: [tsc, '--lsp', '--stdio'] } : null
  }
  let bin = onPath('typescript-language-server') ?? binIn(root, 'typescript-language-server') ?? binIn(toolDir(), 'typescript-language-server')
  if (!bin) {
    if (!(await npmInstall(['typescript-language-server']))) return null
    bin = binIn(toolDir(), 'typescript-language-server')
  }
  return bin ? { command: bin, args: ['--stdio'], initializationOptions: { tsserver: { path: tsserver } } } : null
}

const SERVERS: ServerSpec[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    async launch(root) {
      const project = findUp(root, 'node_modules/typescript/package.json')
      const fromProject = project ? await typescriptIn(dirname(project), root) : null
      if (fromProject) return fromProject
      const own = join(toolDir(), 'node_modules', 'typescript')
      if (!existsSync(join(own, 'package.json')) && !(await npmInstall(['typescript']))) return null
      return typescriptIn(own, root)
    }
  },
  {
    id: 'pyright',
    extensions: ['.py', '.pyi'],
    rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'pyrightconfig.json'],
    async launch(root) {
      let bin = onPath('pyright-langserver') ?? binIn(toolDir(), 'pyright-langserver')
      if (!bin) {
        if (!(await npmInstall(['pyright']))) return null
        bin = binIn(toolDir(), 'pyright-langserver')
      }
      if (!bin) return null
      const venv = [process.env.VIRTUAL_ENV, join(root, '.venv'), join(root, 'venv')].find((p) => p && existsSync(join(p, 'bin', 'python')))
      return { command: bin, args: ['--stdio'], settings: venv ? { python: { pythonPath: join(venv, 'bin', 'python') } } : {} }
    }
  },
  { id: 'gopls', extensions: ['.go'], rootMarkers: ['go.mod', 'go.work'], launch: async () => (onPath('gopls') ? { command: onPath('gopls')!, args: [] } : null) },
  {
    id: 'rust-analyzer',
    extensions: ['.rs'],
    rootMarkers: ['Cargo.toml'],
    launch: async () => (onPath('rust-analyzer') ? { command: onPath('rust-analyzer')!, args: [] } : null)
  },
  {
    id: 'clangd',
    extensions: ['.c', '.h', '.cc', '.cpp', '.hpp'],
    rootMarkers: ['compile_commands.json', 'CMakeLists.txt', 'Makefile'],
    launch: async () => (onPath('clangd') ? { command: onPath('clangd')!, args: [] } : null)
  }
]

/* ------------------------------------------------------------- one server */

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** Servers on macOS and Windows may change a path's case or escaping; compare URIs without either. */
const uriKey = (uri: string): string => {
  let decoded = uri
  try {
    decoded = decodeURIComponent(uri)
  } catch {
    /* keep it as sent */
  }
  return process.platform === 'linux' ? decoded : decoded.toLowerCase()
}

class Client {
  private child: ChildProcess
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, Pending>()
  private versions = new Map<string, number>()
  readonly diagnostics = new Map<string, { at: number; items: Diagnostic[] }>()
  private listeners = new Set<(uri: string) => void>()
  dead = false
  /** True until the first diagnostics arrive: a cold server takes longer. */
  cold = true
  /** The server answers textDocument/diagnostic, so diagnostics are asked for rather than waited on. */
  private pull = false

  constructor(
    readonly spec: ServerSpec,
    readonly root: string,
    private readonly launch: Launch
  ) {
    this.child = spawn(launch.command, launch.args, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: process.env })
    this.child.on('error', () => this.die())
    this.child.on('exit', () => this.die())
    this.child.stdout!.on('data', (chunk: Buffer) => this.read(chunk))
    this.child.stdin!.on('error', () => this.die())
  }

  private die(): void {
    this.dead = true
    for (const p of this.pending.values()) p.reject(new Error('language server stopped'))
    this.pending.clear()
  }

  private write(message: Record<string, unknown>): void {
    if (this.dead) return
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8')
    this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
  }

  request<T>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolvePromise(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? NaN)
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      if (this.buffer.length < headerEnd + 4 + length) return
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')
      this.buffer = this.buffer.subarray(headerEnd + 4 + length)
      try {
        this.handle(JSON.parse(body) as Record<string, unknown>)
      } catch {
        /* a malformed message: skip it */
      }
    }
  }

  private handle(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(String((message.error as { message?: string }).message ?? 'error')))
      else pending.resolve(message.result)
      return
    }
    const method = String(message.method ?? '')
    const params = message.params as Record<string, unknown> | undefined
    if (method === 'textDocument/publishDiagnostics' && params) {
      const uri = uriKey(String(params.uri))
      this.diagnostics.set(uri, { at: Date.now(), items: (params.diagnostics as Diagnostic[]) ?? [] })
      this.cold = false
      for (const fn of this.listeners) fn(uri)
      return
    }
    // Requests from the server need an answer, or some servers stall.
    if (message.id !== undefined && method) {
      let result: unknown = null
      if (method === 'workspace/configuration') {
        const items = ((params?.items as { section?: string }[]) ?? []).map((item) => {
          const section = item.section ?? ''
          const settings = this.launch.settings ?? {}
          return section.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), settings) ?? {}
        })
        result = items
      } else if (method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.root).href, name: 'root' }]
      else if (method === 'client/registerCapability') {
        const registrations = (params?.registrations as { method?: string }[]) ?? []
        if (registrations.some((r) => r.method === 'textDocument/diagnostic')) this.pull = true
      }
      this.write({ id: message.id, result })
    }
  }

  async initialize(): Promise<void> {
    const result = await this.request<{ capabilities?: { diagnosticProvider?: unknown } } | null>(
      'initialize',
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: 'root' }],
        initializationOptions: this.launch.initializationOptions ?? {},
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true } },
          textDocument: {
            synchronization: { didOpen: true, didChange: true, didSave: true },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
            diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false }
          },
          window: { workDoneProgress: false }
        }
      },
      45_000
    )
    if (result?.capabilities?.diagnosticProvider) this.pull = true
    this.notify('initialized', {})
    if (this.launch.settings) this.notify('workspace/didChangeConfiguration', { settings: this.launch.settings })
  }

  /** Opens or updates the file and waits for its diagnostics; returns what the server reported. */
  async check(path: string, text: string, timeoutMs: number): Promise<Diagnostic[]> {
    const uri = pathToFileURL(path).href
    const key = uriKey(uri)
    const since = Date.now()
    const version = (this.versions.get(uri) ?? 0) + 1
    if (this.pull) {
      this.sync(uri, path, text, version)
      const result = await this.request<{ kind?: string; items?: Diagnostic[] } | null>('textDocument/diagnostic', { textDocument: { uri } }, timeoutMs).catch(() => null)
      if (result?.kind === 'full') this.diagnostics.set(key, { at: Date.now(), items: result.items ?? [] })
      if (result) this.cold = false
      // "unchanged" means what was reported last still stands.
      return this.diagnostics.get(key)?.items ?? []
    }
    const waited = new Promise<void>((done) => {
      let debounce: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        this.listeners.delete(listen)
        clearTimeout(timer)
        if (debounce) clearTimeout(debounce)
        done()
      }
      const listen = (updated: string): void => {
        if (updated !== key) return
        // Servers sometimes publish twice (syntax, then types): wait a moment for the second.
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(finish, 250)
      }
      const timer = setTimeout(finish, timeoutMs)
      this.listeners.add(listen)
    })
    this.sync(uri, path, text, version)
    await waited
    const got = this.diagnostics.get(key)
    return got && got.at >= since ? got.items : []
  }

  private sync(uri: string, path: string, text: string, version: number): void {
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: LANGUAGE_ID[extname(path)] ?? 'plaintext', version, text } })
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    this.versions.set(uri, version)
  }

  stop(): void {
    if (this.dead) return
    void this.request('shutdown', null, 1500)
      .catch(() => undefined)
      .finally(() => {
        this.notify('exit', null)
        setTimeout(() => this.child.kill(), 300)
      })
  }
}

/* ------------------------------------------------------------- the manager */

export interface LspStatus {
  id: string
  root: string
  state: 'starting' | 'ready' | 'failed'
}

const clients = new Map<string, Promise<Client | null>>()
const states = new Map<string, LspStatus>()

function rootFor(spec: ServerSpec, file: string, stop: string): string {
  let dir = dirname(resolve(file))
  for (;;) {
    if (spec.rootMarkers.some((marker) => existsSync(join(dir, marker)))) return dir
    const parent = dirname(dir)
    if (parent === dir || dir === stop) return stop
    dir = parent
  }
}

function clientFor(spec: ServerSpec, root: string): Promise<Client | null> {
  const key = `${spec.id}:${root}`
  const existing = clients.get(key)
  if (existing) return existing
  states.set(key, { id: spec.id, root, state: 'starting' })
  const started = (async () => {
    const launch = await spec.launch(root)
    if (!launch) {
      states.set(key, { id: spec.id, root, state: 'failed' })
      return null
    }
    const client = new Client(spec, root, launch)
    try {
      await client.initialize()
      states.set(key, { id: spec.id, root, state: 'ready' })
      return client
    } catch {
      client.stop()
      states.set(key, { id: spec.id, root, state: 'failed' })
      return null
    }
  })()
  clients.set(key, started)
  return started
}

/** Whether a file is one some language server covers. */
export function hasServerFor(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return SERVERS.some((s) => s.extensions.includes(ext))
}

/**
 * Diagnostics for `path` (with its new `text`), errors and warnings, or
 * null when no server is available for it. Never throws; a slow server
 * just yields what it had in time.
 */
export async function diagnose(path: string, text: string, projectRoot: string): Promise<Diagnostic[] | null> {
  if (process.env.EAON_CLI_NO_LSP === '1') return null
  const ext = extname(path).toLowerCase()
  const spec = SERVERS.find((s) => s.extensions.includes(ext))
  if (!spec) return null
  try {
    // A server still installing or loading doesn't hold the edit up: it keeps
    // starting in the background and checks the next edit instead.
    const client = await Promise.race([clientFor(spec, rootFor(spec, path, projectRoot)), new Promise<null>((done) => setTimeout(() => done(null), 5_000))])
    if (!client || client.dead) return null
    return await client.check(path, text, client.cold ? 8_000 : 3_000)
  } catch {
    return null
  }
}

export function lspStatus(): LspStatus[] {
  return [...states.values()]
}

export function stopLanguageServers(): void {
  for (const pending of clients.values()) void pending.then((client) => client?.stop())
  clients.clear()
}

/** Errors only, at most `max`, as opencode reports them to the model. */
export function formatDiagnostics(file: string, items: Diagnostic[], max = 20): string {
  const errors = items.filter((d) => (d.severity ?? 1) === 1)
  if (errors.length === 0) return ''
  const lines = errors.slice(0, max).map((d) => `ERROR [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message.replace(/\s+/g, ' ')}`)
  if (errors.length > max) lines.push(`... and ${errors.length - max} more`)
  return `<diagnostics file="${file}">\n${lines.join('\n')}\n</diagnostics>`
}

/** Is `git` usable here? (Snapshots and project roots use it.) */
export function hasGit(): boolean {
  return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
}
