import type { JSX } from 'react'
import { AGENT_BROWSER } from '@shared/agentBrowser'
import { LiveBrowserAddress, LiveBrowserControls, LiveBrowserStage, LiveBrowserSteps, useLiveBrowser } from './LiveBrowser'

export { stepText } from './LiveBrowser'

/**
 * Eaon's browser, as a tab of Chat's dock: what the agent is doing in its
 * own browser, live — its cursor gliding to what it clicks, the page as it
 * changes — and the step in hand with the ones before it. "Take control"
 * lets the user use the page right here (to sign the agent in, or get it
 * past a captcha); the agent waits until they hand it back.
 */
export function AgentBrowserSurface(): JSX.Element {
  const { frame, steps, working, controlled, exists } = useLiveBrowser(AGENT_BROWSER, true)
  const latest = steps[steps.length - 1]
  return (
    <div className="browser agent-browser agent-browser--docked" aria-label="Eaon’s browser">
      <div className="browser__toolbar">
        <LiveBrowserAddress target={AGENT_BROWSER} frame={frame} controlled={controlled} />
        {working && !controlled && (
          <span className="agent-browser__live" aria-label="Working">
            <span className="agent-browser__live-dot" aria-hidden="true" />
            Live
          </span>
        )}
        <LiveBrowserControls target={AGENT_BROWSER} controlled={controlled} exists={exists || Boolean(frame)} agentName="Eaon" />
      </div>
      <LiveBrowserStage target={AGENT_BROWSER} frame={frame} latest={latest} working={working} controlled={controlled} agentName="Eaon" />
      <LiveBrowserSteps steps={steps} />
    </div>
  )
}
