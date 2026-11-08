import { useMemo } from 'react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Switch } from '../../ui'
import { normalizeSandbox } from '@shared/sandbox'
import { isMac } from '../../../lib/platform'

/**
 * Settings → General → Command sandbox: the agent's shell commands run inside
 * macOS's Seatbelt, so they write only in the work folder, can't read keys,
 * and reach the internet only when allowed (shared/sandbox.ts).
 */
export function CommandSandbox(): JSX.Element {
  const stored = useApp((s) => s.settings?.general.sandbox)
  const patchSettings = useApp((s) => s.patchSettings)
  const sandbox = useMemo(() => normalizeSandbox(stored), [stored])
  const save = (next: Partial<typeof sandbox>): void => void patchSettings({ general: { sandbox: { ...sandbox, ...next } } })
  return (
    <Section label="Command sandbox">
      <Card>
        <Row
          title="Run the agent’s commands in a sandbox"
          description={
            isMac
              ? 'Commands can read your files but write only in the work folder, the temp folders and the usual tool caches (npm, cargo, pip). They can’t read your keys (~/.ssh, ~/.aws and the like), and can’t delete or change anything else. Dev servers on this computer still work. It covers commands the agent runs, not what you run yourself in a terminal.'
              : 'Only on macOS for now: elsewhere this switch can’t protect anything, so commands are refused while it is on.'
          }
        >
          <Switch label="Run commands in a sandbox" checked={sandbox.enabled} disabled={!isMac && !sandbox.enabled} onChange={(enabled) => save({ enabled })} />
        </Row>
        {sandbox.enabled && (
          <Row title="Let commands use the internet" description="Off: a command can’t reach any other computer, so npm install and git fetch fail until you turn this on. On: the network is open, and the sandbox still keeps writes and keys as above.">
            <Switch label="Let sandboxed commands use the internet" checked={sandbox.network} onChange={(network) => save({ network })} />
          </Row>
        )}
      </Card>
    </Section>
  )
}
