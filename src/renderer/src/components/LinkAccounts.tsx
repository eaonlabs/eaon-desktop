import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Check, ExternalLink, Loader2, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ModelInfo, Provider } from '@shared/types'
import type { ProviderAuthStatus } from '@shared/providers'
import { LINK_TARGETS, type DetectedApp, type LinkTarget } from '@shared/linkAccounts'
import { providerReadiness } from '@shared/modelSelection'
import { useApp } from '../state/store'
import { BrandIcon } from '../icons/brand'
import { Modal } from './ui'
import { openInAde } from './code/terminal/terminalStore'
import './link-accounts.css'

/**
 * Link accounts: every AI account the user has, brought in through the route
 * its provider allows, with each linked provider's models shown as soon as it
 * links. "Link everything found" runs the official sign-ins and turns on the
 * local runtimes for the apps installed here, one after another; providers
 * that only take API keys get their key field.
 *
 * Nothing here reads another app's sign-in. Eaon only learns which apps are
 * installed (main/features/linkAccounts.ts), and every account goes through
 * the provider's own sign-in or a key the user pastes, so no one's account
 * is put at risk.
 */

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Linked: the provider has models Eaon can use right now (not merely a stored key a check found broken). */
const isLinked = (p: Provider | undefined): boolean => Boolean(p && providerReadiness(p).state === 'ready')

export function LinkAccounts({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { providers, refreshProviders } = useApp(useShallow((s) => ({ providers: s.providers, refreshProviders: s.refreshProviders })))
  const [apps, setApps] = useState<DetectedApp[]>([])
  const [auth, setAuth] = useState<Record<string, ProviderAuthStatus>>({})
  const [linkingAll, setLinkingAll] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // A row that should show its key field (Link everything found can't paste keys).
  const [wantsKey, setWantsKey] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    void window.api.linkAccounts.detect().then(setApps)
    void window.api.providerAuth.status().then((list) => setAuth(Object.fromEntries(list.map((s) => [s.providerId, s]))))
    void refreshProviders()
    return window.api.providerAuth.onStatus((status) => {
      setAuth((current) => ({ ...current, [status.providerId]: status }))
      if (status.state !== 'pending') void refreshProviders()
    })
  }, [open, refreshProviders])

  const installed = useMemo(() => new Set(apps.filter((a) => a.installed).map((a) => a.id)), [apps])
  const byId = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers])
  const targets = useMemo(() => {
    const found = (t: LinkTarget): boolean => t.apps.some((a) => installed.has(a))
    return LINK_TARGETS.filter((t) => byId.has(t.providerId)).sort((a, b) => Number(found(b)) - Number(found(a)))
  }, [installed, byId])
  const foundApps = (t: LinkTarget): string[] => apps.filter((a) => a.installed && t.apps.includes(a.id)).map((a) => a.name)

  /** Signs in or turns on every provider whose app is installed here, one at a time. */
  const linkEverything = async (): Promise<void> => {
    setLinkingAll(true)
    setNote(null)
    const keys: string[] = []
    const failed: string[] = []
    let linked = 0
    try {
      for (const target of targets) {
        if (foundApps(target).length === 0 || isLinked(byId.get(target.providerId))) continue
        if (target.method === 'key') {
          keys.push(target.providerId)
          continue
        }
        if (target.method === 'signin') {
          if (auth[target.providerId]?.needsClientId) continue
          const name = byId.get(target.providerId)?.name ?? target.providerId
          try {
            const status = await window.api.providerAuth.signIn(target.providerId)
            if (status?.signedIn) linked++
            else failed.push(`${name} didn't finish signing in`)
          } catch (error) {
            failed.push(`${name}: ${errorText(error)}`)
          }
        } else {
          try {
            await turnOnLocal(target.providerId)
            linked++
          } catch (error) {
            failed.push(`${byId.get(target.providerId)?.name ?? target.providerId}: ${errorText(error)}`)
          }
        }
      }
      await refreshProviders()
    } finally {
      setLinkingAll(false)
    }
    setWantsKey(new Set(keys))
    const names = keys.map((id) => byId.get(id)?.name ?? id)
    setNote(
      [
        linked ? `Linked ${linked} ${linked === 1 ? 'account' : 'accounts'}.` : failed.length ? '' : 'Nothing new to sign in to.',
        failed.length ? `Couldn't link ${failed.join('; ')}.` : '',
        names.length ? `${names.join(', ')} ${names.length === 1 ? 'takes' : 'take'} an API key: paste it below.` : ''
      ]
        .filter(Boolean)
        .join(' ')
    )
  }

  const anyFound = targets.some((t) => foundApps(t).length > 0 && !isLinked(byId.get(t.providerId)))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link accounts"
      width={600}
      actions={
        <button className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="la">
        <p className="la__lede">
          Bring in the AI accounts you already have. Eaon signs in only the way each provider allows (its official sign-in or an
          API key) and never takes a sign-in from another app, so your accounts stay safe.
        </p>
        <div className="la__all">
          <button className="btn btn--primary" disabled={linkingAll || !anyFound} onClick={() => void linkEverything()}>
            {linkingAll ? <Loader2 size={14} className="spinner" /> : <Sparkles size={14} strokeWidth={2} />}
            {linkingAll ? 'Linking…' : 'Link everything found'}
          </button>
          <span className="la__fine">
            {anyFound
              ? `Found: ${apps.filter((a) => a.installed).map((a) => a.name).join(', ')}. Each sign-in opens in your browser for you to approve.`
              : apps.some((a) => a.installed)
                ? 'Everything found on this computer is linked.'
                : 'No AI apps found on this computer. Link any account below.'}
          </span>
        </div>
        {note && <p className="la__note">{note}</p>}

        <div className="la__list">
          {targets.map((target) => (
            <LinkRow
              key={target.providerId}
              target={target}
              provider={byId.get(target.providerId)!}
              status={auth[target.providerId]}
              found={foundApps(target)}
              showKey={wantsKey.has(target.providerId)}
              onLinked={() => void refreshProviders()}
              onPicked={onClose}
            />
          ))}
        </div>
      </div>
    </Modal>
  )
}

