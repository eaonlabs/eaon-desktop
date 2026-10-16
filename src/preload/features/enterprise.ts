import { ipcRenderer } from 'electron'
import type { AuditStatus, PolicyStatus } from '@shared/enterprise'

/**
 * Renderer bridge for Settings → Security: the organization's policy and the
 * audit log. Exposed as `window.api.enterprise`. Read-only by design.
 */
export const enterpriseApi = {
  /** The policy in force (if any) and where the audit log is written. */
  status: (): Promise<{ policy: PolicyStatus; audit: AuditStatus }> => ipcRenderer.invoke('enterprise:status'),
  /** Checks every record's hash chain; the answer says where it breaks, if it does. */
  verifyAudit: (): Promise<AuditStatus> => ipcRenderer.invoke('enterprise:verify-audit'),
  /** Opens the audit log's folder. */
  revealAudit: (): Promise<void> => ipcRenderer.invoke('enterprise:reveal-audit')
}
