import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Switch } from '../../ui'
import { normalizeChecks } from '@shared/projectChecks'

/**
 * Settings → General → Checks after edits: when the agent has edited files,
 * the project's typecheck or lint runs and its errors go back to the agent
 * (shared/projectChecks.ts).
 */
export function ProjectChecks(): JSX.Element {
  const stored = useApp((s) => s.settings?.general.checks)
  const patchSettings = useApp((s) => s.patchSettings)
  const checks = useMemo(() => normalizeChecks(stored), [stored])
  const [command, setCommand] = useState(checks.command)
  useEffect(() => setCommand(checks.command), [checks.command])
  const save = (next: Partial<typeof checks>): void => void patchSettings({ general: { checks: { ...checks, ...next } } })

  return (
    <Section label="Checks after edits">
      <Card>
        <Row
          title="Run the project’s checks after the agent edits files"
          description="Once a round of edits is done, Eaon runs your typecheck or lint and gives the agent what fails, so it fixes its own type and lint errors before moving on. Eaon uses the project’s own “typecheck”, “check” or “lint” script, or tsc if TypeScript is installed. It runs at most 12 times a turn."
        >
          <Switch label="Run checks after edits" checked={checks.enabled} onChange={(enabled) => save({ enabled })} />
        </Row>
        <div className="row row--stack">
          <div className="row__body">
            <div className="row__title">Command</div>
            <div className="row__desc">Leave empty to use the project’s own. It runs in the project’s folder and is stopped after 90 seconds.</div>
          </div>
          <input
            aria-label="Check command"
            className="input"
            style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 13 }}
            value={command}
            spellCheck={false}
            placeholder="npm run typecheck && npm run lint"
            onChange={(e) => setCommand(e.target.value)}
            onBlur={() => command.trim() !== checks.command && save({ command: command.trim() })}
          />
        </div>
      </Card>
    </Section>
  )
}
