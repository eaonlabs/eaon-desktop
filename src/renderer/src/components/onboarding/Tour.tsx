import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import { WHATS_NEW_RELEASE } from '@shared/whatsNew'
import { shortcutLabel } from '../../lib/platform'
import { useApp } from '../../state/store'
import { useOnboarding, type TourKind } from './onboardingStore'

/**
 * The tours: a spotlight on one part of the app at a time, with a card that
 * says what it is. One shows the app to a fresh install; the other shows an
 * updated install what's new in this release. Each moves between the tabs
 * itself, so the person watches rather than clicks. ← and → step through it,
 * Esc ends it, and both can be taken again from Settings → General (and, on
 * a Mac, the Help menu).
 *
 * Each stop names its element by selector (and the text it must contain,
 * for one row of a list). One that isn't on screen, in a narrow window say,
 * or one with no selector, shows its card in the middle instead.
 */

interface Stop {
  /** The tab the stop is in: Chat, Workers or ADE (their workspace ids). */
  workspace: 'work' | 'workers' | 'eaon-code'
  selector?: string
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
    // The whole panel: New chat and search above, projects and chats in the list under them.
    selector: '.sidebar__panel',
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
    body: 'Run a prompt on its own: every morning, every few minutes, or on any cron schedule. Each run lands in the sidebar as a new chat.'
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
    // Rings or a bar, whichever Settings → Usage & limits shows.
    selector: '.usage-rings, .usage-pill',
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

/** What's new since 2026.6, for an install updated from it, tab by tab. */
const whatsNewStops = (): Stop[] => [
  {
    workspace: 'work',
    side: 'bottom',
    title: `What’s new in Eaon ${WHATS_NEW_RELEASE}`,
    body: 'A one-minute look at what has changed since 2026.6, tab by tab. You can take it again from Settings → General.'
  },
  {
    workspace: 'work',
    selector: '.main .chip--model',
    side: 'top',
    title: 'Free models with Eaon Lite',
    body: 'MiMo v2.6 Flash and Muse Spark are in the model picker under Eaon Lite, free for everyone. No key, no sign-in.'
  },
  {
    workspace: 'work',
    selector: '.main .composer-pill--permission',
    side: 'top',
    title: 'A new message box',
    body: 'Choose here how much Eaon may do without asking. Approvals now show just above the box, and you can paste a screenshot straight in.'
  },
  {
    workspace: 'work',
    selector: '.main .composer-pill--project, .main .ws-card',
    side: 'top',
    title: 'Work in a project',
    body: 'Pick a folder and the chat becomes a coding session in that project, listed under Projects. The switches at the top right open a terminal under the chat, and a dock beside it with the files, a browser and what the agent changed.'
  },
  {
    // In Chat, where its switch is always at the top right: the ADE's shows only with a project open.
    workspace: 'work',
    selector: '.main .panel-toggles [aria-label="Dock"], .dock',
    side: 'bottom',
    title: 'A dock beside your agents',
    body: `The dock at the top right, beside a chat and beside an ADE session's terminals, shows a page in the browser (${shortcutLabel('⇧⌘B')}), the files, the diff and the pull request. Design Mode sends what you point at to an agent, and in the ADE, Hand off passes a stuck agent's work to another.`
  },
  {
    workspace: 'workers',
    selector: '.sidebar .nav-item',
    text: 'New worker',
    side: 'right',
    title: 'Workers that keep going for hours',
    body: 'Give a worker a goal and an end time and it keeps at it, woken when a background job ends or a page it watches changes. Teach one a task by doing it in its browser.'
  },
  {
    workspace: 'workers',
    selector: '.sidebar .nav-item',
    text: 'Automations',
    side: 'right',
    title: 'Automations',
    body: 'Scheduled is now Automations, with cron schedules: @daily, every few minutes or any pattern, in your time zone, with the next runs spelled out.'
  },
  {
    workspace: 'workers',
    selector: '.sidebar .nav-item',
    text: 'Settings',
    side: 'right',
    title: 'A worker computer, and more chat apps',
    body: 'Settings → Workers → Worker computer moves your workers to a computer you leave on, like a Raspberry Pi, so they keep going while this one sleeps. They now answer in Slack, Matrix, Mattermost and Zulip too.'
  },
  {
    workspace: 'eaon-code',
    selector: '.usage-rings, .usage-pill',
    side: 'bottom',
    title: 'Plan limits, up top',
    body: 'How much is left on your Claude Code, Codex, Cursor, Copilot and other plans, and when each resets. Settings → Usage & limits has the details.'
  },
  {
    workspace: 'eaon-code',
    selector: '.sidebar .nav-item',
    text: 'Settings',
    side: 'right',
    title: 'And in Settings',
    body: `See-through windows and seven new app icons in Appearance, Eaon Remote for using Eaon from a browser, and dictation: hold ${window.api.platform === 'darwin' ? 'Right Option' : 'Right Alt'} to speak into a terminal.`
  }
]

/** The stop's element: the first of its comma-separated selectors that is on screen, in the order written. */
function findTarget(stop: Stop): Element | null {
  if (!stop.selector) return null
  for (const selector of stop.selector.split(',')) {
    for (const element of document.querySelectorAll(selector.trim())) {
      // The setup's little window draws the same parts; it may still be fading out.
      if (element.closest('.onboarding')) continue
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
  spot: { top: number; left: number; width: number; height: number; radius: number } | null
  card: { top: number; left: number }
  side: Stop['side'] | 'center'
}

/** Where the spotlight and the card go for `target`, keeping the card on screen. */
function place(target: Element | null, side: Stop['side'], cardHeight: number): Placement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!target) return { spot: null, card: { top: (vh - cardHeight) / 2, left: (vw - CARD_W) / 2 }, side: 'center' }
  const rect = target.getBoundingClientRect()
  // The hole follows the element's own corners, PAD further out, so a pill stays a pill.
  const own = Number.parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0
  const radius = Math.min(own + PAD, (rect.height + PAD * 2) / 2)
  const spot = { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, radius }
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
  const tour = useOnboarding((s) => s.tour)
  const startTour = useOnboarding((s) => s.startTour)
  // An install updated from an earlier release, past the setup: what's new, once, on its own.
  const whatsNewDue = useApp((s) => Boolean(s.settings) && s.settings?.onboarding.setup !== 'pending' && s.settings?.onboarding.whatsNew === null)
  useEffect(() => {
    if (whatsNewDue) startTour('whatsNew')
  }, [whatsNewDue, startTour])
  return open ? <TourOverlay key={tour} tour={tour} /> : null
}

function TourOverlay({ tour }: { tour: TourKind }): JSX.Element {
  const endTour = useOnboarding((s) => s.endTour)
  const [list] = useState(tour === 'whatsNew' ? whatsNewStops : stops)
  const [index, setIndex] = useState(0)
  const [layout, setLayout] = useState<Placement | null>(null)
  // The card glides from stop to stop, but lands at the first one without sliding in from nowhere.
  const [placed, setPlaced] = useState(false)
  // Only a move to another stop glides. The page settling under a stop (a tab
  // finishing loading, the window resizing) puts the card where it belongs at
  // once, so Next is never a moving target.
  const [gliding, setGliding] = useState(false)
  // The stop the card was last placed for: until it is this one, the card is still on its way.
  const [placedFor, setPlacedFor] = useState<Stop | null>(null)
  const [leaving, setLeaving] = useState(false)
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
    setLayout(place(findTarget(stop), stop.side, card.current?.offsetHeight ?? 180))
    setPlacedFor(stop)
  }, [stop])

  useEffect(() => {
    if (!placed) return
    setGliding(true)
    const timer = window.setTimeout(() => setGliding(false), 900)
    return () => window.clearTimeout(timer)
    // Each new stop, once the first has been placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  useEffect(() => {
    if (!layout || placed) return
    const frame = requestAnimationFrame(() => setPlaced(true))
    return () => cancelAnimationFrame(frame)
  }, [layout, placed])

  useLayoutEffect(() => {
    let frame = 0
    let tries = 0
    // The tab may take a few frames to draw its element; keep looking briefly, then settle for the middle.
    const look = (): void => {
      if (!stop.selector || findTarget(stop) || tries++ > 40) measure()
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
      setLeaving(true)
      // A short fade, then back where a first-time user starts.
      window.setTimeout(() => {
        const app = useApp.getState()
        if (app.settings?.activeWorkspaceId !== 'work' && app.workspaces.some((w) => w.id === 'work')) app.setWorkspace('work')
        endTour(how)
      }, 180)
    },
    [endTour]
  )
  const next = useCallback(() => (last ? finish('done') : setIndex((i) => i + 1)), [last, finish])
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (leaving) return
      if (event.key === 'Escape') finish('skipped')
      else if (event.key === 'ArrowRight' || event.key === 'Enter') next()
      else if (event.key === 'ArrowLeft') back()
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [next, back, finish, leaving])

  const spot = layout?.spot
  return createPortal(
    <div className="tour" data-leaving={leaving || undefined} role="dialog" aria-modal="true" aria-label={tour === 'whatsNew' ? `What’s new in Eaon ${WHATS_NEW_RELEASE}` : 'Tour of Eaon'}>
      {/* Takes every click, so the tour can't be lost by clicking the app behind it. */}
      <div className="tour__catcher" data-dim={!spot || undefined} />
      {spot && (
        <div
          className="tour__spot"
          data-placed={placed || undefined}
          data-gliding={gliding || undefined}
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height, borderRadius: spot.radius } as CSSProperties}
        />
      )}
      <div
        ref={card}
        className="tour__card"
        data-side={layout?.side ?? 'center'}
        data-ready={layout ? true : undefined}
        data-placed={placed || undefined}
        data-gliding={gliding || undefined}
        // Where it belongs for this stop, and done moving: what the end-to-end tests wait for before pressing Next.
        data-settled={(placedFor === stop && !gliding) || undefined}
        style={{ transform: layout ? `translate3d(${Math.round(layout.card.left)}px, ${Math.round(layout.card.top)}px, 0)` : 'translate3d(-9999px, -9999px, 0)', width: CARD_W }}
      >
        <div key={index} className="tour__content">
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
        </div>
        <div className="tour__foot">
          <div className="tour__progress" aria-hidden="true">
            <span style={{ transform: `scaleX(${(index + 1) / list.length})` }} />
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
