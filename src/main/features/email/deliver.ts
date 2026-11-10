import type { EmailMessage } from '@shared/email'
import type { RunInput, ScheduledTask } from '@shared/scheduler'
import type { WorkerMail } from '@shared/workers'
import type { IncomingMail } from './service'
import { automationInput, whoSent, workerTask } from './trigger'

/**
 * Hands an email that may start work to what it starts: the worker whose
 * address it came to (in a task thread of its own, held to the rule's access
 * level, as a guest's message is), or the automation the rule names (the
 * email as that run's input). Throws a sentence when it can't; the service
 * keeps that as the rule's last error.
 */

export interface DeliverDeps {
  /** The message in full (which also marks it read). */
  read: (messageId: string, workerId: string) => Promise<EmailMessage>
  workers: {
    has: (id: string) => boolean
    receive: (id: string, mail: Omit<WorkerMail, 'id' | 'at'>, options: { thread: { title: string } }) => { threadId: string }
  } | null
  automations: {
    list: () => ScheduledTask[]
    runNow: (taskId: string, input: RunInput) => unknown
  } | null
}

export async function deliverIncoming(incoming: IncomingMail, deps: DeliverDeps): Promise<void> {
  const { workerId, message, rule } = incoming
  let task: ScheduledTask | undefined
  if (rule.automationId) {
    if (!deps.automations) throw new Error('Automations aren’t running.')
    task = deps.automations.list().find((t) => t.id === rule.automationId)
    if (!task) throw new Error('The automation this address starts is gone. Pick another in Settings → Workers → Email.')
    // Paused means the user stopped it; mail from outside doesn't start it again.
    if (!task.enabled) throw new Error(`“${task.name}” is paused, so this email didn’t start it.`)
  } else if (!deps.workers?.has(workerId)) {
    throw new Error('That worker isn’t there any more.')
  }
  const full = await deps.read(message.id, workerId)
  const body = full.text ?? message.preview
  if (task) {
    deps.automations!.runNow(task.id, automationInput(full, body))
    return
  }
  deps.workers!.receive(
    workerId,
    {
      from: 'guest',
      fromName: whoSent(full.from),
      text: workerTask(full, body),
      files: [],
      email: { messageId: full.id, from: full.from, subject: full.subject, cap: rule.access }
    },
    { thread: { title: full.subject || `Email from ${whoSent(full.from)}` } }
  )
}
