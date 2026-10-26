import { useEffect, useMemo, useState, type JSX } from 'react'
import { Check } from 'lucide-react'
import { HANDOFF_TRANSCRIPT_AGENTS, PROMPT_ARG, type TerminalAgent, type TerminalAgentId, type TerminalPaneSpec } from '@shared/terminals'
import { Modal, SearchField } from '../../ui'
import { notify } from '../../Notice'
import { terminals } from './registry'
import { useTerminals } from './terminalStore'
import { AgentMark } from './TerminalWorkspace'

/**
 * Hands a pane's work to another agent: another model takes a fresh look
 * from where this one stopped. Main writes the conversation into the project
 * (features/terminals/handoff.ts); a new pane opens the chosen agent on it.
 * The pane handed off from is left running, unchanged.
 */
export function HandoffDialog({
  open,
  onClose,
  cwd,
  pane,
  from,
  fromLabel
}: {
  open: boolean
  onClose: () => void
  cwd: string
  pane: TerminalPaneSpec
  /** What runs in the pane now (the watch's word over what it was opened as). */
  from: TerminalAgentId
  fromLabel: string
}): JSX.Element | null {
  const agents = useTerminals((s) => s.agents)
  const add = useTerminals((s) => s.add)
  const choices = useMemo(() => agents.filter((a) => a.id !== 'shell' && a.installed && a.command), [agents])
  const [query, setQuery] = useState('')
  const [to, setTo] = useState<TerminalAgentId | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Opened again: a clean form, with another model than this one picked to start with.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setNote('')
    setError(null)
    setBusy(false)
    const preferred: TerminalAgentId[] = from === 'claude' ? ['codex', 'gemini', 'cursor'] : ['claude', 'codex', 'gemini']
    setTo(preferred.find((id) => choices.some((a) => a.id === id)) ?? choices.find((a) => a.id !== from)?.id ?? choices[0]?.id ?? null)
    void useTerminals.getState().refreshAgents().catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? choices.filter((a) => a.label.toLowerCase().includes(q) || a.id.includes(q)) : choices
  }, [choices, query])
  const target = choices.find((a) => a.id === to) ?? null
  const transcript = HANDOFF_TRANSCRIPT_AGENTS.includes(from)

  const handOff = async (agent: TerminalAgent): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.terminals.handoff({
        paneId: pane.id,
        cwd,
        from,
        to: agent.id,
        ...(note.trim() ? { note: note.trim() } : {}),
        // Used only when Eaon can't read the agent's own transcript.
        ...(transcript ? {} : { screen: terminals.screenText(pane.id) })
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      // An agent that takes a task on its command line starts on it; any other gets it typed in once it's up.
      const takesArg = Boolean(PROMPT_ARG[agent.id])
      const opened = add(cwd, agent.id, undefined, takesArg ? result.prompt : undefined)
      if (!takesArg) terminals.typeWhenReady(opened.id, result.prompt, agent.id)
      notify(`${agent.label} is taking over from ${fromLabel}. The handoff is in ${result.file}.`, 'done')
      onClose()
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Hand off to another agent"
      width={460}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!target || busy} onClick={() => target && void handOff(target)}>
            {busy ? 'Handing off…' : target ? `Hand off to ${target.label}` : 'Hand off'}
          </button>
        </>
      }
    >
      <p className="handoff__lede">Start a fresh session with another agent from where this one stopped. {fromLabel} keeps running, unchanged.</p>

      <div className="handoff__current">
        <AgentMark agent={from} size={18} />
        <div className="handoff__current-text">
          <span className="handoff__current-title">
            {fromLabel} · {pane.name}
          </span>
          <span className="handoff__current-desc">
            {transcript
              ? 'Its conversation, the commands it ran and the files it changed are handed over.'
              : `Eaon can’t read ${fromLabel}’s own transcript, so the text in its terminal is handed over.`}
          </span>
        </div>
      </div>

      <div className="field-label">Agent</div>
      <SearchField value={query} onChange={setQuery} placeholder="Search agents…" variant="sm" autoFocus />
      <div className="handoff__agents" role="listbox" aria-label="Agent">
        {shown.map((agent) => (
          <button
            key={agent.id}
            type="button"
            role="option"
            aria-selected={agent.id === to}
            className="handoff__agent"
            data-selected={agent.id === to || undefined}
            onClick={() => setTo(agent.id)}
            onDoubleClick={() => !busy && void handOff(agent)}
          >
            <span className="handoff__check">{agent.id === to && <Check size={14} strokeWidth={2.4} />}</span>
            <AgentMark agent={agent.id} size={16} />
            <span className="handoff__agent-name">{agent.label}</span>
            {agent.id === from && <span className="handoff__agent-tag">same agent, fresh context</span>}
          </button>
        ))}
        {shown.length === 0 && (
          <div className="handoff__empty">{choices.length === 0 ? 'No coding agents are installed. Install one from New terminal.' : `No agents match “${query.trim()}”.`}</div>
        )}
      </div>

      <div className="field-label">
        Note <span className="handoff__optional">(optional)</span>
      </div>
      <textarea aria-label="Note"
        className="input handoff__note"
        rows={3}
        value={note}
        placeholder="What should it focus on? For example: the tests still fail on Windows."
        onChange={(e) => setNote(e.target.value)}
      />
      {error && (
        <div className="handoff__error" role="alert">
          {error}
        </div>
      )}
    </Modal>
  )
}
