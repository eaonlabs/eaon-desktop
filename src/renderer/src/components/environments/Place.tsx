import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowDownToLine, Check, Copy, ExternalLink, Globe, Loader2, Server, SquareTerminal, Trash2 } from 'lucide-react'
import { remoteLocation } from '@shared/adeRemote'
import { environmentsOf, placeLabel, providerOf, type ProviderId, type SessionPlace } from '@shared/environments'
import type { Chat } from '@shared/types'
import { useApp } from '../../state/store'
import { useChatCode } from '../chatCode/chatCodeStore'
import { notify } from '../Notice'
import { ConfirmDialog, MenuItem, MenuSeparator, Popover, useDisclosure } from '../ui'
import { ProviderMark } from './Providers'
import './environments.css'

const clean = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

/** Whose machine a session is on: kept on it, or (made before that was) its environment's. */
function usePlaceProvider(place: SessionPlace | undefined): ProviderId | undefined {
  const env = useApp((s) => (place ? environmentsOf(s.settings?.environments).find((e) => e.id === place.envId) : undefined))
  if (!place) return undefined
  return place.provider ?? (env ? providerOf(env) : place.kind === 'exe' ? 'exe' : undefined)
}

/** A session's machine as a mark: its provider's logo, or a server for a machine over SSH. */
export function PlaceMark({ place, size = 16 }: { place: SessionPlace; size?: number }): JSX.Element {
  const provider = usePlaceProvider(place)
  return provider ? (
    <ProviderMark id={provider} size={size} />
  ) : (
    <span className="env-tile" style={{ width: size, height: size }}>
      <Server size={Math.round(size * 0.62)} strokeWidth={2} />
    </span>
  )
}

/** Seconds since `from`, ticking while shown. */
function useElapsed(from: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return Math.max(0, Math.round((now - from) / 1000))
}

