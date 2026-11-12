import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'

/**
 * How agents run commands in a VM: SSH, with a key made for that VM alone.
 * On a Mac the VM's SSH is reached through a Unix socket the helper bridges
 * to the guest over vsock (no network, no Local Network permission); under
 * QEMU through a port forwarded on 127.0.0.1. Either way it's the system's
 * own `ssh`, which every Mac and nearly every Linux computer has.
 */

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const sshString = (data: Buffer | string): Buffer => {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return Buffer.concat([u32(bytes.length), bytes])
}

export interface SshKeyPair {
  /** OpenSSH's own private key format, which `ssh -i` reads. */
  privateKey: string
  /** One line for authorized_keys. */
  publicKey: string
}

/** A new Ed25519 key, written the way ssh-keygen writes one (unencrypted: it lives in the VM's own folder, readable only by this user). */
export function newSshKey(comment: string): SshKeyPair {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string }
  const seed = Buffer.from(jwk.d, 'base64url')
  const pub = Buffer.from(jwk.x, 'base64url')
  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)])
  const check = randomBytes(4)
  let secret = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)])
  // Padded to the cipher's block size (8 for "none") with 1, 2, 3...
  const pad = (8 - (secret.length % 8)) % 8
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))])
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sshString('none'), sshString('none'), sshString(''), u32(1), sshString(publicBlob), sshString(secret)])
  const lines = body.toString('base64').match(/.{1,70}/g) ?? []
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${publicBlob.toString('base64')} ${comment}`
  }
}

/** Where a VM's SSH is: a socket the helper bridges, or a port on this computer. */
export type SshRoute = { socket: string } | { port: number }

export interface SshTarget {
  route: SshRoute
  user: string
  keyFile: string
  knownHosts: string
}

/** Wraps a command for the remote shell: run by bash as a login shell, so PATH and profile apply. */
export const remoteCommand = (command: string): string => `bash -lc ${shellQuote(command)}`
export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

function sshArgs(target: SshTarget, connectTimeout = 5): string[] {
  const route = 'socket' in target.route ? ['-o', `ProxyCommand=nc -U ${shellQuote(target.route.socket)}`] : ['-p', String(target.route.port)]
  return [
    ...route,
    '-i',
    target.keyFile,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${connectTimeout}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${target.knownHosts}`,
    '-o',
    'LogLevel=ERROR',
    `${target.user}@${'socket' in target.route ? 'vm' : '127.0.0.1'}`
  ]
}

export interface ExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const OUTPUT_CAP = 200_000

/** Runs `command` in the VM and collects what it prints (the end of it, past a cap). */
export function sshExec(target: SshTarget, command: string, options: { timeoutMs?: number; input?: string | Buffer; signal?: AbortSignal; connectTimeout?: number } = {}): Promise<ExecResult> {
  if (!existsSync(target.keyFile)) return Promise.reject(new Error('This VM’s SSH key is missing.'))
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs(target, options.connectTimeout), remoteCommand(command)], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLength = 0
    let errLength = 0
    let timedOut = false
    const keep = (list: Buffer[], chunk: Buffer, length: number): number => {
      list.push(chunk)
      length += chunk.length
      while (length > OUTPUT_CAP && list.length > 1) length -= list.shift()!.length
      return length
    }
    child.stdout.on('data', (chunk: Buffer) => (outLength = keep(out, chunk, outLength)))
    child.stderr.on('data', (chunk: Buffer) => (errLength = keep(err, chunk, errLength)))
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)
      : null
    const abort = (): void => {
      child.kill('SIGKILL')
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('This computer has no `ssh` command, which running commands in a VM needs.') : error)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolve({ exitCode: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut })
    })
    child.stdin.end(options.input ?? '')
  })
}

/** Whether the VM's SSH answers at all (exit 255 is ssh's own failure). */
export async function sshAnswers(target: SshTarget): Promise<boolean> {
  const result = await sshExec(target, 'true', { timeoutMs: 8000, connectTimeout: 3 }).catch(() => null)
  return result !== null && result.exitCode === 0
}
