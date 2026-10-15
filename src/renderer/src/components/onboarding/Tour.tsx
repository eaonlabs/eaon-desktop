import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import { useApp } from '../../state/store'
import { useOnboarding } from './onboardingStore'

/**
 * The tour: a spotlight on one part of the app at a time, with a card that
 * says what it is. It moves between the tabs itself, so the person watches
 * rather than clicks. ← and → step through it, Esc ends it, and it can be
 * taken again from the Help menu.
 *
 * Each stop names its element by selector (and the text it must contain,
 * for one row of a list). One that isn't on screen, in a narrow window say,
 * shows its card in the middle instead of pointing at nothing.
 */

interface Stop {
  /** The tab the stop is in: Chat, Workers or ADE (their workspace ids). */
  workspace: 'work' | 'workers' | 'eaon-code'
  selector: string
  text?: string
  /** Where the card goes, if there's room. */
  side: 'top' | 'bottom' | 'left' | 'right'
  title: string
  body: string
}

const mod = (): string => (window.api.platform === 'darwin' ? '⌘' : 'Ctrl+')

const stops = (): Stop[] => [
  {
    workspace: 'work',
    selector: '.mode-switch',
    side: 'bottom',
    title: 'Three places to work',
    body: `Chat for questions and tasks, Workers for agents that keep going on their own, and the ADE for coding agents. ${mod()}1, ${mod()}2 and ${mod()}3 switch between them.`
  },
  {
    workspace: 'work',
    selector: '.main .composer',
    side: 'top',
    title: 'Ask, or hand over a task',
    body: 'Type a question or describe a task. Eaon can search the web, work with your files and use your browser when you let it. Attach files with +.'
  },
  {
    workspace: 'work',
    selector: '.main .chip--model',
    side: 'top',
    title: 'Pick a model',
    body: 'Switch models whenever you like, right from here. Accounts, API keys and local models all show up in this list.'
  },
  {
    workspace: 'work',
    selector: '.sidebar__body',
    side: 'right',
    title: 'Your chats',
    body: `New chats, projects and everything recent live here. Search sits at the top, and ${mod()}B hides the sidebar.`
  },
  {
    workspace: 'workers',
    selector: '.sidebar .nav-item',
    text: 'Automations',
    side: 'right',
    title: 'Automations',
    body: 'Run a prompt on its own: every morning, every few minutes, or on any cron schedule. Each run lands in Recents.'
  },
  {
    workspace: 'eaon-code',
    // "Choose folder…" on the ADE's first page; with a project open, its header.
    selector: '.main .code-home__cta, .main .code-header',
    side: 'bottom',
    title: 'The ADE',
    body: 'Open a project to run Claude Code, Codex and other agents side by side in real terminals. Review what they changed, comment on any line, and send the comments back.'
  },
  {
    workspace: 'eaon-code',
    selector: '.usage-pill',
    side: 'bottom',
    title: 'Your plan’s limits',
    body: 'How much of your Claude and Codex plans is left, and when it resets. Switch accounts from here when one runs low.'
  },
  {
    workspace: 'eaon-code',
    selector: '.sidebar .nav-item',
    text: 'Settings',
    side: 'right',
    title: 'Settings',
    body: `Your Tokn profile, Claude and Codex accounts, model providers and the rest. ${mod()}, opens it.`
  }
]

/** The stop's element: the first of its comma-separated selectors that is on screen, in the order written. */
function findTarget(stop: Stop): Element | null {
  for (const selector of stop.selector.split(',')) {
    for (const element of document.querySelectorAll(selector.trim())) {
      if (stop.text && !element.textContent?.includes(stop.text)) continue
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return element
    }
  }
  return null
}

const PAD = 8
const GAP = 14
const CARD_W = 320
const EDGE = 12

interface Placement {
  spot: { top: number; left: number; width: number; height: number } | null
  card: { top: number; left: number }
  side: Stop['side'] | 'center'
}

