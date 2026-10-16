import { useEffect, useState } from 'react'
import type { AuditStatus, PolicyFeature, PolicyStatus } from '@shared/enterprise'
import { Card, Row, Section } from '../../ui'

/** How each policy switch reads on this page. */
const FEATURE_LABELS: Record<PolicyFeature, string> = {
  remoteAccess: 'Remote devices',
  localApiServer: 'Local API Server',
  computerUse: 'Computer use',
  trading: 'Trading',
  payments: 'Payments',
  channels: 'Chat apps',
  email: 'Email',
  browserUse: 'Browser control',
  plugins: 'Plugins',
  scheduler: 'Scheduled tasks',
  discordPresence: 'Discord status',
  betaUpdates: 'Beta updates',
  starPrompt: 'GitHub star prompt'
}

const APPROVAL_LABELS = { ask: 'Ask before every change', auto: 'Ask before risky changes', full: 'Full autonomy' } as const

export function SecurityPage(): JSX.Element {
  const [status, setStatus] = useState<{ policy: PolicyStatus; audit: AuditStatus } | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verified, setVerified] = useState<AuditStatus['verified']>()

  useEffect(() => {
    void window.api.enterprise.status().then(setStatus)
  }, [])

  const verify = async (): Promise<void> => {
    setVerifying(true)
    try {
      setVerified((await window.api.enterprise.verifyAudit()).verified)
    } finally {
      setVerifying(false)
    }
  }

  if (!status) return <></>
  const { policy: managed, audit } = status
  const policy = managed.policy
  const off = Object.entries(policy?.features ?? {}).filter(([, on]) => on === false).map(([feature]) => FEATURE_LABELS[feature as PolicyFeature] ?? feature)

  return (
    <>
      <h1 className="settings__h1">Security</h1>

      <Section label="Organization policy">
        <Card>
          <Row
            title={managed.managed ? `Managed by ${managed.organization ?? 'your organization'}` : 'Not managed'}
            description={
              managed.managed
                ? `Settings marked below are set by your IT team and can't be changed here. Policy: ${managed.source}`
                : 'No organization policy is installed on this computer. Your IT team can deploy one; see docs/enterprise.md.'
            }
          />
          {managed.failedClosed && (
            <Row
              title="Policy couldn't be read"
              description="Remote access, the Local API Server, computer use, trading, payments and chat apps are off until your IT team fixes the policy file."
            />
          )}
          {off.length > 0 && <Row title="Turned off" description={off.join(', ')} />}
          {policy?.agent?.maxApprovalMode && (
            <Row title="Most agent autonomy allowed" description={APPROVAL_LABELS[policy.agent.maxApprovalMode]} />
          )}
          {policy?.agent?.allowFullDiskAccess === false && (
            <Row title="File access" description="Agents can only change files inside the work folder." />
          )}
          {policy?.providers?.allow && <Row title="Allowed model providers" description={policy.providers.allow.join(', ')} />}
          {policy?.providers?.deny && <Row title="Blocked model providers" description={policy.providers.deny.join(', ')} />}
          {policy?.mcp?.allowCommands && <Row title="Allowed MCP server programs" description={policy.mcp.allowCommands.join(', ')} />}
          {managed.problems.length > 0 && <Row title="Policy warnings" description={managed.problems.join(' · ')} />}
        </Card>
      </Section>

      <Section label="Audit log">
        <Card>
          <Row
            title={audit.enabled ? 'Recording' : 'Off'}
            description={
              audit.enabled
                ? `Sign-ins, key changes, security settings, server starts, and every change an agent makes are recorded here, kept for ${audit.retentionDays} days. Keys and message text are never recorded.`
                : 'Your organization has turned the audit log off.'
            }
          >
            <button className="btn btn--ghost" onClick={() => void window.api.enterprise.revealAudit()}>
              Show Folder
            </button>
          </Row>
          <Row title="Location" description={audit.directory} />
          <Row
            title="Integrity"
            description={
              verified
                ? verified.ok
                  ? `All ${verified.records} records in ${verified.files} file${verified.files === 1 ? '' : 's'} are intact.`
                  : `Integrity check failed: ${verified.problem}`
                : 'Each record is chained to the one before it, so edited or deleted records are detected.'
            }
          >
            <button className="btn" disabled={verifying} onClick={() => void verify()}>
              {verifying ? 'Checking…' : 'Verify'}
            </button>
          </Row>
        </Card>
      </Section>
    </>
  )
}
