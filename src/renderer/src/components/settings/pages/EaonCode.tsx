import { useEffect, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Download, ExternalLink, FolderSearch, RefreshCw, RotateCcw } from 'lucide-react'
import { useApp } from '../../../state/store'
import { useCode } from '../../code/codeStore'
import { Card, Row, Section, Switch } from '../../ui'
import { EAON_CODE_PACKAGE, EAON_CODE_REPO } from '@shared/eaonCode'

const SOURCE: Record<string, string> = {
  setting: 'set below',
  path: 'found on PATH',
  'npm-prefix': "found in npm's global folder"
}

/** Settings → Eaon Code: where the binary is, keeping it installed, and key sharing. */
export function EaonCodePage(): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const { status, checking, refreshStatus } = useCode(
    useShallow((s) => ({ status: s.status, checking: s.checking, refreshStatus: s.refreshStatus }))
  )
  const [shared, setShared] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [draftPath, setDraftPath] = useState(settings?.eaonCode.binaryPath ?? '')

  useEffect(() => {
    void refreshStatus(false)
  }, [refreshStatus])
  useEffect(() => {
    void window.api.eaonCode.sharedKeys().then(setShared)
  }, [settings?.eaonCode.shareKeys])

  if (!settings) return <></>
  const config = settings.eaonCode

  const setBinaryPath = async (binaryPath: string | null): Promise<void> => {
    await patchSettings({ eaonCode: { ...config, binaryPath } })
    setDraftPath(binaryPath ?? '')
    const next = await refreshStatus(true)
    setMessage(next.state === 'ready' ? { ok: true, text: `Using Eaon Code ${next.version}.` } : { ok: false, text: next.error ?? 'Eaon Code was not found.' })
  }

  const install = async (): Promise<void> => {
    setInstalling(true)
    setMessage(null)
    const result = await window.api.eaonCode.install()
    setInstalling(false)
    if (result.ok) {
      useCode.setState({ status: result.data })
      setMessage({ ok: true, text: `Installed Eaon Code ${result.data.version ?? ''}. New Eaon Code terminals use it; a running one keeps its version until restarted.` })
    } else {
      setMessage({ ok: false, text: result.error })
      await refreshStatus(true)
    }
  }

  const statusText = !status
    ? 'Checking…'
    : status.state === 'ready'
      ? `Version ${status.version} · ${SOURCE[status.source ?? ''] ?? ''}`
      : status.state === 'broken'
        ? (status.error ?? 'Found, but it would not run.')
        : 'Not installed'

  return (
    <>
      <h1 className="settings__h1">Eaon Code</h1>
      <p className="settings__lede">
        Eaon Code is Eaon&rsquo;s coding agent. In the ADE, choose <strong>New terminal → Eaon Code</strong> to run it
        in your project folder, next to Claude Code, Codex or a plain shell.
      </p>

      <Section label="Installation">
        <Card>
          <Row title="Eaon Code" description={statusText}>
            <button className="btn btn--ghost" disabled={checking} onClick={() => void refreshStatus(true)}>
              <RefreshCw size={14} strokeWidth={1.9} className={checking ? 'spinner' : undefined} />
              Check
            </button>
            <button className="btn" disabled={installing || !status?.node.ok} onClick={() => void install()}>
              <Download size={14} strokeWidth={1.9} className={installing ? 'spinner' : undefined} />
              {installing ? 'Installing…' : status?.state === 'ready' ? 'Update' : 'Install'}
            </button>
          </Row>
          <Row
            title="Node.js"
            description={
              status
                ? status.node.version
                  ? `${status.node.version}${status.node.path ? ` at ${status.node.path}` : ''} · needs ${status.nodeRequirement}${status.node.ok ? '' : ' — too old'}`
                  : `Not on your PATH · needs ${status.nodeRequirement}`
                : 'Checking…'
            }
          />
          <Row title="Binary path" description={status?.binaryPath ?? 'Leave empty to find eaon-code on your PATH.'}>
            <input
              className="input code-settings__path"
              value={draftPath}
              placeholder="Auto-detect"
              spellCheck={false}
              onChange={(e) => setDraftPath(e.target.value)}
              onBlur={() => draftPath.trim() !== (config.binaryPath ?? '') && void setBinaryPath(draftPath.trim() || null)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <button
              className="icon-btn"
              aria-label="Browse for eaon-code"
              title="Browse…"
              onClick={async () => {
                const path = await window.api.eaonCode.pickBinary()
                if (path) void setBinaryPath(path)
              }}
            >
              <FolderSearch size={15} strokeWidth={1.9} />
            </button>
            {config.binaryPath && (
              <button className="icon-btn" aria-label="Auto-detect" title="Auto-detect" onClick={() => void setBinaryPath(null)}>
                <RotateCcw size={15} strokeWidth={1.9} />
              </button>
            )}
          </Row>
        </Card>
        {message && (
          <p className="settings__lede" style={{ marginTop: 12, color: message.ok ? 'var(--text-2)' : 'var(--danger)' }}>
            {message.text}
          </p>
        )}
      </Section>

      <Section label="API keys">
        <Card>
          <Row
            title="Share Eaon's API keys"
            description={
              config.shareKeys
                ? shared.length > 0
                  ? `Eaon Code terminals get ${shared.join(', ')}. Keys you set in Eaon Code itself, or export in your shell, take precedence.`
                  : 'No keys saved in Eaon match a provider Eaon Code knows. Add one in Model providers.'
                : 'Eaon Code terminals use only the keys Eaon Code has itself (its /login, or your shell).'
            }
          >
            <Switch
              checked={config.shareKeys}
              label="Share Eaon's API keys"
              onChange={(shareKeys) => void patchSettings({ eaonCode: { ...config, shareKeys } })}
            />
          </Row>
        </Card>
        <p className="settings__lede" style={{ marginTop: 12 }}>
          Keys reach an Eaon Code terminal as environment variables when it starts; nothing is written to Eaon
          Code&rsquo;s own configuration. Changes apply to terminals opened (or restarted) after this.
        </p>
      </Section>

      <Section label="About">
        <Card>
          <Row title="Package" description={<code>{EAON_CODE_PACKAGE}</code>} />
          <Row title="Source" description="Issues, docs and releases">
            <button className="btn btn--ghost" onClick={() => void window.api.app.openExternal(EAON_CODE_REPO)}>
              <ExternalLink size={14} strokeWidth={1.9} />
              GitHub
            </button>
          </Row>
        </Card>
      </Section>
    </>
  )
}