/** Where the spotlight and the card go for `rect`, keeping the card on screen. */
function place(rect: DOMRect | null, side: Stop['side'], cardHeight: number): Placement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!rect) return { spot: null, card: { top: (vh - cardHeight) / 2, left: (vw - CARD_W) / 2 }, side: 'center' }
  const spot = { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
  const fits = {
    bottom: spot.top + spot.height + GAP + cardHeight < vh - EDGE,
    top: spot.top - GAP - cardHeight > EDGE,
    right: spot.left + spot.width + GAP + CARD_W < vw - EDGE,
    left: spot.left - GAP - CARD_W > EDGE
  }
  const order: Stop['side'][] = [side, 'bottom', 'top', 'right', 'left']
  const chosen = order.find((s) => fits[s])
  const clampX = (x: number): number => Math.min(Math.max(x, EDGE), vw - CARD_W - EDGE)
  const clampY = (y: number): number => Math.min(Math.max(y, EDGE), vh - cardHeight - EDGE)
  const centreX = spot.left + spot.width / 2 - CARD_W / 2
  const centreY = spot.top + spot.height / 2 - cardHeight / 2
  switch (chosen) {
    case 'bottom':
      return { spot, card: { top: spot.top + spot.height + GAP, left: clampX(centreX) }, side: 'bottom' }
    case 'top':
      return { spot, card: { top: spot.top - GAP - cardHeight, left: clampX(centreX) }, side: 'top' }
    case 'right':
      return { spot, card: { top: clampY(centreY), left: spot.left + spot.width + GAP }, side: 'right' }
    case 'left':
      return { spot, card: { top: clampY(centreY), left: spot.left - GAP - CARD_W }, side: 'left' }
    default:
      // A target that fills the window (the ADE's main area): the card sits inside it.
      return { spot, card: { top: clampY(centreY), left: clampX(centreX) }, side: 'center' }
  }
}

export function Tour(): JSX.Element | null {
  const open = useOnboarding((s) => s.tourOpen)
  return open ? <TourOverlay /> : null
}

function TourOverlay(): JSX.Element {
  const endTour = useOnboarding((s) => s.endTour)
  const [list] = useState(stops)
  const [index, setIndex] = useState(0)
  const [layout, setLayout] = useState<Placement | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const stop = list[index]
  const last = index === list.length - 1

  // Into the stop's tab, then find its element once that tab has drawn.
  useEffect(() => {
    const app = useApp.getState()
    const target = app.workspaces.find((w) => w.id === stop.workspace)
    if (target && app.settings?.activeWorkspaceId !== target.id) app.setWorkspace(target.id)
    if (app.view !== 'chat') app.setView('chat')
  }, [stop])

  const measure = useCallback(() => {
    const element = findTarget(stop)
    setLayout(place(element?.getBoundingClientRect() ?? null, stop.side, card.current?.offsetHeight ?? 180))
  }, [stop])

  useLayoutEffect(() => {
    let frame = 0
    let tries = 0
    // The tab may take a few frames to draw its element; keep looking briefly, then settle for the middle.
    const look = (): void => {
      if (findTarget(stop) || tries++ > 40) measure()
      else frame = requestAnimationFrame(look)
    }
    look()
    const resize = new ResizeObserver(() => measure())
    resize.observe(document.body)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [stop, measure])

  const finish = useCallback(
    (how: 'done' | 'skipped') => {
      // Back where a first-time user starts.
      const app = useApp.getState()
      if (app.settings?.activeWorkspaceId !== 'work' && app.workspaces.some((w) => w.id === 'work')) app.setWorkspace('work')
      endTour(how)
    },
    [endTour]
  )
  const next = useCallback(() => (last ? finish('done') : setIndex((i) => i + 1)), [last, finish])
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish('skipped')
      else if (event.key === 'ArrowRight' || event.key === 'Enter') next()
      else if (event.key === 'ArrowLeft') back()
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [next, back, finish])

  const spot = layout?.spot
  return createPortal(
    <div className="tour" role="dialog" aria-modal="true" aria-label="Tour of Eaon">
      {/* Takes every click, so the tour can't be lost by clicking the app behind it. */}
      <div className="tour__catcher" data-dim={!spot || undefined} />
      {spot && (
        <div
          className="tour__spot"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height } as CSSProperties}
        />
      )}
      <div
        ref={card}
        key={index}
        className="tour__card"
        data-side={layout?.side ?? 'center'}
        data-ready={layout ? true : undefined}
        style={{ top: layout?.card.top ?? -9999, left: layout?.card.left ?? -9999, width: CARD_W }}
      >
        <div className="tour__head">
          <span className="tour__count">
            {index + 1} of {list.length}
          </span>
          <button type="button" className="icon-btn tour__close" aria-label="End the tour" onClick={() => finish('skipped')}>
            <X size={14} strokeWidth={2} />
          </button>
        </div>
        <h2 className="tour__title">{stop.title}</h2>
        <p className="tour__body">{stop.body}</p>
        <div className="tour__foot">
          <div className="tour__dots" aria-hidden="true">
            {list.map((_, i) => (
              <span key={i} data-on={i === index || undefined} />
            ))}
          </div>
          <div className="tour__buttons">
            {index > 0 && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={back} aria-label="Back">
                <ArrowLeft size={14} strokeWidth={2} />
              </button>
            )}
            <button type="button" className="btn btn--sm btn--primary" onClick={next} autoFocus>
              {last ? 'Done' : 'Next'}
              {!last && <ArrowRight size={14} strokeWidth={2} />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
