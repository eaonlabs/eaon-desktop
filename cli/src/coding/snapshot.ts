import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { cliHome } from '../runtime/paths'
import { parseUnified, type FileDiff } from './diff'

/**
 * Snapshots of a git project, so every turn knows exactly which files it
 * changed — through edit tools or through commands it ran — and can be
 * undone. The same idea as opencode's: a private ("shadow") git repository
 * per project in the CLI profile, whose work tree is the project.
 *
 * Tracking stages the work tree into the shadow index (`add -A`, honouring
 * the project's .gitignore and info/exclude) and writes a tree; a turn
 * records the tree before and after it runs. The shadow repo borrows the
 * project's own objects (alternates) and starts from a copy of its index, so
 * the first snapshot of a large repository hashes only what's changed. The
 * project's own repository, index and branches are never touched.
 */

interface Result {
  code: number
  stdout: string
}

function git(args: string[], cwd: string, timeoutMs = 20_000, maxBytes = 8_000_000): Promise<Result> {
  return new Promise((done) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (size < maxBytes) chunks.push(chunk)
      size += chunk.length
    })
    child.on('error', () => {
      clearTimeout(timer)
      done({ code: -1, stdout: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? -1, stdout: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

export class Snapshots {
  private chain: Promise<unknown> = Promise.resolve()
  private ready: Promise<boolean> | null = null

  private constructor(
    /** The project's work tree (its git top level). */
    readonly root: string,
    private readonly gitdir: string
  ) {}

  /** Snapshots for the git project containing `cwd`, or null outside one (or without git). */
  static async for(cwd: string): Promise<Snapshots | null> {
    const top = await git(['rev-parse', '--show-toplevel'], cwd, 5000)
    if (top.code !== 0) return null
    const root = top.stdout.trim()
    if (!root) return null
    const gitdir = join(cliHome(), 'snapshots', createHash('sha1').update(root).digest('hex').slice(0, 16))
    return new Snapshots(root, gitdir)
  }

  private shadow(args: string[]): string[] {
    return ['--git-dir', this.gitdir, '--work-tree', this.root, ...args]
  }

  /** Serialises git work on this project: two turns never stage at once. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.catch(() => undefined)
    return run
  }

  private init(): Promise<boolean> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const fresh = !existsSync(join(this.gitdir, 'HEAD'))
      mkdirSync(this.gitdir, { recursive: true })
      if (fresh) {
        const made = await git(['init', '--quiet', '--bare', this.gitdir], this.root)
        if (made.code !== 0) return false
        for (const [key, value] of [
          ['core.bare', 'false'],
          ['core.fsmonitor', 'false'],
          ['core.untrackedCache', 'true'],
          ['feature.manyFiles', 'true'],
          ['gc.auto', '0']
        ])
          await git(['--git-dir', this.gitdir, 'config', key, value], this.root)
      }
      // Borrow the project's objects and start from its index: only changed files get hashed.
      const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], this.root)
      const commonDir = common.stdout.trim()
      if (common.code === 0 && commonDir) {
        const objects = join(isAbsolute(commonDir) ? commonDir : resolve(this.root, commonDir), 'objects')
        mkdirSync(join(this.gitdir, 'objects', 'info'), { recursive: true })
        writeFileSync(join(this.gitdir, 'objects', 'info', 'alternates'), `${objects}\n`)
        const exclude = join(isAbsolute(commonDir) ? commonDir : resolve(this.root, commonDir), 'info', 'exclude')
        mkdirSync(join(this.gitdir, 'info'), { recursive: true })
        if (existsSync(exclude)) copyFileSync(exclude, join(this.gitdir, 'info', 'exclude'))
        if (fresh) {
          const index = await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], this.root)
          const source = index.stdout.trim()
          if (index.code === 0 && source && existsSync(source)) {
            try {
              copyFileSync(source, join(this.gitdir, 'index'))
            } catch {
              /* a full add will do */
            }
          }
        }
      }
      return true
    })()
    return this.ready
  }

  /** Stages the work tree and returns its tree hash, or null if git failed or took too long. */
  track(): Promise<string | null> {
    return this.locked(async () => {
      if (!(await this.init())) return null
      for (let attempt = 0; attempt < 2; attempt++) {
        const added = await git(this.shadow(['add', '-A', '--ignore-errors', '--', '.']), this.root, 60_000)
        const tree = added.code === 0 || added.code === 1 ? await git(this.shadow(['write-tree']), this.root) : null
        if (tree && tree.code === 0 && tree.stdout.trim()) return tree.stdout.trim()
        // An index copied from the project that this git can't use: start the shadow index over.
        rmSync(join(this.gitdir, 'index'), { force: true })
      }
      return null
    })
  }

  /** What changed from tree `from` to tree `to`, file by file, with hunks. */
  diff(from: string, to: string): Promise<FileDiff[]> {
    return this.locked(async () => {
      if (from === to) return []
      const result = await git(this.shadow(['diff', '--no-color', '--no-ext-diff', '-M', '-U3', from, to, '--', '.']), this.root, 30_000)
      return result.code === 0 ? parseUnified(result.stdout) : []
    })
  }

  /**
   * Puts the files `changes` touched back as they were in tree `to`: files
   * that exist there are checked out of it, files that don't are removed.
   */
  restore(to: string, changes: FileDiff[]): Promise<void> {
    return this.locked(async () => {
      const listing = await git(this.shadow(['ls-tree', '-r', '--name-only', to]), this.root, 20_000)
      const present = new Set(listing.stdout.split('\n').filter(Boolean))
      const paths = new Set<string>()
      for (const change of changes) {
        paths.add(change.path)
        if (change.oldPath) paths.add(change.oldPath)
      }
      const restore = [...paths].filter((p) => present.has(p))
      const remove = [...paths].filter((p) => !present.has(p))
      for (let i = 0; i < restore.length; i += 50) await git(this.shadow(['checkout', to, '--', ...restore.slice(i, i + 50)]), this.root)
      for (const path of remove) rmSync(join(this.root, path), { force: true })
    })
  }

  /** The text of `path` in tree `tree`, or null if it wasn't there. */
  async read(tree: string, path: string): Promise<string | null> {
    const result = await git(this.shadow(['show', `${tree}:${path}`]), this.root)
    return result.code === 0 ? result.stdout : null
  }
}

const cache = new Map<string, Promise<Snapshots | null>>()

/** Snapshots for a folder, made once per folder. */
export function snapshotsFor(cwd: string): Promise<Snapshots | null> {
  if (process.env.EAON_CLI_NO_SNAPSHOTS === '1') return Promise.resolve(null)
  let found = cache.get(cwd)
  if (!found) {
    found = Snapshots.for(cwd)
    cache.set(cwd, found)
  }
  return found
}

/** For tests: forget folders seen so far. */
export function resetSnapshots(): void {
  cache.clear()
}

/** Reads a small text file, or null. */
export function readText(path: string, max = 2_000_000): string | null {
  try {
    const buffer = readFileSync(path)
    if (buffer.length > max || buffer.subarray(0, 8000).includes(0)) return null
    return buffer.toString('utf8')
  } catch {
    return null
  }
}
