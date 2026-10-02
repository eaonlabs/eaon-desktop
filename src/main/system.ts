import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SystemInfo } from '@shared/types'

const run = promisify(execFile)

/**
 * Live hardware and OS stats for the System Monitor page.
 *
 * CPU usage is a *delta* between two samples rather than an absolute reading:
 * os.cpus() reports cumulative tick counts since boot, so a single sample only
 * tells you the average since power-on. We keep the previous sample and diff.
 */

interface CpuSample {
  idle: number
  total: number
}

function sampleCpu(): CpuSample {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total }
}

let previous: CpuSample | null = null

function cpuUsagePercent(): number {
  const current = sampleCpu()
  if (!previous) {
    previous = current
    // No baseline yet — fall back to load average over core count, which is a
    // reasonable first reading rather than a misleading 0%.
    const load = os.loadavg()[0] / os.cpus().length
    return Math.min(100, Math.max(0, load * 100))
  }
  const idleDelta = current.idle - previous.idle
  const totalDelta = current.total - previous.total
  previous = current
  if (totalDelta <= 0) return 0
  return Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100))
}

/** macOS reports a marketing name we can prettify; other platforms use the raw type. */
function osName(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    default:
      return os.type()
  }
}

// os.release() returns the Darwin kernel version (e.g. 25.6.0), not the macOS
// version users recognise (26.6.2). sw_vers is the accurate source; cache it
// since the OS version cannot change while the app is running. Asked
// asynchronously: a synchronous spawn stalls every IPC call and stream.
let cachedVersion: Promise<string> | null = null

function osVersion(): Promise<string> {
  cachedVersion ??= (async () => {
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await run('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5000 })
        return `macOS ${stdout.trim()}`
      } catch {
        /* fall through to the kernel release below */
      }
    }
    return os.release()
  })()
  return cachedVersion
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const version = await osVersion()
  const cpus = os.cpus()
  const totalBytes = os.totalmem()
  const availableBytes = os.freemem()

  return {
    os: {
      name: osName(),
      version
    },
    cpu: {
      model: cpus[0]?.model?.trim() ?? 'Unknown',
      architecture: process.arch,
      cores: cpus.length,
      usagePercent: cpuUsagePercent()
    },
    memory: {
      totalBytes,
      availableBytes,
      usagePercent: totalBytes > 0 ? ((totalBytes - availableBytes) / totalBytes) * 100 : 0
    }
  }
}
