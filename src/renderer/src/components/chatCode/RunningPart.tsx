import { useEffect, useState, type JSX } from 'react'
import { Globe, Square, TerminalSquare } from 'lucide-react'
import { processName, type ChatProcess } from '@shared/chatCode'
import { openInBrowser } from '../browser/browserStore'
import { notify } from '../Notice'
import { useChatCode } from './chatCodeStore'

/**
 * The workspace card's Running part: the dev servers and watchers the agent
 * started in this folder, each with the address it printed (opened in the
 * browser beside the chat) and Stop. Nothing running, nothing shown.
 */
export function RunningPart(): JSX.Element | null {
  const folder = useChatCode((s) => s.folder)
  const [list, setList] = useState<ChatProcess[]>([])
  useEffect(() => {
    if (!folder) return
    let live = true
    const read = (): void =>
      void window.api.chatCode
        .processes(folder)
        .then((next) => live && setList(next))
        .catch(() => {})
    read()
    // A server prints its address a moment after it starts; one more look then.
    const later = setTimeout(read, 5000)
    const off = window.api.chatCode.onProcessesChanged(read)
    return () => {
      live = false
      clearTimeout(later)
      off()
    }
  }, [folder])
  if (!folder || list.length === 0) return null
  const stop = (pid: number): void => {
    setList((now) => now.filter((p) => p.pid !== pid))
    void window.api.chatCode.stopProcess(folder, pid).then((stopped) => {
      if (!stopped) notify('That process had already stopped.')
    })
  }
  return (
    <div className="ws-card__part">
      <div className="ws-card__label">Running</div>
      {list.map((p) => (
        <div key={p.pid} className="ws-row ws-row--proc" title={`${p.command}\npid ${p.pid}`}>
          <span className="ws-row__icon ws-row__icon--live" aria-hidden>
            <TerminalSquare size={15} strokeWidth={1.8} />
          </span>
          <span className="ws-row__label ws-row__label--mono">{processName(p.command)}</span>
          {p.url && (
            <button type="button" className="ws-proc__btn" onClick={() => openInBrowser(p.url!)} title={`Open ${p.url} beside the chat`}>
              <Globe size={13} strokeWidth={1.9} />
              <span>{p.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
            </button>
          )}
          <button type="button" className="ws-proc__btn ws-proc__btn--stop" onClick={() => stop(p.pid)} aria-label={`Stop ${p.command}`} title="Stop it">
            <Square size={10} strokeWidth={0} fill="currentColor" />
          </button>
        </div>
      ))}
    </div>
  )
}
