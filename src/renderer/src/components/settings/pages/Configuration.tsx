import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Select } from '../../ui'

/**
 * Agent settings that apply to every chat. Only web search lives here now:
 * config scope, approval policy, sandbox, output detail, reasoning summary,
 * workspace dependencies, "Open config.toml", "Diagnose" (a 1.2 s fake
 * spinner) and "Reinstall" were copied from another app's settings and
 * nothing in Eaon ever read or ran them. Approvals are set in the message
 * box's + menu; Full access is in General.
 */
export function ConfigurationPage(): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))

  if (!settings) return <></>
  const c = settings.configuration

  return (
    <>
      <h1 className="settings__h1">Configuration</h1>
      <p className="settings__lede">How the assistant gets current information in every chat.</p>

      <Section label="Web">
        <Card>
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
        </Card>
      </Section>
    </>
  )
}
