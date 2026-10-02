import type { JSX } from 'react'
import { MonitorPlay, PanelRight } from 'lucide-react'
import { AGENT_BROWSER } from '@shared/agentBrowser'
import { useApp } from '../../state/store'
import { useAgentBrowser } from './agentBrowserStore'
import { LiveBrowserAddress, LiveBrowserControls, LiveBrowserStage, LiveBrowserSteps, useLiveBrowser } from './LiveBrowser'

export { stepText } from './LiveBrowser'

/**
 * Beside the chat: what the agent is doing in its own browser, live — its
 * cursor gliding to what it clicks, the page as it changes — and the step in
 * hand with the ones before it. "Take control" lets the user use the page
 * right here (to sign the agent in, or get it past a captcha); the agent
 * waits until they hand it back.
 */
export function AgentBrowserPanel(): JSX.Element {
  const setOpen = useAgentBrowser((s) => s.setOpen)
  const chatId = useApp((s) => s.activeChatId)
  const { frame, steps, working, controlled, exists } = useLiveBrowser(AGENT_BROWSER, true)
  const latest = steps[steps.length - 1]

  return (
    <aside className="browser agent-browser" aria-label="Eaon’s browser">
      <div className="browser__tabs">
        <span className="agent-browser__title">
          <MonitorPlay size={14} strokeWidth={1.9} />
          Eaon’s browser
          {working && !controlled && (
            <span className="agent-browser__live" aria-label="Working">
              <span className="agent-browser__live-dot" aria-hidden="true" />
              Live
            </span>
          )}
        </span>
        <div style={{ flex: 1 }} />
        <LiveBrowserControls target={AGENT_BROWSER} controlled={controlled} exists={exists || Boolean(frame)} agentName="Eaon" />
        <button className="icon-btn" data-active onClick={() => setOpen(false, chatId)} aria-label="Close Eaon’s browser" title="Close">
          <PanelRight size={16} strokeWidth={1.9} />
        </button>
      </div>

      <div className="browser__toolbar">
        <LiveBrowserAddress target={AGENT_BROWSER} frame={frame} controlled={controlled} />
      </div>

      <LiveBrowserStage target={AGENT_BROWSER} frame={frame} latest={latest} working={working} controlled={controlled} agentName="Eaon" />
      <LiveBrowserSteps steps={steps} />
    </aside>
  )
}

/** The chat header's button for the live view, once the agent has used its browser in this chat. */
export function AgentBrowserToggle(): JSX.Element | null {
  const chatId = useApp((s) => s.activeChatId)
  const usedHere = useApp((s) => s.activeChat()?.messages.some((m) => m.parts.some((p) => p.type === 'tool' && p.name === 'web_browser')) ?? false)
  const { open, used, setOpen } = useAgentBrowser()
  if (open || !(usedHere || (chatId && used.has(chatId)))) return null
  return (
    <button className="header-btn" onClick={() => setOpen(true)} title="Watch Eaon’s browser">
      <MonitorPlay size={14} strokeWidth={1.9} />
      <span>Browser</span>
    </button>
  )
}
