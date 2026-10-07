import type { UpdateStatus } from '@shared/types'

/**
 * Eaon's two kinds of update, kept apart.
 *
 * Stable updates are what they always were: found in the background, downloaded
 * by themselves, installed on the next restart. Beta updates are separate and
 * opt-in (Settings → General → Software update): when a newer beta is out the
 * app only says so, with its own "Download" button, so nobody ends up on an
 * early build without choosing to. Each has its own status; one electron-updater
 * does both jobs, one at a time, and `mode` says which job a given event
 * belongs to.
 *
 * It takes the updater as an argument (anything shaped like electron-updater's
 * `autoUpdater`) so the rules can be tested without Electron.
 */

/** The parts of electron-updater's `autoUpdater` this uses. */
export interface UpdaterLike {
  autoDownload: boolean
  allowPrerelease: boolean
  /** Only touched to go back from a beta to the stable release. */
  channel?: string | null
  allowDowngrade?: boolean
  // `any`: electron-updater types each event's listener separately; this wires them by name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: any, listener: any): unknown
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: () => void
}

export interface UpdatesDeps {
  updater: UpdaterLike
  /** The running app's version. */
  version: string
  /** Whether the user asked for beta updates. */
  betaEnabled: () => boolean
  publishStable: (status: UpdateStatus) => void
  publishBeta: (status: UpdateStatus) => void
  /** A stable check the user asked for found nothing, or failed: say so. */
  interactiveResult?: (result: { kind: 'up-to-date' } | { kind: 'error'; message: string }) => void
}

/* ------------------------------------------------------------------ versions */

interface Parsed {
  core: [number, number, number]
  pre: string[]
}

function parse(version: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim())
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

/** `2026.7.0-beta.1`, `2026.6.0-rc.1`: a build that is not a final release. */
export function isPrerelease(version: string): boolean {
  return (parse(version)?.pre.length ?? 0) > 0
}

/** Negative when `a` is older than `b`, positive when newer, 0 when the same. Semver's rules. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  // A release is newer than any prerelease of the same version.
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** A beta worth offering: a prerelease, and newer than what is installed. */
export function isNewerBeta(candidate: string, current: string): boolean {
  return isPrerelease(candidate) && compareVersions(candidate, current) > 0
}

/* ---------------------------------------------------------------- controller */

type Mode = 'stable' | 'beta-check' | 'beta-download'

const IDLE: UpdateStatus = { state: 'idle' }

export class UpdateController {
  stable: UpdateStatus = IDLE
  beta: UpdateStatus = IDLE
  private mode: Mode | null = null
  /** Set by a stable check the user asked for; cleared when it is answered. */
  private interactive = false
  /** The version the last check found, which a beta download must still be a beta. */
  private found: string | null = null
  /** Someone on a beta chose to go back: from then on this run follows stable releases only. */
  private leavingBeta = false

  constructor(private readonly deps: UpdatesDeps) {}

  /** Beta builds already follow betas and stable releases on their own (electron-updater's default). */
  get onPrerelease(): boolean {
    return isPrerelease(this.deps.version)
  }

  get busy(): boolean {
    return this.mode !== null
  }

  /** Wires the updater's events once. */
  attach(): void {
    const { updater } = this.deps
    updater.on('checking-for-update', () => {
      if (this.mode === 'stable') this.setStable({ state: 'checking' })
      else if (this.mode === 'beta-check') this.setBeta({ state: 'checking' })
    })
    updater.on('update-available', (info: { version: string }) => {
      this.found = info.version
      if (this.mode === 'stable') {
        this.setStable({ state: 'available', version: info.version })
        // The check the user asked about is answered; left set, a background
        // failure hours later would pop a dialog nobody asked for.
        this.interactive = false
      } else if (this.mode === 'beta-check') {
        this.setBeta(isNewerBeta(info.version, this.deps.version) ? { state: 'available', version: info.version } : { state: 'not-available' })
      }
    })
    updater.on('download-progress', (progress: { percent: number }) => {
      const percent = Math.round(progress.percent)
      if (this.mode === 'stable') this.setStable({ state: 'downloading', percent })
      else if (this.mode === 'beta-download') this.setBeta({ state: 'downloading', percent })
    })
    updater.on('update-downloaded', (info: { version: string }) => {
      if (this.mode === 'stable') this.setStable({ state: 'downloaded', version: info.version })
      else if (this.mode === 'beta-download') this.setBeta({ state: 'downloaded', version: info.version })
    })
    updater.on('update-not-available', () => {
      if (this.mode === 'stable') {
        this.setStable({ state: 'not-available' })
        if (this.interactive) this.deps.interactiveResult?.({ kind: 'up-to-date' })
        this.interactive = false
      } else if (this.mode === 'beta-check') {
        this.setBeta({ state: 'not-available' })
      }
    })
    updater.on('error', (error: Error) => {
      if (this.mode === 'stable') {
        this.setStable({ state: 'error', message: error.message })
        if (this.interactive) this.deps.interactiveResult?.({ kind: 'error', message: error.message })
        this.interactive = false
      } else if (this.mode === 'beta-check' || this.mode === 'beta-download') {
        this.setBeta({ state: 'error', message: error.message })
      }
    })
  }

