import { useCallback, useEffect, useState, type JSX } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import { accountName, type CliAccountsState, type CodexPane } from '@shared/cliAccounts'
import { terminals } from './terminal/registry'
import { useTerminals } from './terminal/terminalStore'

/**
 * After switching Codex accounts: the ADE panes still running Codex as the
 * old one, and a button that moves them. A pane moves by starting again
 * with the new account's CODEX_HOME on the same conversation (`codex resume
 * <id>`; the accounts share their sessions folder). A pane that is working
 * is left alone until it's idle, and one whose conversation Eaon hasn't seen
 * can only be restarted by hand.
 */

/** How often the list is read again while it is on screen. */
const POLL_MS = 4000

export function MoveCodexPanes({ state, compact = false }: { state: CliAccountsState; compact?: boolean }): JSX.Element | null {
  const entry = state.tools.codex
  const active = entry.accounts.find((a) => a.id === entry.active)
  const [panes, setPanes] = useState<CodexPane[]>([])
  const [moved, setMoved] = useState(0)

  const read = useCallback(async () => {
    try {
      setPanes(await window.api.terminals.codexPanes())
    } catch {
      setPanes([])
    }
  }, [])

  // A new switch starts over.
  useEffect(() => setMoved(0), [entry.active])

  useEffect(() => {
    if (entry.accounts.length < 2) return
    void read()
    const id = setInterval(() => void read(), POLL_MS)
    return () => clearInterval(id)
  }, [read, entry.active, entry.accounts.length])

  if (!active || entry.accounts.length < 2) return null
  const behind = panes.filter((p) => p.dir !== active.dir)
  if (behind.length === 0) return moved > 0 ? <p className="move-panes__done">Moved {plural(moved, 'Codex pane')} to {accountName(active)}.</p> : null

  const ready = behind.filter((p) => !p.busy && p.sessionId && p.resumable)
  const busy = behind.filter((p) => p.busy)
  const stuck = behind.filter((p) => !p.busy && !(p.sessionId && p.resumable))
  const from = new Set(behind.map((p) => p.dir))
  const old = from.size === 1 ? entry.accounts.find((a) => a.dir === [...from][0]) : undefined

  const move = async (): Promise<void> => {
    const { layout, agents, refreshAgents } = useTerminals.getState()
    if (!agents.length) await refreshAgents().catch(() => undefined)
    const command = useTerminals.getState().agents.find((a) => a.id === 'codex')?.command ?? 'codex'
    let count = 0
    for (const pane of ready) {
      const cwd = Object.entries(layout).find(([, list]) => list.some((p) => p.id === pane.paneId))?.[0]
      if (!cwd || !pane.sessionId || !terminals.infoOf(pane.paneId).known) continue
      useTerminals.getState().setAgent(pane.paneId, 'codex')
      terminals.restart(pane.paneId, { cwd, command, agent: 'codex', resume: pane.sessionId })
      count++
    }
    setMoved(count)
    setTimeout(() => void read(), 1500)
  }

  return (
    <div className="move-panes" data-compact={compact || undefined}>
      <p className="move-panes__text">
        {plural(behind.length, 'Codex pane')} still {behind.length === 1 ? 'runs' : 'run'} as {old ? accountName(old) : 'another account'}.
        {busy.length > 0 && ` ${busy.length === behind.length ? (busy.length === 1 ? 'It’s' : 'They’re') : `${busy.length} ${busy.length === 1 ? 'is' : 'are'}`} working; move ${busy.length === 1 ? 'it' : 'them'} once idle.`}
        {stuck.length > 0 && ` ${stuck.length === 1 ? 'One has' : `${stuck.length} have`} no conversation Eaon can resume; restart ${stuck.length === 1 ? 'it' : 'them'} to switch.`}
      </p>
      {ready.length > 0 && (
        <button className="btn btn--ghost btn--sm move-panes__btn" onClick={() => void move()}>
          <ArrowRightLeft size={13} strokeWidth={2} /> Move {plural(ready.length, 'Codex session')} to {accountName(active)}
        </button>
      )}
    </div>
  )
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
