import { useEffect, useRef, useState, type JSX } from 'react'
import { ExternalLink, Globe, Hand, MonitorPlay } from 'lucide-react'
import type { AgentBrowserFrame, AgentBrowserStep, BrowserInput, BrowserTarget } from '@shared/agentBrowser'

/**
 * An agent's browser, live: the page as it paints (the agent's own cursor
 * gliding to what it clicks is drawn into it), what it is doing now, and the
 * user taking over. In control, the picture is the page — clicks, scrolls
 * and keys go to it as real input — and the address bar takes an address;
 * the agent's next step waits until they hand it back.
 *
 * Used beside the chat (the chat agent's browser) and in a worker's dialog.
 */

const VERBS: Record<string, string> = {
  open: 'Opening',
  click: 'Clicking',
  type: 'Typing into',
  press: 'Pressing',
  scroll: 'Scrolling',
  back: 'Going back',
  read: 'Reading the page',
  find: 'Looking for',
  snapshot: 'Looking at the page',
  screenshot: 'Taking a screenshot',
  wait: 'Waiting for you to hand the browser back'
}

export function stepText(action: string, detail: string): string {
  const verb = VERBS[action] ?? action
  if (['read', 'snapshot', 'screenshot', 'back', 'wait'].includes(action)) return verb
  if (action === 'scroll') return `${verb} ${detail || 'down'}`
  return detail ? `${verb} ${detail}` : verb
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Frames, steps and control state for one browser, while `active`. Opening it starts the stream; closing stops it. */
export function useLiveBrowser(
  target: BrowserTarget,
  active: boolean
): { frame: AgentBrowserFrame | null; steps: AgentBrowserStep[]; working: boolean; controlled: boolean; exists: boolean } {
  const [frame, setFrame] = useState<AgentBrowserFrame | null>(null)
  const [steps, setSteps] = useState<AgentBrowserStep[]>([])
  const [working, setWorking] = useState(false)
  const [controlled, setControlled] = useState(false)
  const [exists, setExists] = useState(false)
  useEffect(() => {
    if (!active) return
    const api = window.api.agentBrowser
    let live = true
    void api.watch(true, target).then((status) => {
      if (!live) return
      setControlled(status.controlled)
      setExists(status.open)
    })
    const offFrame = api.onFrame((next) => {
      if (next.target !== target) return
      setFrame(next)
      setExists(true)
    })
    const offStep = api.onStep((step) => {
      if (step.target !== target) return
      setWorking(!step.done)
      if (!step.done) setSteps((current) => [...current, step].slice(-40))
    })
    const offStatus = api.onStatus((status) => {
      if (status.target !== target) return
      setControlled(status.controlled)
      setExists(status.open)
    })
    return () => {
      live = false
      offFrame()
      offStep()
      offStatus()
      void api.watch(false, target)
    }
  }, [target, active])
  return { frame, steps, working, controlled, exists }
}

/** Shortcut keys the page should get as an editing command rather than raw keys. */
const EDIT_KEYS: Record<string, Extract<BrowserInput, { type: 'edit' }>['command']> = {
  v: 'paste',
  c: 'copy',
  x: 'cut',
  a: 'selectAll',
  z: 'undo'
}
const PAGE_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

interface StageProps {
  target: BrowserTarget
  frame: AgentBrowserFrame | null
  latest: AgentBrowserStep | undefined
  working: boolean
  controlled: boolean
  agentName: string
}

/** The picture, and in control the page itself. */
export function LiveBrowserStage({ target, frame, latest, working, controlled, agentName }: StageProps): JSX.Element {
  const image = useRef<HTMLImageElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const lastMove = useRef(0)
  const api = window.api.agentBrowser

  /** A point on the picture → the page's own CSS pixels. */
  const pagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = image.current?.getBoundingClientRect()
    if (!rect || !frame || rect.width === 0 || rect.height === 0) return null
    return {
      x: ((clientX - rect.left) / rect.width) * frame.viewport.width,
      y: ((clientY - rect.top) / rect.height) * frame.viewport.height
    }
  }

  const sendInput = (event: BrowserInput): void => void api.input(event, target)

  // Wheel needs a non-passive listener to keep the panel itself from scrolling.
  useEffect(() => {
    const element = image.current
    if (!element || !controlled) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const point = pagePoint(event.clientX, event.clientY)
      if (point) sendInput({ type: 'mouseWheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  })

  useEffect(() => {
    if (controlled) stage.current?.focus()
  }, [controlled])

  const mouse = (type: 'mouseDown' | 'mouseUp' | 'mouseMove') => (event: React.MouseEvent) => {
    if (!controlled) return
    if (type === 'mouseMove') {
      const now = performance.now()
      if (now - lastMove.current < 33) return
      lastMove.current = now
    } else {
      event.preventDefault()
      stage.current?.focus()
    }
    const point = pagePoint(event.clientX, event.clientY)
    if (!point) return
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
    sendInput({ type, ...point, button, clickCount: type === 'mouseMove' ? 0 : Math.max(1, event.detail) })
  }

  const key = (event: React.KeyboardEvent): void => {
    if (!controlled) return
    const shortcut = event.metaKey || event.ctrlKey
    const modifiers = [event.shiftKey && 'shift', event.ctrlKey && 'control', event.altKey && 'alt', event.metaKey && 'meta'].filter(Boolean) as ('shift' | 'control' | 'alt' | 'meta')[]
    const edit = shortcut ? EDIT_KEYS[event.key.toLowerCase()] : undefined
    // A key the page takes must not also reach the app (Escape would close a dialog).
    if (edit) {
      event.preventDefault()
      event.stopPropagation()
      sendInput({ type: 'edit', command: edit === 'undo' && event.shiftKey ? 'redo' : edit })
      return
    }
    if (shortcut) return // leave the app's own shortcuts alone
    if (event.key.length === 1 || PAGE_KEYS.has(event.key) || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      sendInput({ type: 'key', key: event.key, modifiers })
    }
  }

  return (
    <div
      ref={stage}
      className="agent-browser__stage"
      data-working={(working && !controlled) || undefined}
      data-control={controlled || undefined}
      tabIndex={controlled ? 0 : -1}
      onKeyDown={key}
      aria-label={controlled ? 'The page — you are in control. Click, type and scroll here.' : undefined}
    >
      {frame ? (
        <img
          ref={image}
          className="agent-browser__frame"
          src={frame.image}
          alt={`${agentName} showing ${frame.title || frame.url}`}
          draggable={false}
          onMouseDown={mouse('mouseDown')}
          onMouseUp={mouse('mouseUp')}
          onMouseMove={mouse('mouseMove')}
          onContextMenu={(event) => controlled && event.preventDefault()}
        />
      ) : (
        <div className="agent-browser__empty">
          <MonitorPlay size={22} strokeWidth={1.6} />
          <span>When {agentName} opens a page in its own browser, you’ll see it here as it works.</span>
        </div>
      )}
      {controlled ? (
        <div className="agent-browser__now agent-browser__now--control">You’re in control. {agentName} waits until you hand it back.</div>
      ) : (
        latest && (
          <div className="agent-browser__now" data-done={!working || undefined}>
            {stepText(latest.action, latest.detail)}
          </div>
        )
      )}
    </div>
  )
}

/** Take over / hand back, and the real window for a site that needs it. */
export function LiveBrowserControls({ target, controlled, exists, agentName }: { target: BrowserTarget; controlled: boolean; exists: boolean; agentName: string }): JSX.Element {
  const api = window.api.agentBrowser
  return (
    <>
      {controlled ? (
        <button className="header-btn header-btn--primary" onClick={() => void api.control(false, target)} title={`Give the browser back to ${agentName}`}>
          <Hand size={14} strokeWidth={1.9} />
          <span>Hand back to {agentName}</span>
        </button>
      ) : (
        <button
          className="header-btn"
          disabled={!exists}
          onClick={() => void api.control(true, target)}
          title={exists ? `Use the browser yourself — to sign ${agentName} in, or help it past a step. It waits until you hand it back.` : 'Available once it has opened a page'}
        >
          <Hand size={14} strokeWidth={1.9} />
          <span>Take control</span>
        </button>
      )}
      <button className="icon-btn" disabled={!exists} onClick={() => void api.show(target)} aria-label="Open in a window" title="Open the real window">
        <ExternalLink size={14} strokeWidth={1.9} />
      </button>
    </>
  )
}

/** The address: shown while the agent drives, editable while the user does. */
export function LiveBrowserAddress({ target, frame, controlled }: { target: BrowserTarget; frame: AgentBrowserFrame | null; controlled: boolean }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    if (!controlled) setDraft(null)
  }, [controlled])
  if (controlled) {
    return (
      <form
        className="browser__url agent-browser__url"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft?.trim()) void window.api.agentBrowser.navigate(draft.trim(), target).then(() => setDraft(null))
        }}
      >
        <Globe size={13} strokeWidth={1.9} />
        <input
          className="agent-browser__url-input"
          value={draft ?? frame?.url ?? ''}
          spellCheck={false}
          aria-label="Address"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
    )
  }
  return (
    <div className="browser__url agent-browser__url" title={frame?.url}>
      <Globe size={13} strokeWidth={1.9} />
      <span className="agent-browser__url-text">{frame?.url ? hostOf(frame.url) : 'No page yet'}</span>
      {frame?.title && <span className="agent-browser__page-title">{frame.title}</span>}
    </div>
  )
}

/** The steps before the current one, newest first. */
export function LiveBrowserSteps({ steps }: { steps: AgentBrowserStep[] }): JSX.Element | null {
  if (steps.length < 2) return null
  return (
    <ol className="agent-browser__steps scroll" aria-label="Steps so far">
      {steps
        .slice(-12, -1)
        .reverse()
        .map((step) => (
          <li key={`${step.at}-${step.action}`}>
            <span className="agent-browser__step-time">{new Date(step.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
            <span className="agent-browser__step-text">{stepText(step.action, step.detail)}</span>
          </li>
        ))}
    </ol>
  )
}
