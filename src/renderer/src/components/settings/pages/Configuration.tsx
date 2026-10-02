import { useState } from 'react'
import { ArrowUpRight, Download, Search } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useIsWork } from '../../../state/store'
import { Card, Row, Section, Select, Switch } from '../../ui'

export function ConfigurationPage(): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const isWork = useIsWork()
  const [diagnosing, setDiagnosing] = useState(false)

  if (!settings) return <></>
  const c = settings.configuration

  return (
    <>
      <h1 className="settings__h1">Configuration</h1>
      <p className="settings__lede">Configure permissions, web access, and agent responses for new chats.</p>

      <Section label="Agent defaults">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <Select
            value={c.configScope}
            onChange={(configScope) => void patchSettings({ configuration: { configScope } })}
            options={[
              { value: 'User config', label: 'User config' },
              { value: 'Project config', label: 'Project config' },
              { value: 'Workspace config', label: 'Workspace config' }
            ]}
          />
          <div style={{ flex: 1 }} />
          <button className="btn btn--ghost btn--sm">
            Open config.toml
            <ArrowUpRight size={14} strokeWidth={1.9} />
          </button>
        </div>
        <Card>
          {/* Approval policy and Sandbox settings govern the local file/command
              tools, which only run in Eaon Work. */}
          {isWork && (
          <>
          <Row title="Approval policy" description="Choose when the assistant asks for approval">
            <Select
              value={c.approvalPolicy}
              onChange={(approvalPolicy) => void patchSettings({ configuration: { approvalPolicy } })}
              options={[
                { value: 'On request', label: 'On request' },
                { value: 'On failure', label: 'On failure' },
                { value: 'Never', label: 'Never' },
                { value: 'Untrusted', label: 'Untrusted' }
              ]}
            />
          </Row>
          <Row title="Sandbox settings" description="Choose how much the assistant can do when running commands">
            <Select
              value={c.sandbox}
              onChange={(sandbox) => void patchSettings({ configuration: { sandbox } })}
              options={[
                { value: 'Read only', label: 'Read only' },
                { value: 'Workspace write', label: 'Workspace write' },
                { value: 'Danger full access', label: 'Danger full access' }
              ]}
            />
          </Row>
          </>
          )}
          <Row
            title="Web search"
            description="Let the model search the web when an answer needs current information. Snippets returns search-result text only; Full pages also scrapes the pages it finds, which is slower but more thorough."
          >
            <Select
              value={c.webSearch}
              onChange={(webSearch) => void patchSettings({ configuration: { webSearch } })}
              options={[
                { value: 'Cached', label: 'Snippets' },
                { value: 'Live', label: 'Full pages' },
                { value: 'Off', label: 'Off' }
              ]}
            />
          </Row>
          <Row title="Output detail" description="Choose how much detail the assistant includes in responses">
            <Select
              value={c.outputDetail}
              onChange={(outputDetail) => void patchSettings({ configuration: { outputDetail } })}
              options={[
                { value: 'Model default', label: 'Model default' },
                { value: 'Concise', label: 'Concise' },
                { value: 'Detailed', label: 'Detailed' }
              ]}
            />
          </Row>
          <Row title="Reasoning summary" description="Choose how the assistant summarizes its reasoning">
            <Select
              value={c.reasoningSummary}
              onChange={(reasoningSummary) => void patchSettings({ configuration: { reasoningSummary } })}
              options={[
                { value: 'Auto', label: 'Auto' },
                { value: 'Concise', label: 'Concise' },
                { value: 'Detailed', label: 'Detailed' },
                { value: 'None', label: 'None' }
              ]}
            />
          </Row>
        </Card>
      </Section>

      {isWork && (
      <Section label="Workspace Dependencies">
        <Card>
          <Row
            title="Workspace dependencies"
            description="Allow the assistant to install and expose bundled Node.js and Python tools"
          >
            <Switch
              label="Workspace dependencies"
              checked={c.workspaceDependencies}
              onChange={(on) => void patchSettings({ configuration: { workspaceDependencies: on } })}
            />
          </Row>
          <Row title="Diagnose issues in Workspace" description="Checks the current bundle and records diagnostic logs">
            <button
              className="btn"
              disabled={diagnosing}
              onClick={() => {
                setDiagnosing(true)
                setTimeout(() => setDiagnosing(false), 1200)
              }}
            >
              <Search size={14} strokeWidth={1.9} />
              {diagnosing ? 'Checking…' : 'Diagnose'}
            </button>
          </Row>
          <Row title="Reset and install Workspace" description="Downloads a fresh bundle, installs it, and reloads tools">
            <button className="btn btn--danger">
              <Download size={14} strokeWidth={1.9} />
              Reinstall
            </button>
          </Row>
        </Card>
        <div className="kv">Current version: 26.819.11345</div>
      </Section>
      )}
    </>
  )
}
