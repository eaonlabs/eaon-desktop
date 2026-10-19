import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostInstallProgress, SshInstallRequest } from '@shared/workerHost'

/**
 * Putting the host app on a worker computer, two ways:
 *
 * - Over SSH: the desktop logs in as the user (their keys, or a password
 *   handed to ssh through SSH_ASKPASS and never written anywhere but a
 *   private temporary script's environment), streams the package, the link
 *   secret and the password for sudo on stdin, and runs install.sh. Nothing
 *   secret is on a command line, where `ps` would show it.
 * - With one command typed on the other computer: the desktop serves an
 *   install script and the package on the local network under a one-time
 *   code for half an hour; the script installs, then tells the desktop where
 *   it is listening.
 *
 * install.sh (src/host/install.sh) prints "EAON:" progress lines, then
 * "EAON_HOST_READY <port> <platform> <arch> <runtime>" or "EAON_ERROR: …".
 */

export interface InstallResult {
  port: number
  platform: string
  arch: string
  runtime: 'electron' | 'node'
}

/** Reads install.sh's output as it comes, line by line. */
export function installOutput(onProgress: (progress: HostInstallProgress) => void): {
  push: (chunk: string) => void
  result: () => InstallResult | null
  error: () => string | null
} {
  let buffer = ''
  let result: InstallResult | null = null
  let error: string | null = null
  const line = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (trimmed.startsWith('EAON_HOST_READY ')) {
      const [, port, platform, arch, runtime] = trimmed.split(/\s+/)
      result = { port: Number(port), platform: platform ?? '', arch: arch ?? '', runtime: runtime === 'electron' ? 'electron' : 'node' }
    } else if (trimmed.startsWith('EAON_ERROR:')) {
      error = trimmed.slice('EAON_ERROR:'.length).trim()
      onProgress({ line: error, error })
    } else if (trimmed.startsWith('EAON:')) {
      onProgress({ line: trimmed.slice('EAON:'.length).trim() })
    }
  }
  return {
    push: (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) line(l)
    },
    result: () => {
      if (buffer) line(buffer)
      buffer = ''
      return result
    },
    error: () => error
  }
}

/** What went wrong with ssh, for a person. */
export function sshProblem(stderr: string, code: number | null): string {
  if (/Permission denied|Authentication failed|Too many authentication failures/i.test(stderr)) {
    return 'SSH couldn’t sign in. Check the user name and password, or that your SSH key is allowed on that computer.'
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(stderr)) return 'That computer’s name couldn’t be found on the network.'
  if (/Connection refused/i.test(stderr)) return 'That computer refused SSH. Turn on SSH there (on a Raspberry Pi: sudo raspi-config → Interface Options → SSH).'
  if (/timed out|No route to host|Network is unreachable/i.test(stderr)) return 'That computer can’t be reached. Is it on, and on this network?'
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'That computer’s SSH identity has changed since you last connected. If you reinstalled it, remove its old entry from ~/.ssh/known_hosts first.'
  const last = stderr.trim().split('\n').filter(Boolean).pop()
  return last ? `SSH failed: ${last}` : `SSH failed (exit code ${code ?? 'unknown'}).`
}

export interface SshInstallOptions {
  request: SshInstallRequest
  /** out/host/eaon-host.tgz */
  packagePath: string
  secret: string
  port: number
  onProgress: (progress: HostInstallProgress) => void
  /**
   * Eaon's own record of the computers it has linked, so ssh pins each one's
   * identity the first time without touching the user's ~/.ssh/known_hosts.
   */
  knownHostsFile?: string
  /** For tests: the ssh binary and extra options. */
  ssh?: string
  extraOptions?: string[]
  signal?: AbortSignal
}

/** Single quotes for sh. */
const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The command the computer runs: read the secret and password, take the
 * package, install. Wrapped in `sh -c` so it means the same whatever the
 * account's login shell is.
 */
