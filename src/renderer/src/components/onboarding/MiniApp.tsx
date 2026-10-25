import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { ArrowUp, AtSign, Boxes, Check, Clock3, GitPullRequest, Globe, LibraryBig, ListTodo, MessagesSquare, Mic, Plus, Settings as SettingsIcon, SquarePen, SquareTerminal } from 'lucide-react'
import { WorkersGlyph } from '../ModeSwitch'
import { ToknMark } from '../account/ToknAccount'

/**
 * A small Eaon window beside the setup. It's drawn with the app's own tokens
 * and most of its own classes (the mode switch, the composer, nav rows), so
 * it re-themes with the app and looks like what the person is about to use.
 * Each step shows a scene in it: Chat answering a question, Workers running,
 * two coding agents in the ADE, a Tokn profile, the model list. On the last
 * step it grows to fill the window and hands over to the real thing.
 *
 * It is drawn at a fixed size (W × H) and scaled to fit, so its proportions
 * stay those of a window and its text keeps its real metrics.
 */

export type Scene = 'chat' | 'workers' | 'ade' | 'tokn' | 'models' | 'home'

const W = 840
const H = 540

const ICON = { size: 15, strokeWidth: 1.9 } as const

/** Settings → Appearance → Reduce motion, or the system's. Scenes jump to their last frame. */
export const reduceMotion = (): boolean => document.body.dataset.reduceMotion === 'on'

/**
 * How many of `marks` (ms from mount, ascending) have passed. Frame-driven
 * rather than a timeout each, so a hundred keystrokes cost one loop, and it
 * only renders when the count changes.
 */