  private setStable(status: UpdateStatus): void {
    this.stable = status
    this.deps.publishStable(status)
  }

  private setBeta(status: UpdateStatus): void {
    this.beta = status
    this.deps.publishBeta(status)
  }

  /** The flags a stable job needs: it downloads by itself, and prerelease builds see prereleases (until they choose to leave). */
  private forStable(): void {
    this.deps.updater.autoDownload = true
    this.deps.updater.allowPrerelease = this.onPrerelease && !this.leavingBeta
  }

  /**
   * Back to the stable release, for someone on a beta who wants out: the
   * latest stable release, not prereleases, and the move to an older version
   * an update never makes otherwise. It downloads and installs on restart like
   * any update, and shows as one. Refused on a stable build, which has nowhere
   * older to go and must never be moved backwards.
   */
  async switchToStable(): Promise<void> {
    if (!this.onPrerelease) throw new Error('This isn’t a beta build, so there is no stable version to go back to.')
    if (this.busy) throw new Error('Eaon is checking for updates right now. Try again in a moment.')
    this.leavingBeta = true
    this.deps.updater.channel = 'latest'
    this.deps.updater.allowDowngrade = true
    await this.checkStable()
  }

  /** Looks for a stable update, which then downloads by itself. */
  async checkStable(options: { interactive?: boolean } = {}): Promise<void> {
    if (this.busy) return
    this.mode = 'stable'
    this.interactive = Boolean(options.interactive)
    this.forStable()
    try {
      await this.deps.updater.checkForUpdates()
    } catch (error) {
      this.setStable({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      this.interactive = false
    } finally {
      this.mode = null
    }
  }

  /**
   * Looks for a newer beta and only says so. It never downloads: that is the
   * user's call, from `downloadBeta`. A beta build has nothing to look for
   * here; its normal check already follows betas.
   */
  async checkBeta(): Promise<void> {
    if (this.busy || this.onPrerelease) return
    if (!this.deps.betaEnabled()) return
    this.mode = 'beta-check'
    this.deps.updater.autoDownload = false
    this.deps.updater.allowPrerelease = true
    try {
      await this.deps.updater.checkForUpdates()
    } catch (error) {
      this.setBeta({ state: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.forStable()
      this.mode = null
    }
  }

  /** Downloads the beta `checkBeta` found. Installing is the existing restart-and-install. */
  async downloadBeta(): Promise<void> {
    if (this.busy || this.beta.state !== 'available') return
    // The updater holds one downloaded file; a stable update waiting for its restart would be replaced.
    if (this.stable.state === 'downloading' || this.stable.state === 'downloaded') {
      this.setBeta({ state: 'error', message: 'A stable update is already on its way. Restart to install it first, then come back for the beta.' })
      return
    }
    this.mode = 'beta-download'
    this.found = null
    this.deps.updater.autoDownload = false
    this.deps.updater.allowPrerelease = true
    this.setBeta({ state: 'downloading', percent: 0 })
    try {
      // Look again, so the updater holds the release it is about to download.
      await this.deps.updater.checkForUpdates()
      if (!this.found || !isNewerBeta(this.found, this.deps.version)) {
        // A stable release came out after the beta: that is what to install, from the stable check.
        this.setBeta({ state: 'not-available' })
        return
      }
      await this.deps.updater.downloadUpdate()
    } catch (error) {
      this.setBeta({ state: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.forStable()
      this.mode = null
    }
  }

  /** The beta option was turned off: forget what was found. */
  clearBeta(): void {
    if (this.beta.state === 'downloaded' || this.beta.state === 'downloading') return
    this.setBeta(IDLE)
  }
}