export function remoteInstallCommand(name: string | undefined): string {
  const script = [
    'set -e',
    'IFS= read -r EAON_HOST_SECRET',
    'IFS= read -r EAON_SUDO_PASS',
    'export EAON_HOST_SECRET EAON_SUDO_PASS',
    'D=$(mktemp -d)',
    'cat > "$D/eaon-host.tgz"',
    'tar -xzf "$D/eaon-host.tgz" -C "$D" 2>/dev/null',
    'set +e',
    `EAON_HOST_NAME=${sq(name ?? '')} sh "$D/eaon-host/install.sh"`,
    'S=$?',
    'cd / && rm -rf "${D:?}"',
    'exit $S'
  ].join('; ')
  return `sh -c ${sq(script)}`
}

export function installOverSsh(options: SshInstallOptions): Promise<InstallResult> {
  const { request } = options
  const host = request.host.trim()
  const user = request.user.trim()
  if (!host || /[\s'"`$;&|<>]/.test(host)) return Promise.reject(new Error('Enter the computer’s address, like raspberrypi.local or 192.168.1.20.'))
  if (!user || /[\s'"`$;&|<>@]/.test(user)) return Promise.reject(new Error('Enter the user name you sign in to that computer with.'))
  const sshPort = request.port && Number.isInteger(request.port) ? request.port : 22

  const args = [
    '-p',
    String(sshPort),
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    ...(options.knownHostsFile ? ['-o', `UserKnownHostsFile=${options.knownHostsFile}`] : []),
    ...(options.extraOptions ?? [])
  ]
  if (request.keyFile) args.push('-i', request.keyFile, '-o', 'IdentitiesOnly=yes')
  let askpassDir: string | null = null
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (request.password) {
    // ssh asks the askpass program; the password reaches it only through its environment.
    askpassDir = mkdtempSync(join(tmpdir(), 'eaon-ssh-'))
    const askpass = join(askpassDir, 'askpass.sh')
    writeFileSync(askpass, '#!/bin/sh\nprintf "%s\\n" "$EAON_SSH_PASSWORD"\n', { mode: 0o700 })
    Object.assign(env, { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: env.DISPLAY || ':0', EAON_SSH_PASSWORD: request.password })
    args.push('-o', 'NumberOfPasswordPrompts=1')
  } else {
    args.push('-o', 'BatchMode=yes')
  }
  args.push(`${user}@${host}`, remoteInstallCommand(request.name))

  return new Promise<InstallResult>((resolve, reject) => {
    const output = installOutput(options.onProgress)
    let stderr = ''
    const child = spawn(options.ssh ?? 'ssh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const cleanup = (): void => {
      if (askpassDir) rmSync(askpassDir, { recursive: true, force: true })
      askpassDir = null
    }
    const abort = (): void => {
      child.kill()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => output.push(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000)
    })
    child.on('error', (error) => {
      cleanup()
      reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'This computer has no ssh command.' : error.message))
    })
    child.on('close', (code) => {
      cleanup()
      options.signal?.removeEventListener('abort', abort)
      const result = output.result()
      if (result) return resolve(result)
      if (options.signal?.aborted) return reject(new Error('Cancelled.'))
      reject(new Error(output.error() ?? sshProblem(stderr, code)))
    })
    options.onProgress({ line: `Connecting to ${user}@${host}` })
    child.stdin.on('error', () => undefined)
    child.stdin.write(`${options.secret}\n${request.password ?? ''}\n`)
    const pkg = createReadStream(options.packagePath)
    pkg.on('error', (error) => {
      child.kill()
      reject(error)
    })
    pkg.once('open', () => options.onProgress({ line: `Sending the host app (${(statSync(options.packagePath).size / 1e6).toFixed(1)} MB)` }))
    pkg.pipe(child.stdin)
  })
}

/* ------------------------------------------------------ the one command */

export interface PairingServerOptions {
  packagePath: string
  /** Where the other computer reaches this one. */
  address: string
  secret: string
  hostPort: number
  /** How the install script describes where it came from. */
  computerName: string
  onProgress: (progress: HostInstallProgress) => void
  /** The other computer finished installing: where it is and what it runs. */
  onDone: (done: InstallResult & { address: string; name: string }) => void
  ttlMs?: number
  port?: number
  /** Where to listen; every interface unless told otherwise (tests use loopback). */
  bind?: string
}

export interface PairingServer {
  code: string
  url: string
  command: string
  expiresAt: number
  close: () => Promise<void>
}

/** The script the other computer pipes into sh. */
export function pairingScript(base: string, secret: string, hostPort: number, from: string): string {
  return `#!/bin/sh
# Eaon worker host, from ${from.replace(/[^\w .'()-]/g, '')}
set -e
U=${sq(base)}
D=$(mktemp -d)
get() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -q -O "$2" "$1"; fi; }
post() { if command -v curl >/dev/null 2>&1; then curl -fsS -X POST --data-binary "$2" "$1" >/dev/null; else wget -q -O /dev/null --post-data="$2" "$1"; fi; }
echo "Downloading the Eaon worker host…"
get "$U/package" "$D/eaon-host.tgz"
tar -xzf "$D/eaon-host.tgz" -C "$D" 2>/dev/null
set +e
EAON_HOST_PORT=${hostPort} EAON_HOST_SECRET=${sq(secret)} sh "$D/eaon-host/install.sh" | tee "$D/install.log"
R=$(grep '^EAON_HOST_READY' "$D/install.log" | tail -n 1)
E=$(grep '^EAON_ERROR' "$D/install.log" | tail -n 1)
if [ -n "$R" ]; then
  post "$U/done" "$R $(hostname)"
  echo "Done. This computer now runs your workers when you turn that on in Eaon."
else
  post "$U/failed" "$E"
  echo "The install didn't finish. See the lines above."
fi
cd / && rm -rf "\${D:?}"
`
}

export function startPairingServer(options: PairingServerOptions): Promise<PairingServer> {
  const code = randomBytes(9).toString('base64url')
  const ttl = options.ttlMs ?? 30 * 60_000
  const expiresAt = Date.now() + ttl
  let done = false

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: string, type = 'text/plain; charset=utf-8'): void => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      response.end(body)
    }
    const prefix = `/eaon-host/${code}`
    const path = (request.url ?? '').split('?')[0]
    if (Date.now() > expiresAt || done || !path.startsWith(prefix)) return send(404, 'Not found\n')
    const rest = path.slice(prefix.length)
    if (request.method === 'GET' && (rest === '' || rest === '/' || rest === '/install.sh')) {
      options.onProgress({ line: `${(request.socket.remoteAddress ?? 'A computer').replace(/^::ffff:/, '')} is installing the host app` })
      return send(200, pairingScript(`http://${urlHost(options.address)}:${(server.address() as { port: number }).port}${prefix}`, options.secret, options.hostPort, options.computerName))
    }
    if (request.method === 'GET' && rest === '/package') {
      response.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': statSync(options.packagePath).size, 'Cache-Control': 'no-store' })
      createReadStream(options.packagePath).pipe(response)
      return
    }
    if (request.method === 'POST' && (rest === '/done' || rest === '/failed')) {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk
      })
      request.on('end', () => {
        send(200, 'ok\n')
        if (rest === '/failed') {
          const error = body.replace(/^EAON_ERROR:\s*/, '').trim() || 'The install on the other computer didn’t finish.'
          options.onProgress({ line: error, error })
          return
        }
        const [ready, port, platform, arch, runtime, ...name] = body.trim().split(/\s+/)
        if (ready !== 'EAON_HOST_READY' || !Number(port)) return
        done = true
        const address = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
        options.onDone({ port: Number(port), platform: platform ?? '', arch: arch ?? '', runtime: runtime === 'electron' ? 'electron' : 'node', address, name: name.join(' ') })
      })
      return
    }
    send(404, 'Not found\n')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.bind ?? '0.0.0.0', () => {
      server.off('error', reject)
      const port = (server.address() as { port: number }).port
      const url = `http://${urlHost(options.address)}:${port}/eaon-host/${code}`
      const timer = setTimeout(() => server.close(), ttl)
      timer.unref?.()
      resolve({
        code,
        url,
        command: `curl -fsSL ${url} | sh`,
        expiresAt,
        close: () =>
          new Promise<void>((r) => {
            clearTimeout(timer)
            server.closeAllConnections?.()
            server.close(() => r())
          })
      })
    })
  })
}

const urlHost = (address: string): string => (address.includes(':') && !address.startsWith('[') ? `[${address}]` : address)
