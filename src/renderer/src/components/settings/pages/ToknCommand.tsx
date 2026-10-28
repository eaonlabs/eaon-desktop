import { useEffect, useState, type JSX } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { ToknCliStatus } from '@shared/toknCli'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Switch } from '../../ui'

/**
 * Settings → Usage → The tokn command: the CLI that ships with Eaon
 * (main/features/toknCli.ts). It tracks what Claude Code, Codex and the
 * other coding CLIs use, which Eaon itself doesn't see, and publishes it to
 * the same Tokn profile.
 */

function ago(at: number | null): string {
  if (!at) return ''
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} hr ago` : new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ToknCommand({ signedIn }: { signedIn: boolean }): JSX.Element | null {
  const settings = useApp((s) => s.settings?.toknCli)
  const patchSettings = useApp((s) => s.patchSettings)
  const [status, setStatus] = useState<ToknCliStatus | null>(null)

  useEffect(() => {
    void window.api.toknCli.status().then(setStatus)
    return window.api.toknCli.onChanged(setStatus)
  }, [])

  if (!settings || !status || !status.version) return null

  const change = (patch: Partial<typeof settings>): void => {
    void patchSettings({ toknCli: patch }).then(() => window.api.toknCli.apply().then(setStatus))
  }
  const busy = status.activity.state !== 'idle'
  const command = status.command

  const where =
    command?.kind === 'other'
      ? `You already have tokn at ${command.path}, so Eaon leaves it as it is.`
      : status.needsPath
        ? `It’s in ${status.needsPath}, which your terminal doesn’t search yet. Add that folder to your PATH to run tokn there.`
        : command
          ? `Run tokn in any terminal. Version ${status.version}, from Eaon.`
          : `Version ${status.version} comes with Eaon.`

  const trackDescription = !signedIn
    ? settings.sync
      ? 'When you sign in with Tokn above, tokn links to the same account and publishes Claude Code, Codex and the other CLIs’ usage every hour.'
      : 'Off: signing in with Tokn tracks only what you use in Eaon.'
    : !settings.sync
      ? 'Off: only what you use in Eaon goes to your profile.'
      : status.linked
      ? `Linked to @${status.linked.handle || 'your account'}. Publishes Claude Code, Codex and the other CLIs’ usage to your profile every hour.`
      : 'Links tokn to your Tokn account and publishes Claude Code, Codex and the other CLIs’ usage every hour.'

  const activity =
    status.activity.state === 'linking'
      ? 'Linking tokn…'
      : status.activity.state === 'syncing'
        ? 'Syncing…'
        : status.activity.error
          ? status.activity.error
          : status.activity.at
            ? `Last synced ${ago(status.activity.at)}.`
            : null

  return (
    <Section label="The tokn command">
      <Card>
        <Row title="Install the tokn command" description={where}>
          <Switch checked={settings.install} onChange={(install) => change({ install })} label="Install the tokn command" />
        </Row>
        <Row title="Track the coding CLIs too" description={trackDescription}>
          <Switch checked={settings.sync} onChange={(sync) => change({ sync })} label="Track the coding CLIs too" />
        </Row>
        {signedIn && settings.sync && (
          <Row title={status.linked ? 'tokn sync' : 'Link tokn'} description={activity ?? undefined}>
            <button
              className="btn btn--sm"
              disabled={busy}
              onClick={() => void (status.linked ? window.api.toknCli.sync() : window.api.toknCli.link()).then(setStatus)}
            >
              {busy ? <Loader2 size={13} className="spinner" /> : <RefreshCw size={13} strokeWidth={2} />}
              {status.linked ? 'Sync now' : 'Link now'}
            </button>
          </Row>
        )}
      </Card>
    </Section>
  )
}
