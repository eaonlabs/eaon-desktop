import { spawn, type ChildProcess } from 'node:child_process'
import { REMOTE_BONJOUR_TYPE } from '@shared/remote'

/**
 * Lets the phone find this Mac without typing an address: a Bonjour service,
 * `_eaon._tcp`, named "Eaon (<computer name>)", with `v=1`, the Mac's `.local`
 * name and the port in its TXT record (the phone reads host and port from it
 * rather than resolving the endpoint). The key is never part of it.
 *
 * macOS only, and by running `dns-sd` rather than adding a dependency: the
 * system's mDNSResponder does the announcing for as long as the child lives,
 * so stopping it (turning remote devices off, quitting) is killing the child.
 * Nothing here may get in the way of the server, so every failure is silent;
 * at worst the phone is paired by the QR code, as it is anyway.
 */

export interface Advert {
  computerName: string
  /** The Mac's name on the network, with or without ".local". */
  hostName: string
  port: number
}

export interface BonjourOptions {
  platform?: NodeJS.Platform
  spawn?: typeof spawn
}

/** A service instance name is 63 bytes at most. */
const MAX_INSTANCE_BYTES = 63

/** "Eaon (Alex's MacBook Pro)", shortened from the computer name's end until it fits. */
export function instanceName(computerName: string): string {
  let name = computerName.replace(/[\u0000-\u001f]/g, ' ').trim() || 'Mac'
  while (name.length > 1 && Buffer.byteLength(`Eaon (${name})`) > MAX_INSTANCE_BYTES) name = name.slice(0, -1).trimEnd()
  return `Eaon (${name})`
}

export const bonjourArgs = ({ computerName, hostName, port }: Advert): string[] => [
  '-R',
  instanceName(computerName),
  REMOTE_BONJOUR_TYPE,
  'local',
  String(port),
  'v=1',
  `host=${hostName.replace(/\.local\.?$/i, '')}.local`,
  `port=${port}`
]

export class Bonjour {
  private child: ChildProcess | null = null
  private advertised = ''

  constructor(private readonly options: BonjourOptions = {}) {}

  get running(): boolean {
    return this.child !== null
  }

  start(advert: Advert): void {
    if ((this.options.platform ?? process.platform) !== 'darwin') return
    const args = bonjourArgs(advert)
    const key = args.join('\u0000')
    if (this.child && this.advertised === key) return
    this.stop()
    try {
      const child = (this.options.spawn ?? spawn)('dns-sd', args, { stdio: 'ignore' })
      // Missing binary, no permission, mDNSResponder not running: not worth a word.
      child.on('error', () => {
        if (this.child === child) this.child = null
      })
      child.on('exit', () => {
        if (this.child === child) this.child = null
      })
      this.child = child
      this.advertised = key
    } catch {
      this.child = null
    }
  }

  stop(): void {
    const child = this.child
    this.child = null
    this.advertised = ''
    if (!child) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}
