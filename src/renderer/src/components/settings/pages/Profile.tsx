import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, Copy, Download, Pencil, Share } from 'lucide-react'
import type { UsageDay, UsageSummary, UsageTool } from '@shared/usage'
import type { Chat, Settings } from '@shared/types'
import { useApp } from '../../../state/store'
import { Modal } from '../../ui'
import { ProviderMark } from '../../composer/ProviderMark'
import { TOOL_LABEL, toolMark } from './usageTools'
import '../../../styles/profile.css'

/**
 * Settings → Profile: a year of coding activity on one page — tokens, the
 * busiest day, prompts and streaks, the activity calendar, what you use most
 * (tool, effort, hour, project, skills) and which models — and a card of it
 * to share. Everything is read on this computer: Eaon's own usage ledger and
 * the coding CLIs' logs (Settings → Usage), and Eaon's chats.
 */

type Profile = Settings['profile']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const COLORS = ['#5bbf6a', '#4f8cff', '#e0703c', '#a66cf0', '#e5b33b', '#e0567a', '#2fb5b0', '#8a8f98']

/** "1.8m", "12.4k", "980". */
function short(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}b`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}
const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`
const initials = (name: string): string =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || 'E'
const hourName = (h: number): string => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`

/** Quartiles of the active days, for five shades. */
function levels(calendar: UsageDay[]): number[] {
  const values = calendar.map((d) => d.tokens).filter((v) => v > 0).sort((a, b) => a - b)
  const q = (p: number): number => values[Math.min(values.length - 1, Math.floor(p * values.length))] ?? 0
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)]
  return calendar.map((d) => (d.tokens <= 0 ? 0 : d.tokens <= q1 ? 1 : d.tokens <= q2 ? 2 : d.tokens <= q3 ? 3 : 4))
}

interface Insights {
  prompts: number
  threads: number
  topTool: { tool: UsageTool; share: number } | null
  effort: string | null
  hour: number | null
  project: { name: string; prompts: number } | null
  skillsExplored: number
  skillsUsed: number
  plugins: { name: string; kind: 'Skill' | 'Agent'; count: number }[]
  models: { name: string; providerId: string; share: number }[]
}

type CliModel = { tool: string; model: string; tokens: number }

/** A model's logo: its maker's when the name says, else the tool it ran in. */
function modelMark(model: string, tool: string): string {
  if (/claude|opus|sonnet|haiku|fable/i.test(model)) return 'anthropic'
  if (/gpt|o\d|codex/i.test(model)) return 'openai'
  if (/gemini/i.test(model)) return 'google'
  if (/grok/i.test(model)) return 'xai'
  return `cli:${tool}`
}

function insightsOf(chats: Chat[], projects: { id: string; name: string }[], summary: UsageSummary | null, cliModels: CliModel[]): Insights {
  let prompts = 0
  const hours = new Array<number>(24).fill(0)
  const efforts = new Map<string, number>()
  const byProject = new Map<string, number>()
  const used = new Map<string, { kind: 'Skill' | 'Agent'; count: number }>()
  let skillsUsed = 0
  for (const chat of chats) {
    for (const message of chat.messages) {
      if (message.role === 'user') {
        prompts++
        hours[new Date(message.createdAt).getHours()]++
        if (chat.effort) efforts.set(chat.effort, (efforts.get(chat.effort) ?? 0) + 1)
        if (chat.projectId) byProject.set(chat.projectId, (byProject.get(chat.projectId) ?? 0) + 1)
        continue
      }
      for (const part of message.parts) {
        if (part.type !== 'tool') continue
        if (part.name === 'load_skill' && typeof part.input.name === 'string') {
          skillsUsed++
          const key = `Skill:${part.input.name}`
          used.set(key, { kind: 'Skill', count: (used.get(key)?.count ?? 0) + 1 })
        } else if (part.name === 'spawn_agents' && Array.isArray(part.input.agents)) {
          for (const agent of part.input.agents as { role?: unknown }[]) {
            if (typeof agent.role !== 'string') continue
            const key = `Agent:${agent.role}`
            used.set(key, { kind: 'Agent', count: (used.get(key)?.count ?? 0) + 1 })
          }
        }
      }
    }
  }
  const top = <T,>(map: Map<T, number>): [T, number] | null => [...map.entries()].sort((a, b) => b[1] - a[1])[0] ?? null
  const busiestHour = hours.some((h) => h > 0) ? hours.indexOf(Math.max(...hours)) : null
  const project = top(byProject)
  const tools = summary?.tools ?? []
  const toolTokens = tools.reduce((n, t) => n + t.tokens, 0)
  const topTool = tools[0] && toolTokens > 0 ? { tool: tools[0].tool, share: tools[0].tokens / toolTokens } : null
  const modelTokens = (m: UsageSummary['models'][number]): number => m.input + m.output + m.cacheRead + m.cacheWrite
  // Eaon's models and the coding CLIs', one row per model name.
  const merged = new Map<string, { name: string; providerId: string; tokens: number }>()
  for (const m of summary?.models ?? []) {
    const row = merged.get(m.modelId) ?? { name: m.modelId, providerId: m.providerId, tokens: 0 }
    row.tokens += modelTokens(m)
    merged.set(m.modelId, row)
  }
  for (const m of cliModels) {
    const row = merged.get(m.model) ?? { name: m.model, providerId: modelMark(m.model, m.tool), tokens: 0 }
    row.tokens += m.tokens
    merged.set(m.model, row)
  }
  const allModels = [...merged.values()]
  const modelTotal = allModels.reduce((n, m) => n + m.tokens, 0)
  return {
    prompts,
    threads: chats.length,
    topTool,
    effort: top(efforts)?.[0] ?? null,
    hour: busiestHour,
    project: project ? { name: projects.find((p) => p.id === project[0])?.name ?? 'A project', prompts: project[1] } : null,
    skillsExplored: [...used.keys()].filter((k) => k.startsWith('Skill:')).length,
    skillsUsed,
    plugins: [...used.entries()]
      .map(([key, v]) => ({ name: key.slice(key.indexOf(':') + 1), kind: v.kind, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    models: modelTotal
      ? allModels
          .map((m) => ({ name: m.name, providerId: m.providerId, share: m.tokens / modelTotal }))
          .sort((a, b) => b.share - a.share)
          .slice(0, 6)
      : []
  }
}

export function ProfilePage(): JSX.Element {
  const { settings, patchSettings, chats, projects } = useApp(
    useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings, chats: s.chats, projects: s.projects }))
  )
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [cliModels, setCliModels] = useState<CliModel[]>([])

  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.api.usage.summary(90).then((s) => live && setSummary(s))
      void window.api.providerUsage.cliModels().then((m) => live && setCliModels(m))
    }
    read()
    const off = window.api.usage.onChanged(read)
    return () => {
      live = false
      off()
    }
  }, [])

  const account = summary?.account
  const profile: Profile = {
    name: settings?.profile?.name || account?.name || account?.handle || 'You',
    handle: settings?.profile?.handle || account?.handle || '',
    color: settings?.profile?.color || COLORS[0]
  }
  const insights = useMemo(() => insightsOf(chats, projects, summary, cliModels), [chats, projects, summary, cliModels])
  const calendar = summary?.calendar ?? []
  const activity = summary?.activity
  const stats = {
    lifetime: activity?.allTime.tokens ?? 0,
    peak: activity?.busiest?.tokens ?? 0,
    prompts: insights.prompts,
    current: activity?.currentStreak ?? 0,
    longest: activity?.longestStreak ?? 0
  }

  return (
    <div className="profile">
      <div className="profile__actions">
        <button className="btn btn--sm" onClick={() => setSharing(true)} disabled={!summary}>
          <Share size={14} strokeWidth={2} />
          Share
        </button>
        <button className="btn btn--sm" onClick={() => setEditing(true)}>
          <Pencil size={14} strokeWidth={2} />
          Edit
        </button>
      </div>

      <header className="profile__head">
        <span className="profile__avatar" style={{ '--avatar': profile.color } as CSSProperties}>
          {initials(profile.name)}
        </span>
        <h1 className="profile__name">{profile.name}</h1>
        <div className="profile__sub">
          {profile.handle && <span>@{profile.handle}</span>}
          {profile.handle && <span aria-hidden="true">·</span>}
          <span className="profile__badge">Eaon</span>
        </div>
      </header>

      <div className="profile__stats">
        <Stat value={short(stats.lifetime)} label="Lifetime tokens" />
        <Stat value={short(stats.peak)} label="Peak day" />
        <Stat value={stats.prompts.toLocaleString()} label="Total prompts" />
        <Stat value={days(stats.current)} label="Current streak" />
        <Stat value={days(stats.longest)} label="Longest streak" />
      </div>
      <p className="profile__note">
        Token totals count Eaon and the coding CLIs whose logs are on this computer (Settings → Usage). Older history and unfinished turns may be
        incomplete.
      </p>

      <section className="profile__section">
        <h2>Activity</h2>
        <Heatmap calendar={calendar} />
      </section>

      <div className="profile__columns">
        <section className="profile__section">
          <h2>Activity insights</h2>
          <dl className="profile__facts">
            <Fact label="Most used provider">
              {insights.topTool ? (
                <>
                  {TOOL_LABEL[insights.topTool.tool]} · {Math.round(insights.topTool.share * 100)}% of tracked tokens
                </>
              ) : (
                '—'
              )}
            </Fact>
            <Fact label="Most used reasoning">{insights.effort ? insights.effort.charAt(0).toUpperCase() + insights.effort.slice(1) : '—'}</Fact>
            <Fact label="Most active hour">{insights.hour !== null ? hourName(insights.hour) : '—'}</Fact>
            <Fact label="Most worked project">
              {insights.project ? `${insights.project.name} · ${insights.project.prompts} ${insights.project.prompts === 1 ? 'prompt' : 'prompts'}` : '—'}
            </Fact>
            <Fact label="Skills explored">{insights.skillsExplored}</Fact>
            <Fact label="Total skills used">{insights.skillsUsed}</Fact>
            <Fact label="Total threads">{insights.threads}</Fact>
          </dl>
        </section>
        <section className="profile__section">
          <h2>Most used plugins</h2>
          {insights.plugins.length === 0 ? (
            <p className="profile__empty">No skills or agents used yet.</p>
          ) : (
            <dl className="profile__facts">
              {insights.plugins.map((p) => (
                <Fact key={`${p.kind}:${p.name}`} label={p.name}>
                  {p.kind} · {p.count}
                </Fact>
              ))}
            </dl>
          )}
        </section>
      </div>

      <section className="profile__section">
        <h2>Model usage</h2>
        <p className="profile__empty">Share of tracked tokens in the last 90 days.</p>
        {insights.models.length === 0 ? (
          <p className="profile__empty">No model use counted yet.</p>
        ) : (
          <div className="profile__models">
            {insights.models.map((m) => (
              <div key={`${m.providerId}/${m.name}`} className="profile__model">
                <div className="profile__model-top">
                  <ProviderMark providerId={m.providerId} size={16} />
                  <span className="profile__model-name">{m.name}</span>
                  <span className="profile__model-share">{(m.share * 100).toFixed(1).replace(/\.0$/, '')}%</span>
                </div>
                <div className="profile__model-bar">
                  <span style={{ width: `${Math.max(1.5, m.share * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <EditProfile
          profile={profile}
          onClose={() => setEditing(false)}
          onSave={(next) => {
            void patchSettings({ profile: next })
            setEditing(false)
          }}
        />
      )}
      {sharing && (
        <ShareCard
          profile={profile}
          calendar={calendar}
          stats={stats}
          top={insights.topTool ? { mark: toolMark(insights.topTool.tool), share: insights.topTool.share } : null}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div className="profile__stat">
      <span className="profile__stat-value">{value}</span>
      <span className="profile__stat-label">{label}</span>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="profile__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** A year of days, a column a week, Sunday on top; the month over its first week. */
function Heatmap({ calendar }: { calendar: UsageDay[] }): JSX.Element {
  const shade = useMemo(() => levels(calendar), [calendar])
  const weeks = Math.ceil(calendar.length / 7)
  const months: { week: number; label: string }[] = []
  let last = -1
  for (let w = 0; w < weeks; w++) {
    const first = calendar[w * 7]
    if (!first) continue
    const month = new Date(`${first.day}T12:00:00`).getMonth()
    if (month !== last) {
      // A month that only has the first week or two gives way to the next one's label.
      if (months.length && w - months[months.length - 1]!.week < 3) months.pop()
      months.push({ week: w, label: MONTHS[month]! })
      last = month
    }
  }
  return (
    <div className="profile-heat" style={{ '--weeks': weeks } as CSSProperties}>
      <div className="profile-heat__grid" role="img" aria-label="Activity over the last year">
        {calendar.map((d, i) => (
          <span
            key={d.day}
            className="profile-heat__cell"
            data-level={shade[i]}
            title={`${d.day}: ${d.tokens ? `${short(d.tokens)} tokens` : 'no activity'}`}
            style={{ gridColumn: Math.floor(i / 7) + 1, gridRow: (i % 7) + 1 }}
          />
        ))}
      </div>
      <div className="profile-heat__months" aria-hidden="true">
        {months.map((m) => (
          <span key={`${m.week}${m.label}`} style={{ gridColumn: m.week + 1 }}>
            {m.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function EditProfile({ profile, onClose, onSave }: { profile: Profile; onClose: () => void; onSave: (p: Profile) => void }): JSX.Element {
  const [draft, setDraft] = useState(profile)
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit profile"
      width={420}
      actions={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => onSave(draft)}>
            Save
          </button>
        </>
      }
    >
      <div className="profile-edit">
        <span className="profile__avatar profile__avatar--sm" style={{ '--avatar': draft.color } as CSSProperties}>
          {initials(draft.name)}
        </span>
        <label>
          <span>Name</span>
          <input className="input" value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label>
          <span>Handle</span>
          <input
            className="input"
            value={draft.handle}
            maxLength={32}
            placeholder="yourname"
            onChange={(e) => setDraft({ ...draft, handle: e.target.value.replace(/^@/, '').replace(/\s+/g, '') })}
          />
        </label>
        <div className="profile-edit__colors" role="radiogroup" aria-label="Avatar colour">
          {COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={draft.color === c}
              aria-label={c}
              style={{ background: c }}
              onClick={() => setDraft({ ...draft, color: c })}
            >
              {draft.color === c && <Check size={13} strokeWidth={3} />}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------- share card */

interface CardStats {
  lifetime: number
  peak: number
  current: number
  longest: number
}

const CARD_W = 960
const CARD_H = 420

/** The card, drawn: what the preview shows is exactly what's copied or saved. */
function drawCard(canvas: HTMLCanvasElement, profile: Profile, calendar: UsageDay[], stats: CardStats, top: { share: number } | null): void {
  const scale = 2
  canvas.width = CARD_W * scale
  canvas.height = CARD_H * scale
  const g = canvas.getContext('2d')!
  g.scale(scale, scale)
  const font = getComputedStyle(document.body).fontFamily || 'system-ui'
  const accent = '#e0703c'

  g.fillStyle = '#ffffff'
  g.beginPath()
  g.roundRect(0, 0, CARD_W, CARD_H, 28)
  g.fill()

  // Who.
  g.fillStyle = profile.color
  g.beginPath()
  g.arc(78, 84, 34, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#ffffff'
  g.font = `600 22px ${font}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(initials(profile.name), 78, 85)
  g.textAlign = 'left'
  g.textBaseline = 'alphabetic'
  g.fillStyle = '#111111'
  g.font = `500 24px ${font}`
  g.fillText(profile.name, 128, profile.handle ? 80 : 92)
  if (profile.handle) {
    g.fillStyle = '#8a8a8a'
    g.font = `400 16px ${font}`
    g.fillText(`@${profile.handle}`, 128, 106)
  }
  g.fillStyle = '#111111'
  g.font = `600 20px ${font}`
  g.textAlign = 'right'
  g.fillText('Eaon', CARD_W - 44, 90)
  g.textAlign = 'left'

  // The year.
  const shade = levels(calendar)
  const colors = ['#f0f0f0', '#f8d2bf', '#f1a882', '#e88452', accent]
  const weeks = Math.max(1, Math.ceil(calendar.length / 7))
  const gap = 3
  const size = (CARD_W - 88 - (weeks - 1) * gap) / weeks
  calendar.forEach((_, i) => {
    g.fillStyle = colors[shade[i] ?? 0]!
    g.beginPath()
    g.roundRect(44 + Math.floor(i / 7) * (size + gap), 150 + (i % 7) * (size + gap), size, size, 3)
    g.fill()
  })

  // The numbers.
  const cells: [string, string][] = [
    [short(stats.lifetime), 'lifetime tokens'],
    [short(stats.peak), 'peak day'],
    [days(stats.current), 'current streak'],
    [days(stats.longest), 'longest streak'],
    [top ? `${Math.round(top.share * 100)}%` : '—', 'top provider · tracked tokens']
  ]
  const col = (CARD_W - 88) / cells.length
  cells.forEach(([value, label], i) => {
    const x = 44 + i * col
    g.fillStyle = '#111111'
    g.font = `500 26px ${font}`
    g.fillText(value, x, 340)
    g.fillStyle = '#8a8a8a'
    g.font = `400 14px ${font}`
    g.fillText(label, x, 366)
  })
}

const canvasPng = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
  new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b))) : reject(new Error('No picture'))), 'image/png')
  )

function ShareCard({
  profile,
  calendar,
  stats,
  top,
  onClose
}: {
  profile: Profile
  calendar: UsageDay[]
  stats: CardStats
  top: { mark: string; share: number } | null
  onClose: () => void
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (canvas.current) drawCard(canvas.current, profile, calendar, stats, top)
  }, [profile, calendar, stats, top])

  const text = `${short(stats.lifetime)} tokens, a ${days(stats.longest)} longest streak, coding with Eaon.`
  const flash = (what: string): void => {
    setDone(what)
    setTimeout(() => setDone(null), 1600)
  }
  const actions: { id: string; label: string; icon: JSX.Element; run: () => void }[] = [
    {
      id: 'copy',
      label: 'Copy',
      icon: <Copy size={20} strokeWidth={2} />,
      run: () => void canvasPng(canvas.current!).then((png) => window.api.profileCard.copy(png)).then(() => flash('copy'))
    },
    {
      id: 'x',
      label: 'X',
      icon: <span className="share-glyph">𝕏</span>,
      run: () => void window.api.app.openExternal(`https://x.com/intent/post?text=${encodeURIComponent(text)}`)
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      icon: <span className="share-glyph share-glyph--in">in</span>,
      run: () => void window.api.app.openExternal(`https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`)
    },
    {
      id: 'reddit',
      label: 'Reddit',
      icon: <span className="share-glyph">r/</span>,
      run: () => void window.api.app.openExternal(`https://www.reddit.com/submit?title=${encodeURIComponent(text)}`)
    },
    {
      id: 'save',
      label: 'Save',
      icon: <Download size={20} strokeWidth={2} />,
      run: () =>
        void canvasPng(canvas.current!)
          .then((png) => window.api.profileCard.save(png, `${profile.handle || 'eaon'}-activity`))
          .then((path) => path && flash('save'))
    }
  ]

  return (
    <Modal open onClose={onClose} title="Share your activity" width={640}>
      <div className="share">
        <canvas ref={canvas} className="share__card" aria-label="Your activity card" />
        <div className="share__actions">
          {actions.map((a) => (
            <button key={a.id} className="share__action" onClick={a.run}>
              <span className="share__circle">{done === a.id ? <Check size={20} strokeWidth={2.4} /> : a.icon}</span>
              <span>{done === a.id ? (a.id === 'copy' ? 'Copied' : 'Saved') : a.label}</span>
            </button>
          ))}
        </div>
        <p className="share__hint">X, LinkedIn and Reddit open with a line of text; copy or save the card to attach it.</p>
      </div>
    </Modal>
  )
}
