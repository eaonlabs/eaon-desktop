import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Plus, Trash2 } from 'lucide-react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Select } from '../../ui'

export function ClaudeCodePage(): JSX.Element {
  const { settings, patchSettings } = useApp()
  const models = useApp(useShallow((s) => s.availableModels()))
  const [preview, setPreview] = useState<{ path: string; env: Record<string, string> } | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.api.claudeCode.preview().then(setPreview)
  }, [settings])

  if (!settings) return <></>
  const cc = settings.claudeCode

  const modelOptions = (placeholder: string): { value: string; label: string }[] =>
    models.length > 0
      ? [{ value: '', label: placeholder }, ...models.map((m) => ({ value: m.id, label: m.label }))]
      : [{ value: '', label: placeholder }]

  const apply = async (): Promise<void> => {
    try {
      const result = await window.api.claudeCode.apply()
      setPreview(result)
      setMessage({ ok: true, text: `Wrote ${Object.keys(result.env).length} variables to ${result.path}` })
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
    }
  }

  const reset = async (): Promise<void> => {
    try {
      const result = await window.api.claudeCode.reset()
      setMessage({ ok: true, text: `Removed Eaon's variables from ${result.path}` })
      setPreview(await window.api.claudeCode.preview())
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
    }
  }

  const setEnv = (env: { id: string; key: string; value: string }[]): void =>
    void patchSettings({ claudeCode: { ...cc, env } })

  return (
    <>
      <h1 className="settings__h1">Claude Code integration</h1>
      <p className="settings__lede">
        Point Claude Code at this app&rsquo;s Local API Server, so it runs against whichever provider and key you have
        configured here.
      </p>

      <Section>
        <Card>
          <Row title="Large Model" description="Opus">
            <Select
              width={210}
              value={cc.largeModelId ?? ''}
              onChange={(value) => void patchSettings({ claudeCode: { ...cc, largeModelId: value || null } })}
              options={modelOptions('Select Big Model')}
            />
          </Row>
          <Row title="Medium Model" description="Sonnet">
            <Select
              width={210}
              value={cc.mediumModelId ?? ''}
              onChange={(value) => void patchSettings({ claudeCode: { ...cc, mediumModelId: value || null } })}
              options={modelOptions('Select Medium Model')}
            />
          </Row>
          <Row title="Small Model" description="Haiku">
            <Select
              width={210}
              value={cc.smallModelId ?? ''}
              onChange={(value) => void patchSettings({ claudeCode: { ...cc, smallModelId: value || null } })}
              options={modelOptions('Select Small Model')}
            />
          </Row>

          {cc.env.map((entry, index) => (
            <div className="row" key={entry.id}>
              <input
                className="input"
                style={{ width: 190, fontFamily: 'var(--font-mono)', fontSize: 13 }}
                value={entry.key}
                placeholder="MY_VAR"
                spellCheck={false}
                onChange={(e) =>
                  setEnv(cc.env.map((v, i) => (i === index ? { ...v, key: e.target.value } : v)))
                }
              />
              <input
                className="input"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
                value={entry.value}
                placeholder="value"
                spellCheck={false}
                onChange={(e) =>
                  setEnv(cc.env.map((v, i) => (i === index ? { ...v, value: e.target.value } : v)))
                }
              />
              <div className="row__trail">
                <button
                  className="icon-btn"
                  aria-label="Remove variable"
                  onClick={() => setEnv(cc.env.filter((_, i) => i !== index))}
                >
                  <Trash2 size={15} strokeWidth={1.9} />
                </button>
              </div>
            </div>
          ))}

          <div className="row">
            <button
              className="pill-btn"
              onClick={() =>
                setEnv([...cc.env, { id: Math.random().toString(36).slice(2), key: '', value: '' }])
              }
            >
              <Plus size={14} strokeWidth={2} />
              Environment Variables
            </button>
            <div style={{ flex: 1 }} />
            <div className="row__trail">
              <button className="btn" onClick={() => void reset()}>
                Reset
              </button>
              <button className="btn btn--provider" onClick={() => void apply()}>
                Save &amp; Enable
              </button>
            </div>
          </div>
        </Card>

        {message && (
          <p
            className="settings__lede"
            style={{ marginTop: 12, color: message.ok ? 'var(--text-2)' : 'var(--danger)' }}
          >
            {message.text}
          </p>
        )}
      </Section>

      {preview && (
        <Section label="What gets written">
          <Card>
            <div className="row" style={{ display: 'block' }}>
              <div className="row__desc" style={{ marginBottom: 8 }}>
                Merged into <code>{preview.path}</code> under <code>env</code>. Your other Claude Code settings are
                preserved, and a <code>.backup</code> copy is written first.
              </div>
              <pre
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--text-2)',
                  whiteSpace: 'pre-wrap'
                }}
              >
                {Object.entries(preview.env)
                  .map(([k, v]) => `${k}=${v}`)
                  .join('\n')}
              </pre>
            </div>
          </Card>
        </Section>
      )}
    </>
  )
}
