import { useEffect, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { USAGE_PROVIDERS, type UsageProviderId } from '@shared/providerUsage'
import type { Settings } from '@shared/types'
import { useApp } from '../../../state/store'
import { ensureLimits, refreshLimits, signedIn, useLimitsSources, useProviderUsage } from '../../../state/limits'
import { useCliAccounts } from '../../../state/cliAccounts'
import { LimitsCard } from '../../LimitsCard'
import { ProviderMark } from '../../composer/ProviderMark'
import { Card, Row, Section, Segmented, Switch } from '../../ui'
import '../../../styles/limits.css'

/**
 * Settings → Usage & limits: what's left of every coding plan signed in on
 * this computer — Claude Code and Codex, Cursor, GitHub Copilot, Grok,
 * OpenCode Go, Devin, and the balances of OpenRouter and DeepSeek keys saved
 * in Eaon — which two the ADE header's rings show, and what their cards hold.
 */

type Limits = Settings['usageLimits']

const DEFAULTS: Limits = { sidebar: ['codex', 'claude'], ring: 'both', details: false, banked: true, tokens: true }
const MAX_SIDEBAR = 2

export function UsageLimitsPage(): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const limits: Limits = { ...DEFAULTS, ...settings?.usageLimits }
  const set = (patch: Partial<Limits>): void => void patchSettings({ usageLimits: { ...limits, ...patch } })
  const { cli, provider } = useLimitsSources()
  const readingProviders = useProviderUsage((s) => s.state?.loading ?? false)
  const readingCli = useCliAccounts((s) => Boolean(s.state?.loading.length))
  const loading = readingProviders || readingCli
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    ensureLimits()
    void useCliAccounts.getState().refresh()
  }, [])

  const now = Date.now()
  const views = signedIn(cli, provider, now)
  const plans = USAGE_PROVIDERS.filter((p) => p.kind === 'plan')
  // Once anything is signed in, the list is what's signed in; before that, every provider, so there's something to pick.
  const listed = views.length > 0 ? plans.filter((p) => views.some((v) => v.id === p.id) || limits.sidebar.includes(p.id)) : plans
  const toggle = (id: UsageProviderId, on: boolean): void => {
    const rest = limits.sidebar.filter((p) => p !== id)
    // A third replaces the oldest pick.
    set({ sidebar: on ? [...rest, id].slice(-MAX_SIDEBAR) : rest })
  }

  return (
    <>
      <div className="settings__title-row">
        <h1 className="settings__h1">Usage & limits</h1>
        <button className="btn btn--ghost btn--sm limits-restore" onClick={() => void patchSettings({ usageLimits: DEFAULTS })}>
          <RotateCcw size={13} strokeWidth={2} />
          Restore defaults
        </button>
      </div>
      <p className="settings__lede">See remaining quota and credits for every signed-in provider.</p>

      <Section label={`ADE header · up to ${MAX_SIDEBAR} accounts`}>
        <Card>
          {listed.map((p) => (
            <Row
              key={p.id}
              title={
                <span className="limits-provider">
                  <span className="limits-provider__mark">
                    <ProviderMark providerId={p.mark} size={18} />
                  </span>
                  {p.name}
                </span>
              }
            >
              <Switch label={`Show ${p.name} in the ADE header`} checked={limits.sidebar.includes(p.id)} onChange={(on) => toggle(p.id, on)} />
            </Row>
          ))}
          <Row title="Ring" description="Show both limits as two rings, or a single ring for one of them.">
            <Segmented
              value={limits.ring}
              options={[
                { value: 'both', label: 'Both' },
                { value: '5h', label: '5h' },
                { value: 'weekly', label: 'Weekly' }
              ]}
              onChange={(ring) => set({ ring })}
            />
          </Row>
        </Card>
      </Section>

      <Section label="Usage popovers">
        <Card>
          <Row
            title="Show details by default"
            description="Open the details below the limits. When off, they stay behind the Details toggle; your last toggle also updates this preference."
          >
            <Switch label="Show details by default" checked={limits.details} onChange={(details) => set({ details })} />
          </Row>
          <Row title="Banked resets" description="Include Codex banked resets in the details.">
            <Switch label="Banked resets" checked={limits.banked} onChange={(banked) => set({ banked })} />
          </Row>
          <Row title="Credits and token totals" description="Include credit balances and recent token totals (24h, 7d, 30d) in the details.">
            <Switch label="Credits and token totals" checked={limits.tokens} onChange={(tokens) => set({ tokens })} />
          </Row>
        </Card>
      </Section>

      <div className="limits-head">
        <span className="settings__section-label">Provider usage</span>
        <button
          className="btn btn--ghost btn--sm"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true)
            void refreshLimits().finally(() => setRefreshing(false))
          }}
        >
          <RefreshCw size={13} strokeWidth={2} className={refreshing || loading ? 'limits-spin' : undefined} />
          Refresh
        </button>
      </div>
      <div className="limits-list">
        {views.length === 0 ? (
          <p className="settings__lede">{loading || !provider ? 'Reading usage…' : 'Nothing is signed in yet. Sign in to Claude Code, Codex, Cursor or another provider and it shows here.'}</p>
        ) : (
          views.map((view) => <LimitsCard key={view.id} view={view} details banked={limits.banked} tokens={limits.tokens} />)
        )}
      </div>
      <p className="accounts__fine">
        Usage is read on this computer from each provider’s own sign-in — its CLI, its app, or a key saved in Eaon — and asked of the provider
        directly; recent token totals come from the CLIs’ own logs. The list follows whatever you are signed into: until anything is, every provider
        shows so you can pick. Nothing is sent anywhere else.
      </p>
    </>
  )
}
