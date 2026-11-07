import { useEffect, useMemo, useState, type JSX } from 'react'
import { GUEST_ACCESS, type GuestAccess } from '@shared/channels'
import { MAX_TRIGGERS_PER_HOUR, type EmailState, type EmailTriggerRule, type EmailTriggerStatus } from '@shared/email'
import type { ScheduledTask } from '@shared/scheduler'
import type { Worker } from '@shared/workers'
import { Card, Row, Section, Select, Switch } from '../../ui'

/**
 * Settings → Workers → Email → Start work from new mail: for each worker with
 * an address of its own, a switch (off) that makes new mail to that address
 * wake the worker, or run an automation, with the email as the task. Mail is
 * written by strangers, so the page says what it may do and how many an hour.
 */

type Run = (work: () => Promise<EmailState>) => Promise<boolean>

const WAKE = 'wake'
/** The access an email may have is picked from the same levels chat-app guests get. */
const ACCESS_CHOICES = GUEST_ACCESS.map((a) => ({ value: a.id, label: a.label }))

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`
}

/** What the last email did, for the line under the switch. */
function usageLine(status: EmailTriggerStatus, now: number): string | null {
  const parts: string[] = []
  if (status.startedLastHour > 0) parts.push(`${status.startedLastHour} started in the last hour`)
  if (status.heldLastHour > 0) parts.push(`${status.heldLastHour} left unread because of the limit`)
  if (status.last) parts.push(`last: “${status.last.label}”, ${ago(status.last.at, now)}`)
  return parts.length > 0 ? `${parts.join(' · ')}.` : null
}

export function MailTriggers({ state, run, busy }: { state: EmailState; run: Run; busy: boolean }): JSX.Element | null {
  const [workers, setWorkers] = useState<Worker[] | null>(null)
  const [automations, setAutomations] = useState<ScheduledTask[]>([])
  useEffect(() => {
    void window.api.workers.list().then((list) => setWorkers(list ?? []), () => setWorkers([]))
    void window.api.scheduler.list().then((list) => setAutomations(list ?? []), () => setAutomations([]))
  }, [])
  // An older main process (updated while running) sends no triggers.
  const statuses = useMemo(() => new Map((state.triggers ?? []).map((t) => [t.workerId, t])), [state.triggers])
  const withAddress = useMemo(() => (workers ?? []).filter((w) => state.workerAddresses.some((a) => a.workerId === w.id)), [workers, state.workerAddresses])
  if (workers === null || !state.triggers) return null
  const now = Date.now()
  return (
    <Section label="Start work from new mail">
      <Card>
        {withAddress.length === 0 ? (
          <Row title="No worker has its own address yet" description="Give a worker an address above, and new mail to it can start work. Mail to Eaon’s own address never does." />
        ) : (
          withAddress.map((worker) => {
            const status = statuses.get(worker.id)
            if (!status) return null
            return (
              <Trigger
                key={worker.id}
                worker={worker}
                address={state.workerAddresses.find((a) => a.workerId === worker.id)?.inbox.address ?? ''}
                status={status}
                automations={automations}
                checksEvery={state.checkEveryMinutes}
                now={now}
                busy={busy}
                change={(patch) => void run(() => window.api.email.setTrigger(worker.id, patch))}
              />
            )
          })
        )}
      </Card>
      <p className="em-footnote">
        Off for every worker until you turn it on. Mail only counts from the moment you turn it on. An email is written by someone else, so it is
        read as a request to weigh, never an order, and it can’t do more than the level you pick. Workers still ask you before sending anything.
      </p>
    </Section>
  )
}

function Trigger({
  worker,
  address,
  status,
  automations,
  checksEvery,
  now,
  busy,
  change
}: {
  worker: Worker
  address: string
  status: EmailTriggerStatus
  automations: ScheduledTask[]
  checksEvery: number
  now: number
  busy: boolean
  change: (patch: Partial<EmailTriggerRule>) => void
}): JSX.Element {
  const rule = status.rule
  const [senders, setSenders] = useState<string | null>(null)
  const [limit, setLimit] = useState<string | null>(null)
  const usage = usageLine(status, now)
  const target = rule.automationId ?? WAKE
  // An automation that was deleted still shows as the choice, so the user sees why mail isn't starting anything.
  const known = automations.some((a) => a.id === rule.automationId)
  const targets = [
    { value: WAKE, label: `Wake ${worker.name}` },
    ...automations.map((a) => ({ value: a.id, label: `Run “${a.name}”` })),
    ...(rule.automationId && !known ? [{ value: rule.automationId, label: 'An automation that was deleted' }] : [])
  ]
  return (
    <>
      <Row
        title={worker.name}
        description={
          rule.enabled
            ? `New mail to ${address} starts work.${checksEvery === 0 ? ' Checking for mail is set to “Only when asked” below, so nothing starts until you refresh.' : ''}`
            : `New mail to ${address} is only kept for ${worker.name}.`
        }
      >
        <Switch label={`Start work when mail comes to ${worker.name}’s address`} checked={rule.enabled} disabled={busy} onChange={(enabled) => change({ enabled })} />
      </Row>
      {rule.enabled && (
        <>
          <Row title="What it starts" description={rule.automationId ? 'The email becomes that automation’s input. It runs read-only.' : 'Each email gets a task thread of its own.'}>
            <Select value={target} options={targets} width={230} label="What it starts" onChange={(value) => change({ automationId: value === WAKE ? null : value })} />
          </Row>
          {!rule.automationId && (
            <Row title="What an email may make it do" description={GUEST_ACCESS.find((a) => a.id === rule.access)?.description}>
              <Select<GuestAccess> value={rule.access} options={ACCESS_CHOICES} width={170} label="What an email may make it do" onChange={(access) => change({ access })} />
            </Row>
          )}
          <Row title="Only from" description="Addresses or whole domains, like jo@example.com or @example.com, separated by commas. Empty means anyone, which is how spam gets in.">
            <input
              className="input"
              style={{ width: 260 }}
              value={senders ?? rule.senders.join(', ')}
              placeholder="Anyone"
              spellCheck={false}
              aria-label={`Senders that may start work for ${worker.name}`}
              onChange={(e) => setSenders(e.target.value)}
              onBlur={() => {
                if (senders !== null && senders !== rule.senders.join(', ')) change({ senders: senders.split(/[\s,;]+/).filter(Boolean) })
                setSenders(null)
              }}
            />
          </Row>
          <Row title="Most an hour" description="Emails past this stay unread in the inbox and start nothing, so a flood of mail can’t run up a bill.">
            <input
              className="input em-number"
              type="number"
              min={1}
              max={MAX_TRIGGERS_PER_HOUR}
              value={limit ?? String(rule.maxPerHour)}
              aria-label={`Most emails an hour that start work for ${worker.name}`}
              onChange={(e) => setLimit(e.target.value)}
              onBlur={() => {
                const n = Math.round(Number(limit))
                setLimit(null)
                if (limit !== null && Number.isFinite(n) && n >= 1 && n !== rule.maxPerHour) change({ maxPerHour: n })
              }}
            />
          </Row>
          {(usage || status.last?.error) && (
            <Row title="Lately" description={[usage, status.last?.error ? `The last one didn’t start anything: ${status.last.error}` : null].filter(Boolean).join(' ')} />
          )}
        </>
      )}
    </>
  )
}
