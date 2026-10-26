import { useEffect, useState, type JSX } from 'react'
import { Copy, ExternalLink, FolderLock, Github, Loader2 } from 'lucide-react'
import { Card, Row, Section, Segmented, Select, Switch } from '../../ui'
import type { LockedMode, LockedSupport, LockedTerminal, RcInfo, RcShare } from '@shared/rc'
import type { TerminalAgent } from '@shared/terminals'

const errorText = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error))

/**
 * Settings → Remote devices → Control from anywhere: this computer linked to
 * a GitHub account at rc.eaon.dev (features/rc). No app to install: any
 * browser signed in to the same GitHub account sees its ADE sessions, live
 * terminals and Workers.
 */
export function RemoteWebSection(): JSX.Element {
  const [info, setInfo] = useState<RcInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.rc.info().then(setInfo)
    return window.api.rc.onStatus(setInfo)
  }, [])

  const run = async (job: () => Promise<RcInfo>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setInfo(await job())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const site = info ? info.server.replace(/^https?:\/\//, '') : 'rc.eaon.dev'
  const state =
    !info?.enabled ? 'Off' : info.connection === 'connected' ? 'Connected' : info.connection === 'connecting' ? 'Connecting…' : info.connection === 'offline' ? 'Offline, retrying' : 'Off'

  return (
    <Section label="Control from anywhere">
      <Card>
        {!info ? null : info.linked ? (
          <>
            <Row
              title={`Linked to @${info.login ?? 'your GitHub account'}`}
              description={`Open ${site} and sign in with GitHub to see this computer’s ADE sessions, live terminals and Workers, from any browser.`}
            >
              <Switch label="Connected to Eaon Remote" checked={info.enabled} disabled={busy} onChange={(on) => void run(() => window.api.rc.setEnabled(on))} />
            </Row>
            <Row title="Status" description={info.problem ?? state}>
              <button type="button" className="btn btn--sm" onClick={() => void window.api.app.openExternal(info.server)}>
                <ExternalLink size={13} strokeWidth={2} />
                Open {site}
              </button>
            </Row>
            <Row title="Unlink this computer" description="It stops being reachable from the website right away, and its key stops working.">
              <button type="button" className="btn btn--sm btn--danger" disabled={busy} onClick={() => void run(() => window.api.rc.unlink())}>
                Unlink
              </button>
            </Row>
          </>
        ) : info.linking ? (
          <Row
            title="Approve it in your browser"
            description={`Sign in with GitHub at ${site} and check the code there matches this one. It expires in a few minutes.`}
          >
            <div className="rc-link">
              <span className="rc-link__code">{info.linking.code}</span>
              <Loader2 size={14} strokeWidth={2} className="spinner" aria-label="Waiting for approval" />
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void window.api.app.openExternal(info.linking!.url)}>
                Open again
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void run(() => window.api.rc.cancelLink())}>
                Cancel
              </button>
            </div>
          </Row>
        ) : (
          <Row
            title="Use this computer from the web"
            description={`Link it to your GitHub account, then open ${site} on any phone or computer to see and type into its ADE terminals and talk to its Workers. No app to install, and nothing on this computer is opened to the internet: it connects out.`}
          >
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void run(() => window.api.rc.link())}>
              <Github size={13} strokeWidth={2} />
              Link with GitHub
            </button>
          </Row>
        )}
        {(error || (info && !info.linked && info.problem)) && (
          <div className="row">
            <p className="ch-error">{error ?? info?.problem}</p>
          </div>
        )}
      </Card>
      {info?.linked && <LockedTerminals site={site} />}
      {info?.linked && <SharedWith site={site} connected={info.connection === 'connected'} />}
    </Section>
  )
}

/**
 * Who else can reach this computer through Eaon Remote: the people it, or
 * one of its terminals, was shared with on the website. Shown here too so
 * whoever sits at this computer knows, and can take it back without the
 * website.
 */