/** Steps of getting a machine ready, the last one under way. */
export function PlaceSteps({ steps }: { steps: string[] }): JSX.Element {
  return (
    <ol className="place-setup__steps">
      {steps.map((step, i) => {
        const done = i < steps.length - 1
        return (
          <li key={`${i}:${step}`} className="place-setup__step" data-done={done || undefined}>
            <span className="place-setup__mark" aria-hidden>
              {done ? <Check size={12} strokeWidth={2.6} /> : <Loader2 size={12} strokeWidth={2.4} className="spinner" />}
            </span>
            <span className="place-setup__text">{step}</span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * A session's cloud environment being got ready, where its first reply will
 * be: each step done ticked off, the one under way turning, and how long it
 * has taken so far.
 */
export function PlaceSetup({ place }: { place: SessionPlace }): JSX.Element {
  const elapsed = useElapsed(place.at)
  const steps = place.steps?.length ? place.steps : [`Getting ${place.name} ready`]
  return (
    <div className="place-setup" role="status" aria-live="polite">
      <div className="place-setup__head">
        <PlaceMark place={place} size={26} />
        <span className="place-setup__title">Setting up {place.name}</span>
        <span className="place-setup__time">{elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}</span>
      </div>
      <PlaceSteps steps={steps} />
    </div>
  )
}

/** `ssh <host>` landing in the session's folder, for a terminal of the user's own. */
export function sshCommandFor(place: SessionPlace): string | null {
  const at = place.folder ? remoteLocation(place.folder) : null
  if (!at || !place.host) return null
  return `ssh -t ${place.host} 'cd ${at.path.replace(/'/g, `'\\''`)} && exec "$SHELL" -l'`
}

/**
 * Where a chat runs, in its header: the machine, and what can be done with
 * it — open its terminal, bring the work back here as a branch, copy an
 * ssh command, open the VM's web address, delete the VM made for it.
 */
export function PlaceBadge({ chat }: { chat: Chat }): JSX.Element | null {
  const place = chat.place
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const [bringing, setBringing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const running = useApp((s) => Boolean(s.runs[chat.id]))
  // A provider's machine by its own name (sessions from before places kept it: their environment's).
  const machine = useApp((s) => (place ? environmentsOf(s.settings?.environments).find((e) => e.id === place.envId)?.provider?.machine : undefined))
  if (!place) return null
  const label = place.vm ?? place.machine ?? machine ?? placeLabel(place)
  const ready = place.state === 'ready'
  // Not set up yet, and nothing setting it up: it is when the session's next message goes.
  const state = place.state === 'preparing' && !running ? 'idle' : place.state
  const ssh = sshCommandFor(place)

  const bringBack = async (): Promise<void> => {
    menu.close()
    setBringing(true)
    try {
      const result = await window.api.environments.bringBack(place, chat.title)
      notify(result.ok ? result.message : result.error, result.ok ? 'done' : 'error')
    } catch (error) {
      notify(clean(error), 'error')
    } finally {
      setBringing(false)
    }
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="place-chip"
        data-state={bringing ? 'preparing' : state}
        data-open={menu.open || undefined}
        onClick={menu.toggle}
        title={ready ? `Runs on ${place.host ?? label} (${place.name})` : state === 'failed' ? `${place.name} isn’t ready: ${place.error ?? ''}` : state === 'idle' ? `Runs on ${place.name}, set up with the next message` : `Setting up ${place.name}`}
      >
        <span className="place-chip__mark">
          <PlaceMark place={place} size={16} />
          <span className="place-chip__state" aria-hidden />
        </span>
        <span className="place-chip__label">{label}</span>
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-start" width={300} className="place-menu">
        <div className="place-menu__head">
          <span className="place-menu__title">{place.name}</span>
          <span className="place-menu__sub">
            {ready
              ? `On ${place.host}${place.branch ? ` · ${place.branch}` : ''}`
              : state === 'failed'
                ? (place.error ?? 'Not ready')
                : state === 'idle'
                  ? 'Set up when this session’s next message goes'
                  : 'Setting up…'}
          </span>
        </div>
        <MenuSeparator />
        <MenuItem
          icon={<SquareTerminal size={15} strokeWidth={1.8} />}
          title="Open its terminal"
          disabled={!ready}
          onClick={() => {
            menu.close()
            useChatCode.getState().newTab()
          }}
        />
        <MenuItem
          icon={<ArrowDownToLine size={15} strokeWidth={1.8} />}
          title="Bring changes back"
          description="As a branch in the project here"
          disabled={!ready || !place.base || bringing}
          onClick={() => void bringBack()}
        />
        {ssh && (
          <MenuItem
            icon={<Copy size={15} strokeWidth={1.8} />}
            title="Copy SSH command"
            onClick={() => {
              menu.close()
              void navigator.clipboard.writeText(ssh).then(() => notify('Copied. Paste it in Terminal to work there yourself.'))
            }}
          />
        )}
        {place.kind === 'exe' && place.vm && (
          <MenuItem
            icon={<Globe size={15} strokeWidth={1.8} />}
            title="Open its web address"
            hint={<ExternalLink size={13} strokeWidth={1.8} />}
            onClick={() => {
              menu.close()
              void window.api.app.openExternal(`https://${place.vm}.exe.xyz/`)
            }}
          />
        )}
        {place.madeVm && place.vm && (
          <>
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={15} strokeWidth={1.8} />}
              title="Delete the VM"
              onClick={() => {
                menu.close()
                setDeleting(true)
              }}
            />
          </>
        )}
      </Popover>
      {deleting && place.vm && (
        <ConfirmDialog
          open
          title={`Delete ${place.vm}?`}
          confirmLabel="Delete VM"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            const vm = place.vm!
            void window.api.environments.removeVm(vm).then((result) => {
              if (!result.ok) return notify(result.error, 'error')
              useApp.getState().setChatPlace(chat.id, { ...place, state: 'failed', madeVm: false, error: `${vm} was deleted` })
              notify(`${vm} is deleted.`)
            })
          }}
        >
          Everything on it goes, including work this chat hasn’t brought back. The chat stays; its next message sets up a new VM.
        </ConfirmDialog>
      )}
    </>
  )
}

/**
 * Under a reply that failed because Codex or Claude Code isn't signed in on
 * the session's machine: a terminal there, with the sign-in already typed in.
 * Signing in is the user's own doing, in that terminal.
 */
export function SignInThere({ error }: { error: string }): JSX.Element | null {
  const place = useApp((s) => s.activeChat()?.place)
  const agent = /^Codex isn’t signed in on /.test(error) ? 'codex' : /^Claude Code isn’t signed in on /.test(error) ? 'claude' : null
  if (!agent || place?.state !== 'ready') return null
  return (
    <button
      type="button"
      className="btn btn--sm"
      onClick={() => useChatCode.getState().newTab({ title: 'Sign in', command: agent === 'codex' ? 'codex login --device-auth' : 'claude auth login' })}
    >
      <SquareTerminal size={13} strokeWidth={1.9} />
      Sign in on {placeLabel(place)}
    </button>
  )
}
