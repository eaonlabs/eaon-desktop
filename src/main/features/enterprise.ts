import { shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import type { AuditStatus, PolicyFeature, PolicyStatus } from '@shared/enterprise'
import { audit, auditDirectory, auditStatus, verifyAuditLog } from '../enterprise/audit'
import { getPolicyStatus } from '../enterprise/policy'
import type { Feature } from './types'

/**
 * Settings → Security: what the organization's policy locks, and the audit
 * log (enterprise/). Read-only from the renderer: nothing here can loosen a
 * policy or edit the log.
 */

/** Feature modules a policy can keep from starting, by the policy's name for them. */
export const POLICY_GATED_FEATURES: Record<string, PolicyFeature> = {
  remote: 'remoteAccess',
  trading: 'trading',
  payments: 'payments',
  channels: 'channels',
  email: 'email',
  scheduler: 'scheduler',
  'discord-presence': 'discordPresence',
  'browser-use': 'browserUse'
}

export const enterpriseFeature: Feature = {
  id: 'enterprise',
  register: ({ ipcMain }) => {
    const status = getPolicyStatus()
    audit(
      'policy.loaded',
      { managed: status.managed, source: status.source, organization: status.organization, failedClosed: status.failedClosed, problems: status.problems },
      { via: 'system', outcome: status.failedClosed ? 'failure' : 'success' }
    )

    ipcMain.handle('enterprise:status', (): { policy: PolicyStatus; audit: AuditStatus } => ({
      policy: getPolicyStatus(),
      audit: auditStatus()
    }))
    ipcMain.handle('enterprise:verify-audit', (): AuditStatus => {
      const verified = verifyAuditLog()
      audit('audit.verified', { ok: verified.ok, records: verified.records, problem: verified.problem }, { outcome: verified.ok ? 'success' : 'failure' })
      return { ...auditStatus(), verified }
    })
    ipcMain.handle('enterprise:reveal-audit', async (): Promise<void> => {
      const dir = auditDirectory()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      await shell.openPath(dir)
    })
  }
}
