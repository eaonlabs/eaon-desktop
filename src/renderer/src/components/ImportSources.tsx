import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { AGENT_APP_NAMES, type AgentAppId } from '@shared/agentApps'
import { folderName } from '@shared/adeSessions'
import type { ImportAppId } from '@shared/importApps'
import { scriptsBox, sessionBox, type AgentAppsState } from './AgentAppsImport'
import type { ImportState } from './ImportServers'
import conductorLogo from '../assets/agent-apps/conductor.png'
import orcaLogo from '../assets/agent-apps/orca.png'
import paradevLogo from '../assets/agent-apps/paradev.png'
import claudeSquadLogo from '../assets/agent-apps/claude-squad.png'
import t3codeLogo from '../assets/agent-apps/t3code.png'
import synaraLogo from '../assets/agent-apps/synara.png'
import crystalLogo from '../assets/agent-apps/crystal.png'
import vscodeLogo from '../assets/agent-apps/vscode.png'
import windsurfLogo from '../assets/agent-apps/windsurf.svg'
import claudeLogo from '../assets/providers/claude.webp'
import cursorLogo from '../assets/providers/cursor.svg'
import geminiCliLogo from '../assets/providers/geminicli.svg'

/**
 * What can come over from other apps, as one plain list: a row per app with
 * its logo, what it has in a few words ("3 sessions and their chats") and a
 * box for all of it. Choose opens the app's things by name, to bring only
 * some. No folders, branches or commands: those are in Settings for anyone
 * who wants them.
 *
 * Fed by either or both scans: the agent apps' sessions and scripts
 * (AgentAppsImport.tsx) and other apps' MCP servers (ImportServers.tsx).
 */

const AGENT_LOGOS: Record<AgentAppId, string> = {
  conductor: conductorLogo,
  orca: orcaLogo,
  superset: paradevLogo,
  'claude-squad': claudeSquadLogo,
  t3code: t3codeLogo,
  synara: synaraLogo,
  crystal: crystalLogo
}

const TOOL_LOGOS: Record<ImportAppId, string> = {
  'claude-desktop': claudeLogo,
  cursor: cursorLogo,
  windsurf: windsurfLogo,
  vscode: vscodeLogo,
  'gemini-cli': geminiCliLogo
}

interface Item {
  box: string
  label: string
  /** Where it goes or what it is, in a word or two. */
  note?: string
  /** In Eaon already: shown ticked, can't be unticked. */
  done: boolean
  picked: boolean
}

interface Source {
  id: string
  name: string
  logo: string
  /** "3 sessions and their chats · commands for 1 project". */
  summary: string
  items: Item[]
  pick: (boxes: string[], on: boolean) => void
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** An app's things shown at once under Choose; more scroll, with soft edges (.sources__items is that tall). */
const ITEMS_SHOWN = 6

function agentSources(state: AgentAppsState): Source[] {
  return (state.apps ?? []).map((app) => {
    const sessions = app.sessions.map((s) => ({
      box: sessionBox(s),
      label: s.title || folderName(s.cwd),
      note: s.project && s.project !== s.cwd ? folderName(s.project) : undefined,
      done: s.already,
      picked: state.picked.has(sessionBox(s))
    }))
    const scripts = app.scripts.map((s) => ({
      box: scriptsBox(s),
      label: `Commands for ${folderName(s.project)}`,
      note: 'setup and run',
      done: state.kept.has(scriptsBox(s)),
      picked: state.picked.has(scriptsBox(s))
    }))
    const chats = app.sessions.some((s) => s.resume)
    const parts = [
      app.sessions.length ? `${plural(app.sessions.length, 'session')}${chats ? (app.sessions.length === 1 ? ' and its chat' : ' and their chats') : ''}` : '',
      app.scripts.length ? `commands for ${plural(app.scripts.length, 'project')}` : ''
    ].filter(Boolean)
    return {
      id: app.id,
      name: AGENT_APP_NAMES[app.id],
      logo: AGENT_LOGOS[app.id],
      summary: parts.join(' · '),
      items: [...sessions, ...scripts],
      pick: state.pick
    }
  })
}

function toolSources(state: ImportState): Source[] {
  return (state.apps ?? [])
    .filter((app) => app.servers.length > 0)
    .map((app) => ({
      id: `tools:${app.id}`,
      name: app.name,
      logo: TOOL_LOGOS[app.id],
      summary: `${plural(app.servers.length, 'connected tool')} (MCP)`,
      items: app.servers.map((server) => ({ box: server.key, label: server.name, done: server.duplicate, picked: state.picked.has(server.key) })),
      pick: state.pick
    }))
}

/** A box that can also be partly ticked (some of an app's things). */
function Box({ checked, mixed, disabled, onChange, label }: { checked: boolean; mixed?: boolean; disabled?: boolean; onChange: () => void; label: string }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(mixed)
  }, [mixed])
  return <input ref={ref} type="checkbox" className="sources__box" checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />
}

function SourceRow({ source }: { source: Source }): JSX.Element {
  const [open, setOpen] = useState(false)
  const choosable = source.items.filter((i) => !i.done)
  const picked = choosable.filter((i) => i.picked).length
  const all = choosable.length > 0 && picked === choosable.length
  const allDone = choosable.length === 0
  const setAll = (on: boolean): void => source.pick(choosable.map((i) => i.box), on)
  return (
    <li className="sources__app" data-open={open || undefined}>
      <div className="sources__row">
        <img className="sources__logo" src={source.logo} alt="" width={36} height={36} draggable={false} />
        <span className="sources__text">
          <span className="sources__name">{source.name}</span>
          <span className="sources__summary">{allDone ? 'In Eaon already' : source.summary}</span>
        </span>
        {source.items.length > 1 && !allDone && (
          <button type="button" className="sources__choose" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Done' : picked === choosable.length ? 'Choose' : `${picked} of ${choosable.length}`}
            <ChevronDown size={13} strokeWidth={2} />
          </button>
        )}
        {allDone ? (
          <span className="sources__done" aria-label="In Eaon already">
            <Check size={15} strokeWidth={2.4} />
          </span>
        ) : (
          <Box checked={all} mixed={picked > 0 && !all} onChange={() => setAll(!all)} label={`Import from ${source.name}`} />
        )}
      </div>
      {open && (
        <ul className={`sources__items${source.items.length > ITEMS_SHOWN ? ' edge-fade' : ''}`}>
          {source.items.map((item) => (
            <li key={item.box}>
              <label className="sources__item" data-done={item.done || undefined}>
                <span className="sources__item-label">{item.label}</span>
                {item.done ? <span className="sources__item-note">In Eaon</span> : item.note && <span className="sources__item-note">{item.note}</span>}
                <Box checked={item.done || item.picked} disabled={item.done} onChange={() => source.pick([item.box], !item.picked)} label={item.label} />
              </label>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function ImportSources({ work, tools }: { work?: AgentAppsState; tools?: ImportState }): JSX.Element {
  const sources = [...(work ? agentSources(work) : []), ...(tools ? toolSources(tools) : [])]
  const looking = (work && work.apps === null) || (tools && tools.apps === null)
  if (sources.length === 0) {
    return (
      <p className="sources__empty">
        {looking ? 'Looking in your other apps…' : 'Nothing to bring over from Conductor, Orca, Paradev, Claude Squad, T3 Code, Synara or Crystal on this computer.'}
      </p>
    )
  }
  return (
    <ul className="sources" aria-label="Apps to import from">
      {sources.map((source) => (
        <SourceRow key={source.id} source={source} />
      ))}
    </ul>
  )
}
