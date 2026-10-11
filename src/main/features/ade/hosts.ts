import { randomUUID } from 'node:crypto'
import type { ManualHostInput, SshHost } from '@shared/adeRemote'
import { hostFromManualInput, readSshConfig } from './ssh'

/**
 * The SSH hosts a remote session can be on: every `Host` in ~/.ssh/config
 * (read fresh each time, so an edit there shows up), then the ones added in
 * Eaon, kept in `ade-ssh-hosts.json`. Connection descriptors only, never a
 * password or a key.
 */

export interface HostStoreDeps {
  load: () => unknown
  save: (hosts: SshHost[]) => void
  readConfig?: () => Promise<SshHost[]>
}

export class HostBook {
  constructor(private readonly deps: HostStoreDeps) {}

  private manual(): SshHost[] {
    const raw = this.deps.load()
    return (Array.isArray(raw) ? raw : []).filter(
      (h): h is SshHost => Boolean(h) && typeof h.id === 'string' && typeof h.hostname === 'string' && h.source === 'manual'
    )
  }

  async list(): Promise<SshHost[]> {
    const config = await (this.deps.readConfig ?? (() => readSshConfig()))()
    return [...config, ...this.manual()]
  }

  async find(id: string): Promise<SshHost | null> {
    return (await this.list()).find((h) => h.id === id) ?? null
  }

  add(input: ManualHostInput): SshHost {
    const host = hostFromManualInput(input, `manual:${randomUUID()}`)
    this.deps.save([...this.manual(), host])
    return host
  }

  remove(id: string): void {
    this.deps.save(this.manual().filter((h) => h.id !== id))
  }
}
