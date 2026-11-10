import { useCallback, useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { HookStatus, ScheduledTask } from '@shared/scheduler'
import { Switch } from '../ui'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { formatRelative } from './format'

/**
 * One automation's webhook: off until the user turns it on, and only then is
 * its address (which holds its secret) shown, with a button to copy it. The
 * address is on the Local API Server that already runs, so only apps on this
 * computer reach it.
 */

export function HookControl({ task, now, onError }: { task: ScheduledTask; now: number; onError: (message: string) => void }): JSX.Element {
  const [status, setStatus] = useState<HookStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void window.api.scheduler.hook(task.id).then((s) => live && setStatus(s), () => {})
    return () => {
      live = false
    }
  }, [task.id])

  const change = useCallback(
    (work: () => Promise<HookStatus>): void => {
      setBusy(true)
      work()
        .then(setStatus)
        .catch((e: unknown) => onError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '')))
        .finally(() => setBusy(false))
    },
    [onError]
  )

  if (!status) return <span className="sched-muted">…</span>
  return (
    <div className="sched-hook">
      <div className="sched-hook__line">
        <Switch label={`Webhook for ${task.name}`} checked={status.on} disabled={busy} onChange={(on) => change(() => window.api.scheduler.setHook(task.id, on))} />
        <span className="sched-muted">{status.on ? 'On' : 'Off. Turn it on to let an app on this computer start this automation by calling an address.'}</span>
      </div>
      {status.on && status.url && (
        <>
          <div className="sched-hook__line">
            <input className="input sched-hook__url" readOnly value={status.url} aria-label={`Webhook address for ${task.name}`} spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
            <button
              className="icon-btn"
              aria-label="Copy the webhook address"
              title="Copy the address"
              onClick={() =>
                void copyText(status.url!).then((ok) => {
                  if (!ok) return onError(CLIPBOARD_FAILED)
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1400)
                })
              }
            >
              {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.9} />}
            </button>
            <button className="btn btn--sm" disabled={busy} title="The current address stops working" onClick={() => change(() => window.api.scheduler.newHookUrl(task.id))}>
              New address
            </button>
          </div>
          <p className="sched-hook__note">
            POST to it, with a JSON body if you like. The run reads the body as data to work on, never as instructions. Only apps on this computer can reach it, and
            anyone who has the address can start this automation, so keep it private. A paused automation ignores it.
          </p>
          {!status.serverRunning && (
            <p className="sched-hook__note sched-hook__note--warn">The Local API Server is off, so nothing answers this address yet. Turn it on in Settings → Local API Server.</p>
          )}
          <p className="sched-hook__note">
            {status.calls === 0 ? 'Not called yet.' : `Called ${status.calls} ${status.calls === 1 ? 'time' : 'times'}${status.lastCalledAt ? `, last ${formatRelative(status.lastCalledAt, now)}` : ''}.`}
          </p>
        </>
      )}
    </div>
  )
}