function SharedWith({ site, connected }: { site: string; connected: boolean }): JSX.Element | null {
  const [shares, setShares] = useState<RcShare[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void =>
      void window.api.rc.shares().then(
        (list) => alive && (setShares(list), setError(null)),
        (e) => alive && setError(errorText(e))
      )
    load()
    // Who is connected changes while the page is open.
    const timer = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [connected])

  const revoke = async (share: RcShare): Promise<void> => {
    setRevoking(share.id)
    try {
      await window.api.rc.revokeShare(share.id)
      setShares((list) => list?.filter((s) => s.id !== share.id) ?? null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRevoking(null)
    }
  }

  if (!shares?.length && !error) return null
  return (
    <Card>
      {shares?.map((share) => (
        <Row
          key={share.id}
          title={`@${share.login}${share.online ? ' · connected now' : ''}`}
          description={[
            share.pane?.startsWith('guest-') ? `Locked terminal “${share.paneLabel ?? 'folder'}”` : share.paneLabel ? `Terminal “${share.paneLabel}”` : share.pane ? 'One terminal' : 'This whole computer',
            share.pane?.startsWith('guest-')
              ? 'can type, inside that folder only'
              : share.access === 'control'
                ? share.pane
                  ? 'can watch (typing is for locked terminals only)'
                  : 'can watch, and open locked terminals in your sessions'
                : 'can watch',
            share.pending ? (share.expired ? 'invite expired' : 'invite not accepted yet') : null
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <button type="button" className="btn btn--sm btn--danger" disabled={revoking === share.id} onClick={() => void revoke(share)}>
            Revoke
          </button>
        </Row>
      ))}
      {error && (
        <div className="row">
          <p className="ch-error">{error}</p>
        </div>
      )}
      <div className="row">
        <p className="row__desc">Share a terminal or this computer from {site}. Revoking ends their connection right away.</p>
      </div>
    </Card>
  )
}

const EXPIRY: { value: string; label: string }[] = [
  { value: '1', label: 'For 1 hour' },
  { value: '8', label: 'For 8 hours' },
  { value: '24', label: 'For a day' },
  { value: '168', label: 'For a week' },
  { value: '0', label: 'Until I revoke it' }
]

/**
 * Locked terminals: a terminal of their own for a friend, inside one folder.
 * The operating system's sandbox (main/features/terminals/guestSandbox.ts)
 * keeps them there: they can move around inside it, never above it, and
 * nothing else on this computer is readable, writable or runnable by them.
 * Either a shell (optionally offline) or one CLI and nothing else.
 */
function LockedTerminals({ site }: { site: string }): JSX.Element | null {
  const [support, setSupport] = useState<LockedSupport | null>(null)
  const [list, setList] = useState<LockedTerminal[]>([])
  const [agents, setAgents] = useState<TerminalAgent[]>([])
  const [open, setOpen] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)
  const [mode, setMode] = useState<LockedMode>('shell')
  const [agent, setAgent] = useState('')
  const [network, setNetwork] = useState(false)
  const [login, setLogin] = useState('')
  const [hours, setHours] = useState('24')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<{ url: string; login: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const load = (): void => void window.api.rc.lockedList().then(setList, (e) => setError(errorText(e)))
  useEffect(() => {
    void window.api.rc.lockedSupport().then(setSupport)
    void window.api.terminals.agents().then((all) => {
      const clis = all.filter((a) => a.id !== 'shell' && a.installed && a.command)
      setAgents(clis)
      setAgent((current) => current || clis[0]?.id || '')
    })
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [])

  const pick = async (): Promise<void> => {
    const chosen = await window.api.rc.lockedPickFolder()
    if (chosen) setFolder(chosen)
  }

  const create = async (): Promise<void> => {
    if (!folder) return setError('Pick the folder to share.')
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.rc.lockedCreate({ folder, mode, agent: mode === 'cli' ? agent : null, network: mode === 'shell' && network, login, hours: Number(hours) })
      setMade({ url: res.url, login: res.terminal.login })
      setOpen(false)
      setFolder(null)
      setLogin('')
      load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await window.api.rc.lockedRevoke(id)
      setList((l) => l.filter((x) => x.id !== id))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (url: string): Promise<void> => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!support) return null
  const agentLabel = (id: string | null): string => agents.find((a) => a.id === id)?.label ?? id ?? 'a CLI'
  const until = (t: LockedTerminal): string => (t.expiresAt ? `until ${new Date(t.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'until you revoke it')

  return (
    <Card>
      <Row
        title="Share a locked terminal"
        description={
          support.ok
            ? 'Give a friend a terminal of their own inside one folder. They can work in it and its subfolders, and nothing else: your other files, your accounts and keys, sudo and the rest of this computer stay out of reach. It’s enforced by the operating system’s sandbox, not by the shell.'
            : support.reason
        }
      >
        {support.ok && !open && (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => (setOpen(true), setMade(null), setError(null))}>
            <FolderLock size={13} strokeWidth={2} />
            Share a folder
          </button>
        )}
      </Row>

      {open && (
        <>
          <Row title="Folder" description={folder ?? 'They’ll start here and can never go above it.'}>
            <button type="button" className="btn btn--sm" onClick={() => void pick()}>
              {folder ? 'Change' : 'Choose…'}
            </button>
          </Row>
          <Row title="What they get" description={mode === 'shell' ? 'A shell inside the folder.' : 'One CLI and nothing else. Quitting it ends their session; it can’t start a shell or any other program.'}>
            <Segmented<LockedMode> value={mode} options={[{ value: 'shell', label: 'Shell' }, { value: 'cli', label: 'One CLI only' }]} onChange={setMode} />
          </Row>
          {mode === 'cli' && (
            <Row title="CLI" description={agents.length ? 'They sign in with their own account. Yours stays on your side.' : 'No coding CLIs are installed on this computer.'}>
              {agents.length > 0 && <Select value={agent} options={agents.map((a) => ({ value: a.id, label: a.label }))} onChange={setAgent} />}
            </Row>
          )}
          {mode === 'shell' && (
            <Row title="Internet" description={network ? 'They can use git, npm, curl and the like.' : 'Off: nothing in the folder can be sent anywhere.'}>
              <Switch label="Let the shell use the internet" checked={network} onChange={setNetwork} />
            </Row>
          )}
          <Row title="Their GitHub username" description="The invite link only works for this account.">
            <input aria-label="Their GitHub username" className="input" placeholder="octocat" value={login} onChange={(e) => setLogin(e.target.value)} spellCheck={false} autoCapitalize="off" />
          </Row>
          <Row title="How long">
            <Select value={hours} options={EXPIRY} onChange={setHours} />
          </Row>
          <div className="row">
            <div className="row__body" />
            <div className="row__trail">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn--sm btn--primary" disabled={busy || !folder || !login.trim() || (mode === 'cli' && !agent)} onClick={() => void create()}>
                {busy ? <Loader2 size={13} strokeWidth={2} className="spinner" /> : null}
                Create invite link
              </button>
            </div>
          </div>
        </>
      )}

      {made && (
        <Row title={`Send this link to @${made.login}`} description={`It works once, only for @${made.login} signed in on ${site}, and only for a week.`}>
          <button type="button" className="btn btn--sm" onClick={() => void copy(made.url)}>
            <Copy size={13} strokeWidth={2} />
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </Row>
      )}

      {list.map((t) => (
        <Row
          key={t.id}
          title={`@${t.login} · ${t.label}${t.online ? ' · connected now' : ''}`}
          description={[
            t.mode === 'cli' ? `${agentLabel(t.agent)} only` : t.network ? 'Shell with internet' : 'Shell, offline',
            t.folder,
            until(t),
            t.pending ? 'invite not accepted yet' : t.running ? 'their terminal is running' : null
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <button type="button" className="btn btn--sm btn--danger" disabled={busy} onClick={() => void revoke(t.id)}>
            Revoke
          </button>
        </Row>
      ))}

      {error && (
        <div className="row">
          <p className="ch-error">{error}</p>
        </div>
      )}
    </Card>
  )
}
