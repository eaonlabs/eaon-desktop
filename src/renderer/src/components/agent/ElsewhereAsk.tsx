import { useEffect, useId, useMemo, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentWorkspace, useApp, type PendingApproval } from '../../state/store'
import { approvalDoes, approvalRisk } from './ApprovalCard'
import { ApprovalPreview } from './ApprovalRow'
import { approvalRow, askerName } from './approvalText'

/**
 * A chat's question while that chat isn't on screen. Several chats run at
 * once, and one of them stopping to ask used to put a dialog in the middle of
 * whatever was open. This says which chat is asking and what it would do,
 * shows exactly that a click away, and is answered here or opened in its
 * chat. It never takes the keyboard: ⏎ and esc belong to what's being typed,
 * and to the open chat's own question.
 *
 * Above Chat's message box, where the queued follow-ups go, it is for the
 * other chats; above a worker's (`everyChat`), for every chat, since none is
 * on screen. Floating at the foot of a page with no message box (Settings,
 * the ADE: ChatView ApprovalPrompt), it is for every chat too; it only floats
 * while no message box shows one.
 */

let hosts = 0
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((listener) => listener())

/** Whether a message box that shows other chats' questions is on screen. */
export const elsewhereShown = (): boolean => hosts > 0
export function subscribeElsewhere(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function ElsewhereAsk({ floating = false, everyChat = floating }: { floating?: boolean; everyChat?: boolean }): JSX.Element | null {
  useEffect(() => {
    if (floating) return
    hosts++
    notify()
    return () => {
      hosts--
      notify()
    }
  }, [floating])

  // The questions not asked in a conversation on screen, oldest first.
  const asks = useApp(
    useShallow((s) => {
      const all = s.pendingApproval ? [s.pendingApproval, ...s.approvalQueue] : s.approvalQueue
      if (everyChat) return all
      const here = new Set(s.activeChat()?.messages.map((m) => m.id) ?? [])
      return all.filter((a) => !here.has(a.messageId))
    })
  )
  const ask = asks[0]
  if (!ask) return null
  const strip = <Ask key={ask.requestId} ask={ask} more={asks.length - 1} />
  return floating ? <div className="elsewhere-float">{strip}</div> : strip
}

/** Opens the chat that is asking, from wherever the app is: Chat's tab, then the chat. */
function openAsking(chatId: string): void {
  const app = useApp.getState()
  const chat = agentWorkspace(app.workspaces)
  if (chat && chat.id !== app.settings?.activeWorkspaceId) app.setWorkspace(chat.id)
  app.openChat(chatId)
}

function Ask({ ask, more }: { ask: PendingApproval; more: number }): JSX.Element {
  const respondApproval = useApp((s) => s.respondApproval)
  const chat = useApp((s) => s.chats.find((c) => c.messages.some((m) => m.id === ask.messageId)) ?? null)
  const risk = approvalRisk(ask.tool, ask.input)
  const words = useMemo(() => approvalRow(ask), [ask])
  // What can't be taken back shows exactly what it would do without a click.
  const [open, setOpen] = useState(risk === 'high')
  const [answered, setAnswered] = useState(false)
  const titleId = useId()
  const previewId = useId()

  const respond = (approved: boolean): void => {
    if (answered) return
    setAnswered(true)
    respondApproval(approved, ask.requestId)
  }

  return (
    <section className="elsewhere-ask" data-risk={risk} aria-labelledby={titleId}>
      <div className="elsewhere-ask__line">
        <span className="elsewhere-ask__dot" aria-hidden="true" />
        <div className="elsewhere-ask__words">
          <div className="elsewhere-ask__head">
            <span id={titleId} className="elsewhere-ask__chat">
              {chat?.title ?? 'Another chat'}
            </span>
            <span className="elsewhere-ask__who">{askerName(ask.agent)} is asking</span>
            {more > 0 && (
              <span className="elsewhere-ask__more" title={`${more} more waiting in other chats`}>
                +{more}
              </span>
            )}
          </div>
          <div className="elsewhere-ask__what">
            <span className="elsewhere-ask__title">{words.title}</span>
            <button
              type="button"
              className="elsewhere-ask__link"
              data-code={ask.tool === 'run_command' || undefined}
              aria-expanded={open}
              aria-controls={open ? previewId : undefined}
              title={open ? 'Hide what it would do' : 'Show what it would do'}
              onClick={() => setOpen(!open)}
            >
              {words.link}
            </button>
          </div>
          {risk === 'high' && <div className="elsewhere-ask__warn">{approvalDoes(ask.tool, ask.input)}</div>}
        </div>
        <div className="elsewhere-ask__answers">
          {chat && (
            <button type="button" className="elsewhere-ask__open" onClick={() => openAsking(chat.id)}>
              Open
            </button>
          )}
          <button type="button" className="elsewhere-ask__deny" disabled={answered} onClick={() => respond(false)}>
            Deny
          </button>
          <button type="button" className="elsewhere-ask__allow" disabled={answered} onClick={() => respond(true)}>
            Allow
          </button>
        </div>
      </div>
      {open && (
        <div id={previewId} className="elsewhere-ask__preview">
          <ApprovalPreview ask={ask} />
        </div>
      )}
    </section>
  )
}