function useTimeline(marks: readonly number[]): number {
  const [passed, setPassed] = useState(0)
  useEffect(() => {
    if (reduceMotion()) {
      setPassed(marks.length)
      return
    }
    setPassed(0)
    const start = performance.now()
    let frame = 0
    const tick = (): void => {
      const now = performance.now() - start
      let i = 0
      while (i < marks.length && marks[i] <= now) i++
      setPassed(i)
      if (i < marks.length) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [marks])
  return passed
}

/** A number that runs up to `to`, fast then settling, like a stat loading in. */
function useCountUp(to: number, duration = 1100, delay = 250): number {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (reduceMotion()) {
      setValue(to)
      return
    }
    const start = performance.now() + delay
    let frame = 0
    const tick = (): void => {
      const t = Math.min(1, Math.max(0, (performance.now() - start) / duration))
      setValue(to * (1 - Math.pow(1 - t, 4)))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [to, duration, delay])
  return value
}

/** Steady pseudo-random numbers, so a scene plays the same way every time. */
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

/** Keystroke times for `text`: quicker inside a word, a beat longer after a space. */
function typing(text: string, from: number, seed: number): number[] {
  const random = seeded(seed)
  const marks: number[] = []
  let t = from
  for (const ch of text) {
    t += 26 + random() * 38 + (ch === ' ' ? 30 : 0)
    marks.push(t)
  }
  return marks
}

interface Props {
  scene: Scene
  /** Tokn: who's signed in, if anyone. */
  account?: { name?: string; handle: string } | null
  /** Models: the names of providers that are ready to use. */
  ready?: string[]
}

export const MiniApp = forwardRef<HTMLDivElement, Props>(function MiniApp({ scene, account = null, ready = [] }, ref) {
  const box = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(0.6)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => setScale(el.clientWidth / W)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const mode: 'chat' | 'workers' | 'ade' = scene === 'workers' ? 'workers' : scene === 'ade' ? 'ade' : 'chat'

  return (
    <div
      ref={(el) => {
        box.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      }}
      className="mini"
      aria-hidden="true"
    >
      <div className="mini__screen" style={{ width: W, height: H, transform: `scale(${scale})` }}>
        <aside className="mini__side">
          <div className="mini__panel">
            <div className="mini__chrome">
              {window.api.platform === 'darwin' && (
                <span className="mini__lights">
                  <span />
                  <span />
                  <span />
                </span>
              )}
            </div>
            <div key={mode} className="mini__nav">
              <SideNav mode={mode} scene={scene} />
            </div>
          </div>
        </aside>
        <div className="mini__main">
          <header className="mini__top">
            <div className="mode-switch">
              {(
                [
                  ['chat', 'Chat', <MessagesSquare key="c" size={15} strokeWidth={2} />],
                  ['workers', 'Workers', <WorkersGlyph key="w" size={15} strokeWidth={2} />],
                  ['ade', 'ADE', <SquareTerminal key="a" size={15} strokeWidth={2} />]
                ] as const
              ).map(([id, label, icon]) => (
                <span key={id} className="mode-switch__option" data-active={mode === id || undefined}>
                  {icon}
                  <span className="mode-switch__label">{label}</span>
                </span>
              ))}
            </div>
          </header>
          <div key={scene} className="mini__view">
            {scene === 'chat' && <ChatScene />}
            {scene === 'workers' && <WorkersScene />}
            {scene === 'ade' && <AdeScene />}
            {scene === 'tokn' && <ToknScene account={account} />}
            {scene === 'models' && <ModelsScene ready={ready} />}
            {scene === 'home' && <Home caret />}
          </div>
        </div>
      </div>
    </div>
  )
})

/* ---- The sidebar ---- */

function Nav({ icon, label, active }: { icon: ReactNode; label: string; active?: boolean }): JSX.Element {
  return (
    <span className="nav-item" data-active={active || undefined}>
      <span className="nav-item__icon">{icon}</span>
      <span className="nav-item__label">{label}</span>
    </span>
  )
}

function SideNav({ mode, scene }: { mode: 'chat' | 'workers' | 'ade'; scene: Scene }): JSX.Element {
  if (mode === 'workers') {
    return (
      <>
        <Nav icon={<Plus {...ICON} />} label="New worker" />
        <Nav icon={<Clock3 {...ICON} />} label="Automations" />
        <Nav icon={<SettingsIcon {...ICON} />} label="Settings" />
        <span className="mini__group">Workers</span>
        <Nav icon={<span className="mini__dot" data-state="busy" />} label="Inbox triage" active />
        <Nav icon={<span className="mini__dot" data-state="new" />} label="Competitor watch" />
        <Nav icon={<span className="mini__dot" />} label="Weekly metrics" />
      </>
    )
  }
  if (mode === 'ade') {
    return (
      <>
        <Nav icon={<SquarePen {...ICON} />} label="New session" />
        <Nav icon={<GitPullRequest {...ICON} />} label="Pull requests" />
        <Nav icon={<ListTodo {...ICON} />} label="Linear" />
        <Nav icon={<SettingsIcon {...ICON} />} label="Settings" />
        <span className="mini__group">Sessions</span>
        <Nav icon={<SquareTerminal {...ICON} />} label="eaon-desktop" active />
        <Nav icon={<SquareTerminal {...ICON} />} label="website" />
      </>
    )
  }
  return (
    <>
      <Nav icon={<SquarePen {...ICON} />} label="New chat" />
      <Nav icon={<Boxes {...ICON} />} label="Models" />
      <Nav icon={<LibraryBig {...ICON} />} label="Library" />
      <Nav icon={<AtSign {...ICON} />} label="Plugins" />
      <Nav icon={<SettingsIcon {...ICON} />} label="Settings" active={scene === 'tokn'} />
      <span className="mini__group">Chats</span>
      {scene === 'chat' && <Recent />}
      <span className="mini__recent">Trip ideas for Lisbon</span>
      <span className="mini__recent">Why is CI flaky on Linux</span>
      <span className="mini__recent">Summarise the Q3 notes</span>
    </>
  )
}

/* ---- Chat ---- */

const PROMPT = 'Find a quiet café near me with fast Wi‑Fi and outlets'
const ANSWER = [
  'Three close by that suit a few hours of work:',
  '1. Little Fern, 4 min walk. Outlets at every table.',
  '2. Common Grounds. Quiet upstairs room, open till 9.',
  '3. Hatch Coffee. Fastest Wi‑Fi, busy after 2pm.'
]

/** The chat's script, as times from the scene's start. */
const CHAT = (() => {
  const keys = typing(PROMPT, 700, 11)
  const sent = keys[keys.length - 1] + 420
  const searching = sent + 380
  const searched = searching + 1300
  const random = seeded(5)
  const words: number[] = []
  let t = searched + 220
  for (const line of ANSWER) {
    for (let i = 0; i < line.split(' ').length; i++) {
      t += 28 + random() * 46
      words.push(t)
    }
    t += 90
  }
  const recent = t + 300
  return { keys, sent, searching, searched, words, recent, end: recent }
})()
const CHAT_MARKS = [...CHAT.keys, CHAT.sent, CHAT.searching, CHAT.searched, ...CHAT.words, CHAT.recent]

/** How long Chat takes to play through, for the welcome's cycle. */
export const CHAT_LENGTH = CHAT.end + 1600

/** The conversation's new row in Chats, sliding in once the answer is done. */
function Recent(): JSX.Element | null {
  const passed = useTimeline(useMemo(() => [CHAT.recent], []))
  return passed ? <span className="mini__recent mini__recent--new">Quiet café with good Wi‑Fi</span> : null
}

function ChatScene(): JSX.Element {
  const passed = useTimeline(CHAT_MARKS)
  const typed = Math.min(passed, CHAT.keys.length)
  const at = (t: number): boolean => passed > CHAT_MARKS.indexOf(t)
  const sent = at(CHAT.sent)
  const searching = at(CHAT.searching)
  const searched = at(CHAT.searched)
  const streamed = Math.max(0, passed - (CHAT.keys.length + 3))
  const streaming = searched && streamed < CHAT.words.length

  let left = streamed
  const lines = ANSWER.map((line) => {
    const words = line.split(' ')
    const shown = words.slice(0, Math.max(0, left))
    left -= words.length
    return shown.join(' ')
  }).filter(Boolean)

  return (
    <div className="mini-chat" data-sent={sent || undefined}>
      <h1 className="home__title mini-chat__title">What can I help with?</h1>
      {sent && (
        <div className="mini-chat__thread">
          <div className="msg--user mini-chat__bubble">{PROMPT}</div>
          {searching && (
            <div className="mini-chat__step" data-done={searched || undefined}>
              <Globe size={13} strokeWidth={2} />
              <span>{searched ? 'Searched the web · 6 results' : 'Searching the web for cafés nearby'}</span>
            </div>
          )}
          {lines.length > 0 && (
            <div className="msg--assistant mini-chat__answer">
              {lines.map((line, i) => (
                <p key={i}>
                  {line}
                  {streaming && i === lines.length - 1 && <span className="mini__caret" />}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      <Composer text={[...PROMPT].slice(0, typed).join('')} sending={sent} caret={!sent} />
      <Chips hidden={typed > 0} />
    </div>
  )
}

function Composer({ text, sending, caret, model = 'Claude Sonnet 5.5', menu }: { text: string; sending?: boolean; caret?: boolean; model?: string; menu?: ReactNode }): JSX.Element {
  return (
    <div className="composer mini-composer">
      <div className="mini-composer__input" data-empty={!text || undefined}>
        {sending ? '' : text || 'Ask anything, or give Eaon a task'}
        {caret && <span className="mini__caret" />}
      </div>
      <div className="composer__toolbar">
        <span className="composer__round">
          <Plus size={18} strokeWidth={1.9} />
        </span>
        <div className="composer__spacer" />
        <span className="chip chip--model" data-open={menu ? true : undefined}>
          <span className="chip__model">{model}</span>
        </span>
        <span className="composer__round">
          <Mic size={16} strokeWidth={1.9} />
        </span>
        <span className="send" data-ready={(text && !sending) || undefined}>
          <ArrowUp size={16} strokeWidth={2.2} />
        </span>
      </div>
      {menu}
    </div>
  )
}

function Chips({ hidden }: { hidden?: boolean }): JSX.Element {
  return (
    <div className="mini-chat__chips" data-hidden={hidden || undefined}>
      {['Research', 'Organize files', 'Build an app', 'Use my browser'].map((label, i) => (
        <span key={label} className="suggestion-chip" style={{ '--i': i } as CSSProperties}>
          {label}
        </span>
      ))}
    </div>
  )
}

/** Chat's first page, waiting for something to be typed. */
function Home({ caret, menu, model }: { caret?: boolean; menu?: ReactNode; model?: string }): JSX.Element {
  return (
    // With the model list open the composer sits low, as in a chat, so the list has room above it.
    <div className="mini-chat" data-low={menu ? true : undefined}>
      <h1 className="home__title mini-chat__title">What can I help with?</h1>
      <Composer text="" caret={caret} menu={menu} model={model} />
      <Chips />
    </div>
  )
}

/* ---- Workers ---- */

const INBOX = ['Reading 14 new emails', 'Sorting newsletters and receipts', 'Drafting 3 replies']
const WORKERS_MARKS = [900, 2000, 3100, 4100]
export const WORKERS_LENGTH = 5600

function WorkersScene(): JSX.Element {
  const passed = useTimeline(WORKERS_MARKS)
  const done = passed >= WORKERS_MARKS.length
  const step = Math.min(passed, INBOX.length - 1)
  return (
    <div className="mini-workers">
      <div className="mini-page__head">
        <span className="mini-page__title">Workers</span>
        <span className="mini-page__sub">3 workers · 1 running</span>
      </div>
      <div className="mini-worker" data-state={done ? 'done' : 'busy'} style={{ '--i': 0 } as CSSProperties}>
        <div className="mini-worker__row">
          <span className="mini-worker__name">Inbox triage</span>
          <span className="mini-worker__when">Weekdays at 8:00</span>
        </div>
        <div className="mini-worker__status">
          {done ? <Check size={13} strokeWidth={2.4} /> : <span className="mini__spinner" />}
          <span key={done ? 'done' : step} className="mini-worker__text">
            {done ? 'Done · 3 drafts are waiting for you' : `${INBOX[step]}…`}
          </span>
        </div>
        <div className="mini-worker__bar">
          <span style={{ transform: `scaleX(${done ? 1 : (passed + 0.4) / WORKERS_MARKS.length})` }} />
        </div>
      </div>
      <div className="mini-worker" style={{ '--i': 1 } as CSSProperties}>
        <div className="mini-worker__row">
          <span className="mini-worker__name">
            Competitor watch <span className="mini__dot" data-state="new" />
          </span>
          <span className="mini-worker__when">Every 6 hours</span>
        </div>
        <div className="mini-worker__status mini-worker__status--quiet">Last run 2 hours ago · 2 pricing changes found</div>
      </div>
      <div className="mini-worker" style={{ '--i': 2 } as CSSProperties}>
        <div className="mini-worker__row">
          <span className="mini-worker__name">Weekly metrics</span>
          <span className="mini-worker__when">Mondays at 9:00</span>
        </div>
        <div className="mini-worker__status mini-worker__status--quiet">Next run in 3 days</div>
      </div>
    </div>
  )
}

/* ---- ADE ---- */

interface Line {
  text: string
  tone?: 'dim' | 'add' | 'ok'
}

const CLAUDE: { prompt: string; lines: Line[] } = {
  prompt: 'add a dark mode toggle to settings',
  lines: [
    { text: '⏺ Read src/settings/General.tsx', tone: 'dim' },
    { text: '⏺ Update src/lib/theme.ts' },
    { text: '   +24 −3', tone: 'add' },
    { text: '⏺ Bash npm test', tone: 'dim' },
    { text: '   48 passed', tone: 'add' },
    { text: '✓ Added the toggle under Appearance.', tone: 'ok' }
  ]
}
const CODEX: { prompt: string; lines: Line[] } = {
  prompt: 'write tests for the date parser',
  lines: [
    { text: '• Explored src/lib/dates.ts', tone: 'dim' },
    { text: '• Added test/dates.test.ts' },
    { text: '   +61', tone: 'add' },
    { text: '• Ran vitest', tone: 'dim' },
    { text: '   12 passed', tone: 'add' },
    { text: '✓ Done in 41s', tone: 'ok' }
  ]
}

function paneMarks(pane: { prompt: string; lines: Line[] }, from: number, seed: number): number[] {
  const keys = typing(pane.prompt, from, seed)
  const random = seeded(seed + 3)
  const marks = [...keys]
  let t = keys[keys.length - 1] + 500
  for (let i = 0; i < pane.lines.length; i++) {
    t += 260 + random() * 520
    marks.push(t)
  }
  return marks
}
const CLAUDE_MARKS = paneMarks(CLAUDE, 500, 17)
const CODEX_MARKS = paneMarks(CODEX, 1300, 29)
export const ADE_LENGTH = Math.max(CLAUDE_MARKS[CLAUDE_MARKS.length - 1], CODEX_MARKS[CODEX_MARKS.length - 1]) + 1800

function AdeScene(): JSX.Element {
  return (
    <div className="mini-ade">
      <div className="mini-ade__head">
        <span className="mini-ade__repo">eaon-desktop</span>
        <span className="mini-ade__branch">main</span>
      </div>
      <div className="mini-ade__panes">
        <Terminal name="Claude Code" pane={CLAUDE} marks={CLAUDE_MARKS} />
        <Terminal name="Codex" pane={CODEX} marks={CODEX_MARKS} />
      </div>
    </div>
  )
}

function Terminal({ name, pane, marks }: { name: string; pane: { prompt: string; lines: Line[] }; marks: number[] }): JSX.Element {
  const passed = useTimeline(marks)
  const typed = Math.min(passed, pane.prompt.length)
  const shown = Math.max(0, passed - pane.prompt.length)
  const working = typed === pane.prompt.length && shown < pane.lines.length
  return (
    <div className="mini-term">
      <div className="mini-term__title">
        <span className="mini__dot" data-state={working ? 'busy' : shown === pane.lines.length ? 'done' : undefined} />
        {name}
      </div>
      <div className="mini-term__body">
        <div className="mini-term__prompt">
          <span className="mini-term__chevron">›</span> {pane.prompt.slice(0, typed)}
          {typed < pane.prompt.length && <span className="mini__caret" />}
        </div>
        {pane.lines.slice(0, shown).map((line, i) => (
          <div key={i} className="mini-term__line" data-tone={line.tone}>
            {line.text}
          </div>
        ))}
        {working && <div className="mini-term__line mini-term__working">✻ Working…</div>}
      </div>
    </div>
  )
}

/* ---- Tokn ---- */

function ToknScene({ account }: { account: { name?: string; handle: string } | null }): JSX.Element {
  const agents = useCountUp(128)
  const streak = useCountUp(12)
  const tokens = useCountUp(4.2, 1300)
  const levels = useMemo(() => {
    const random = seeded(7)
    const weeks = 30
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const recent = i / (weeks * 7)
      const r = random()
      return r < 0.35 - recent * 0.2 ? 0 : Math.min(4, 1 + Math.floor(r * 3 + recent * 2))
    })
  }, [])
  const name = account ? account.name || account.handle : 'Your name'
  return (
    <div className="mini-tokn">
      <div className="mini-tokn__card">
        <div className="mini-tokn__who">
          <span className="mini-tokn__avatar">{account ? name.trim()[0]?.toUpperCase() : <ToknMark size={26} />}</span>
          <span className="mini-tokn__names">
            <span className="mini-tokn__name">{name}</span>
            <span className="mini-tokn__handle">@{account?.handle ?? 'you'} · toknhq.com</span>
          </span>
        </div>
        <div className="mini-tokn__stats">
          <Stat label="Agents" value={account ? '—' : Math.round(agents).toString()} />
          <Stat label="Streak" value={account ? '—' : `${Math.round(streak)}d`} />
          <Stat label="Tokens" value={account ? '—' : `${tokens.toFixed(1)}M`} />
        </div>
        <div className="mini-tokn__grid" data-filled={!account || undefined}>
          {levels.map((level, i) => (
            <span key={i} data-level={level} style={{ '--d': `${Math.floor(i / 7) * 16 + (i % 7) * 10}ms` } as CSSProperties} />
          ))}
        </div>
        <svg className="mini-tokn__chart" viewBox="0 0 240 48" preserveAspectRatio="none">
          <path className="mini-tokn__area" d="M0 44 L20 40 L40 41 L60 30 L80 34 L100 22 L120 27 L140 14 L160 20 L180 9 L200 16 L220 6 L240 11 L240 48 L0 48 Z" />
          <path className="mini-tokn__line" pathLength={1} d="M0 44 L20 40 L40 41 L60 30 L80 34 L100 22 L120 27 L140 14 L160 20 L180 9 L200 16 L220 6 L240 11" />
        </svg>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="mini-tokn__stat">
      <span className="mini-tokn__label">{label}</span>
      <span className="mini-tokn__value">{value}</span>
    </span>
  )
}

/* ---- Models ---- */

const MODEL_GROUPS: { label: string; rows: string[] }[] = [
  { label: 'Accounts', rows: ['ChatGPT', 'OpenRouter'] },
  { label: 'API keys', rows: ['Anthropic', 'OpenAI'] },
  { label: 'On this computer', rows: ['Ollama'] }
]
const MODEL_ROWS = MODEL_GROUPS.flatMap((g) => g.rows)
// The highlight walks down the list, as it does with the arrow keys.
const MODELS_MARKS = MODEL_ROWS.map((_, i) => 700 + i * 520)

function ModelsScene({ ready }: { ready: string[] }): JSX.Element {
  const passed = useTimeline(MODELS_MARKS)
  const isReady = (row: string): boolean => ready.some((name) => name.toLowerCase().includes(row.toLowerCase()) || row.toLowerCase().includes(name.toLowerCase()))
  const first = ready[0]
  let index = -1
  const menu = (
    <div className="mini-menu">
      {MODEL_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="menu__label">{group.label}</div>
          {group.rows.map((row) => {
            index++
            return (
              <div key={row} className="menu__item" data-highlight={(!reduceMotion() && index === passed - 1) || undefined}>
                <span className="mini-menu__name">{row}</span>
                {isReady(row) ? (
                  <span className="mini-menu__ready">
                    <Check size={13} strokeWidth={2.4} />
                    Ready
                  </span>
                ) : (
                  <span className="mini-menu__hint">Connect</span>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
  return <Home menu={menu} model={first ?? 'Choose a model'} />
}