/** Turns on a local runtime and lists its models; fails when it isn't running. */
async function turnOnLocal(providerId: string): Promise<void> {
  await window.api.providers.update(providerId, { enabled: true })
  const models = (await window.api.providers.refreshModels(providerId)) as ModelInfo[] | undefined
  if (Array.isArray(models) && models.length === 0) throw new Error('No models yet')
}

function LinkRow({
  target,
  provider,
  status,
  found,
  showKey,
  onLinked,
  onPicked
}: {
  target: LinkTarget
  provider: Provider
  status: ProviderAuthStatus | undefined
  found: string[]
  showKey: boolean
  onLinked: () => void
  onPicked: () => void
}): JSX.Element {
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyOpen, setKeyOpen] = useState(showKey)
  const input = useRef<HTMLInputElement>(null)
  const linked = isLinked(provider)
  const pending = status?.state === 'pending'

  useEffect(() => {
    if (showKey) {
      setKeyOpen(true)
      requestAnimationFrame(() => input.current?.focus())
    }
  }, [showKey])

  const run = useCallback(
    async (work: () => Promise<void>): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        await work()
        onLinked()
      } catch (e) {
        setError(errorText(e))
      } finally {
        setBusy(false)
      }
    },
    [onLinked]
  )

  const signIn = (): Promise<void> =>
    run(async () => {
      const result = await window.api.providerAuth.signIn(provider.id)
      if (result.state === 'error') throw new Error(result.error ?? 'The sign-in didn’t finish.')
    })
  const saveKey = (): Promise<void> =>
    run(async () => {
      await window.api.keys.set(provider.id, key.trim())
      // Linking is asking to use it: a provider switched off earlier comes back on.
      if (!provider.enabled) await window.api.providers.update(provider.id, { enabled: true })
      setKey('')
      // Lists the models the key can reach; a failure here still leaves the catalog's list.
      await window.api.providers.refresh(provider.id).catch(() => undefined)
      setKeyOpen(false)
    })
  const turnOn = (): Promise<void> =>
    run(async () => {
      try {
        await turnOnLocal(provider.id)
      } catch {
        throw new Error(`Eaon couldn't reach ${provider.name}. Open it, load a model, then try again.`)
      }
    })

  let action: JSX.Element | null = null
  if (linked) {
    action = (
      <span className="la__linked">
        <Check size={14} strokeWidth={2.4} /> Linked
      </span>
    )
  } else if (target.method === 'signin') {
    action = status?.needsClientId ? (
      <button
        className="btn btn--sm"
        title={`${provider.name} sign-in needs a one-time setup in Settings → Model providers`}
        onClick={() => {
          setSettingsPage('providers')
          onPicked()
        }}
      >
        Set up
      </button>
    ) : pending ? (
      <button className="btn btn--sm" onClick={() => void window.api.providerAuth.cancel(provider.id)}>
        <Loader2 size={13} className="spinner" /> Waiting… Cancel
      </button>
    ) : (
      <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void signIn()}>
        Sign in
      </button>
    )
  } else if (target.method === 'local') {
    action = (
      <button className="btn btn--sm" disabled={busy} onClick={() => void turnOn()}>
        {busy ? 'Checking…' : 'Turn on'}
      </button>
    )
  } else if (!keyOpen) {
    action = (
      <button className="btn btn--sm" onClick={() => setKeyOpen(true)}>
        Add API key
      </button>
    )
  }

  return (
    <div className="la-row" data-linked={linked || undefined}>
      <div className="la-row__head">
        <BrandIcon id={provider.id} size={34} name={provider.name} />
        <div className="la-row__text">
          <div className="la-row__name">
            {provider.name}
            {found.length > 0 && <span className="la-row__found">{found.join(' · ')} found</span>}
          </div>
          <div className="la-row__blurb">{target.blurb}</div>
        </div>
        {action}
      </div>

      {!linked && target.method === 'key' && keyOpen && (
        <div className="la-row__key">
          <input
            ref={input}
            className="input"
            type="password"
            placeholder={`${provider.name} API key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && key.trim() && void saveKey()}
            spellCheck={false}
          />
          <button className="btn btn--primary btn--sm" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {provider.keyUrl && (
            <button className="btn btn--ghost btn--sm" onClick={() => void window.api.app.openExternal(provider.keyUrl!)}>
              Get a key <ExternalLink size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      )}

      {!linked && target.why && (
        <p className="la-row__why">
          {target.why}
          {provider.id === 'anthropic' && (
            <>
              {' '}
              <button
                className="la-row__inline"
                onClick={() => {
                  void openInAde('claude')
                  onPicked()
                }}
              >
                Open Claude Code in the ADE
              </button>
            </>
          )}
        </p>
      )}
      {error && <p className="la-row__error">{error}</p>}
      {linked && <LinkedModels provider={provider} onPicked={onPicked} />}
    </div>
  )
}

/** The models a provider just brought in, ready to pick. */
function LinkedModels({ provider, onPicked }: { provider: Provider; onPicked: () => void }): JSX.Element {
  const selectModel = useApp((s) => s.selectModel)
  const [all, setAll] = useState(false)
  const shown = all ? provider.models : provider.models.slice(0, 8)
  return (
    <div className="la-models">
      {shown.map((model) => (
        <button
          key={model.id}
          className="la-models__chip"
          title={`Use ${model.label}`}
          onClick={() => {
            selectModel(model.id, provider.id)
            onPicked()
          }}
        >
          {model.label}
          {(model.efforts?.length ?? 0) >= 2 && <span className="la-models__badge">Thinking</span>}
        </button>
      ))}
      {provider.models.length > 8 && !all && (
        <button className="la-models__more" onClick={() => setAll(true)}>
          +{provider.models.length - 8} more
        </button>
      )}
    </div>
  )
}
