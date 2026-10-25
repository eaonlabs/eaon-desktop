import { useEffect, useRef, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Bug,
  Check,
  ChevronDown,
  Copy,
  FlaskConical,
  FolderClosed,
  Hammer,
  Pencil,
  Play,
  Plus,
  SquareTerminal,
  Trash2,
  Wand2
} from 'lucide-react'
import type { OpenTarget, ProjectScript, ScriptIcon } from '@shared/chatCode'
import { scriptIcon } from '@shared/chatCode'
import { MenuItem, MenuSeparator, Modal, Popover, useDisclosure } from '../ui'
import { notify } from '../Notice'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { preferredTarget, useChatCode } from './chatCodeStore'

/** Chat's coding keys, while a Chat page is on screen. */
export function CodeKeys(): null {
  useCodeKeys()
  return null
}

/**
 * ⌘J shows and hides the terminal; ⇧⌘F finds across the project. Not over a
 * dialog, and not from the in-app browser, which keeps its own keys.
 */
function useCodeKeys(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.browser') || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (key === 'j' && !event.shiftKey) {
        event.preventDefault()
        useChatCode.getState().toggleDrawer()
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault()
        useChatCode.getState().setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/* ------------------------------------------------------------- open in */

export function TargetIcon({ target, size = 15 }: { target: OpenTarget; size?: number }): JSX.Element {
  // The app's own icon, as the system draws it; a little larger, since app icons leave a margin.
  if (target.icon) return <img className="target-app" src={target.icon} alt="" draggable={false} style={{ width: size + 3, height: size + 3 }} />
  if (target.kind === 'files') return <FolderClosed size={size} strokeWidth={1.8} />
  if (target.kind === 'terminal') return <SquareTerminal size={size} strokeWidth={1.8} />
  // No icon from the system: an editor's initials on a tile.
  const letters = target.label
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
  return (
    <span className="target-tile" data-target={target.id} style={{ width: size + 1, height: size + 1 }} aria-hidden>
      {letters}
    </span>
  )
}

/** Open: the folder in an editor, a terminal app or the file manager. A split button in the top bar, a split row in the workspace card. */
/**
 * `row`: a line of the workspace card. `icon`: the icon alone, for the dock's
 * file bar. `file`: the file to open rather than the folder (an editor opens
 * it in the folder's window). `folder`: another folder than Chat's (the ADE's).
 */
export function OpenInButton({ row = false, icon = false, file, folder: other }: { row?: boolean; icon?: boolean; file?: string; folder?: string | null } = {}): JSX.Element | null {
  const { chatFolder, targets, preferred, loadTargets, setPreferred } = useChatCode(
    useShallow((s) => ({ chatFolder: s.folder, targets: s.targets, preferred: s.preferred, loadTargets: s.loadTargets, setPreferred: s.setPreferred }))
  )
  const folder = other === undefined ? chatFolder : other
  const anchor = useRef<HTMLDivElement>(null)
  const menu = useDisclosure()
  useEffect(() => {
    void loadTargets()
  }, [loadTargets])
  const current = preferredTarget(targets, preferred)
  if (!folder || !current) return null

  const open = (target: OpenTarget): void => {
    setPreferred(target.id)
    void window.api.chatCode.openIn(folder, target.id, file).catch((e: unknown) => notify(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), 'error'))
  }
  const groups: { label: string; kind: OpenTarget['kind'] }[] = [
    { label: 'Editors', kind: 'editor' },
    { label: 'Terminals', kind: 'terminal' },
    { label: 'Folder', kind: 'files' }
  ]

  return (
    <>
      {row ? (
        <div ref={anchor} className="ws-row ws-row--split" data-open={menu.open || undefined}>
          <button type="button" className="ws-row__main" title={`Open this folder in ${current.label}`} onClick={() => open(current)}>
            <span className="ws-row__icon">
              <TargetIcon target={current} size={15} />
            </span>
            <span className="ws-row__label">Open in {current.label}</span>
          </button>
          <button type="button" className="ws-row__more" aria-label="Open in…" title="Open in…" onClick={menu.toggle}>
            <ChevronDown size={14} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <div ref={anchor} className="split-btn" data-icon={icon || undefined} data-open={menu.open || undefined}>
          <button type="button" className="split-btn__main" title={`Open ${file ? 'this file' : 'this folder'} in ${current.label}`} onClick={() => open(current)}>
            <TargetIcon target={current} size={14} />
            {!icon && <span>Open</span>}
          </button>
          <button type="button" className="split-btn__more" aria-label="Open in…" title="Open in…" onClick={menu.toggle}>
            <ChevronDown size={13} strokeWidth={2} />
          </button>
        </div>
      )}
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={230}>
        {groups.map((group) => {
          const list = (targets ?? []).filter((t) => t.kind === group.kind)
          if (list.length === 0) return null
          return (
            <div key={group.kind}>
              <div className="menu__label">{group.label}</div>
              {list.map((target) => (
                <MenuItem
                  key={target.id}
                  icon={<TargetIcon target={target} />}
                  title={target.label}
                  checked={target.id === current.id}
                  onClick={() => {
                    menu.close()
                    open(target)
                  }}
                />
              ))}
            </div>
          )
        })}
        <MenuSeparator />
        <MenuItem
          icon={<Copy size={15} strokeWidth={1.8} />}
          title="Copy path"
          onClick={() => {
            menu.close()
            void copyText(file ?? folder).then((ok) => notify(ok ? 'Path copied' : CLIPBOARD_FAILED, ok ? 'done' : 'error'))
          }}
        />
      </Popover>
    </>
  )
}

/* ------------------------------------------------------------- scripts */

export function ScriptGlyph({ icon, size = 14 }: { icon: ScriptIcon; size?: number }): JSX.Element {
  const props = { size, strokeWidth: 1.9 }
  switch (icon) {
    case 'test':
      return <FlaskConical {...props} />
    case 'build':
      return <Hammer {...props} />
    case 'lint':
      return <Wand2 {...props} />
    case 'debug':
      return <Bug {...props} />
    case 'terminal':
      return <SquareTerminal {...props} />
    default:
      return <Play {...props} />
  }
}

/** Runs a script in its own tab of the terminal drawer; again, in the same tab. */
export function runScript(script: ProjectScript): void {
  const code = useChatCode.getState()
  const existing = code.tabs.find((t) => t.scriptId === script.id && !t.dock)
  if (existing) code.closeTab(existing.id)
  code.newTab({ title: script.name, command: script.command, scriptId: script.id })
}

const LAST_SCRIPT_KEY = 'eaon.chatCode.lastScript'

/**
 * The project's scripts. In the top bar, a run button for the last one used,
 * shown once there is one to run; in the workspace card a row; on the
 * terminal's bar an icon, always, where a first script is added.
 */
export function ScriptsButton({ place = 'header' }: { place?: 'header' | 'card' | 'tool' }): JSX.Element | null {
  const scripts = useChatCode((s) => s.scripts)
  const anchor = useRef<HTMLDivElement>(null)
  const menu = useDisclosure()
  const [editing, setEditing] = useState<ProjectScript | 'new' | null>(null)
  const [last, setLast] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_SCRIPT_KEY)
    } catch {
      return null
    }
  })
  const primary = scripts.find((s) => s.id === last) ?? scripts[0] ?? null
  const run = (script: ProjectScript): void => {
    setLast(script.id)
    try {
      localStorage.setItem(LAST_SCRIPT_KEY, script.id)
    } catch {
      /* remembered for this session */
    }
    runScript(script)
  }

  if (place === 'header' && !primary) return null

  return (
    <>
      {place === 'card' ? (
        primary ? (
          <div ref={anchor} className="ws-row ws-row--split" data-open={menu.open || undefined}>
            <button type="button" className="ws-row__main" title={`Run ${primary.command}`} onClick={() => run(primary)}>
              <span className="ws-row__icon">
                <ScriptGlyph icon={primary.icon} size={15} />
              </span>
              <span className="ws-row__label">Run {primary.name}</span>
            </button>
            <button type="button" className="ws-row__more" aria-label="Scripts" title="Scripts" onClick={menu.toggle}>
              <ChevronDown size={14} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <div ref={anchor} className="ws-row-wrap">
            <button type="button" className="ws-row" title="A command to run in one click: dev server, tests, a build…" onClick={() => setEditing('new')}>
              <span className="ws-row__icon">
                <Plus size={15} strokeWidth={1.8} />
              </span>
              <span className="ws-row__label">Add project script</span>
            </button>
          </div>
        )
      ) : place === 'tool' ? (
        <div ref={anchor} className="term-tools__anchor">
          <button
            type="button"
            className="term-tools__btn"
            data-open={menu.open || undefined}
            aria-label={primary ? 'Scripts' : 'Add script'}
            title={primary ? 'Run one of this project’s scripts' : 'Add a command to run in one click: dev server, tests, a build…'}
            onClick={() => (primary ? menu.toggle() : setEditing('new'))}
          >
            <Play size={14} strokeWidth={1.9} />
          </button>
        </div>
      ) : primary ? (
        <div ref={anchor} className="split-btn" data-open={menu.open || undefined}>
          <button type="button" className="split-btn__main" title={`Run ${primary.command}`} onClick={() => run(primary)}>
            <ScriptGlyph icon={primary.icon} />
            <span className="split-btn__label">{primary.name}</span>
          </button>
          <button type="button" className="split-btn__more" aria-label="Scripts" title="Scripts" onClick={menu.toggle}>
            <ChevronDown size={13} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <div ref={anchor} className="split-btn split-btn--solo">
          <button type="button" className="split-btn__main" title="Add a command to run in one click: dev server, tests, a build…" onClick={() => setEditing('new')}>
            <Play size={14} strokeWidth={1.9} />
            <span>Add script</span>
          </button>
        </div>
      )}
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={260}>
        <div className="menu__label">Run</div>
        {scripts.map((script) => (
          <div key={script.id} className="script-row">
            <MenuItem
              icon={<ScriptGlyph icon={script.icon} size={15} />}
              title={script.name}
              description={script.command}
              onClick={() => {
                menu.close()
                run(script)
              }}
            />
            <button
              type="button"
              className="icon-btn script-row__edit"
              aria-label={`Edit ${script.name}`}
              title="Edit"
              onClick={() => {
                menu.close()
                setEditing(script)
              }}
            >
              <Pencil size={13} strokeWidth={1.9} />
            </button>
          </div>
        ))}
        <MenuSeparator />
        <MenuItem
          icon={<Plus size={15} strokeWidth={1.9} />}
          title="Add script…"
          onClick={() => {
            menu.close()
            setEditing('new')
          }}
        />
      </Popover>
      {editing && <ScriptDialog script={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

const ICONS: ScriptIcon[] = ['play', 'test', 'build', 'lint', 'debug', 'terminal']
const ICON_LABEL: Record<ScriptIcon, string> = { play: 'Run', test: 'Test', build: 'Build', lint: 'Lint', debug: 'Debug', terminal: 'Command' }

function ScriptDialog({ script, onClose }: { script: ProjectScript | null; onClose: () => void }): JSX.Element {
  const { scripts, suggestions, saveScripts, folder } = useChatCode(
    useShallow((s) => ({ scripts: s.scripts, suggestions: s.suggestions, saveScripts: s.saveScripts, folder: s.folder }))
  )
  const [name, setName] = useState(script?.name ?? '')
  const [command, setCommand] = useState(script?.command ?? '')
  const [icon, setIcon] = useState<ScriptIcon>(script?.icon ?? 'play')
  const [iconTouched, setIconTouched] = useState(Boolean(script))
  const offered = suggestions.filter((s) => !scripts.some((x) => x.command === s.command)).slice(0, 12)
  const valid = name.trim() && command.trim()

  const save = (): void => {
    if (!valid) return
    const next: ProjectScript = { id: script?.id ?? `s-${Date.now().toString(36)}`, name: name.trim(), command: command.trim(), icon }
    void saveScripts(script ? scripts.map((s) => (s.id === script.id ? next : s)) : [...scripts, next])
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={script ? 'Edit script' : 'Add a script'}
      width={460}
      actions={
        <>
          {script && (
            <button
              type="button"
              className="btn btn--ghost btn--danger"
              onClick={() => {
                void saveScripts(scripts.filter((s) => s.id !== script.id))
                onClose()
              }}
            >
              <Trash2 size={13} strokeWidth={2} />
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!valid} onClick={save}>
            {script ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <form
        className="script-form"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <p className="script-form__lede">Runs in the terminal under the chat, in {folder ? <code>{folder.split(/[\\/]/).pop()}</code> : 'the work folder'}.</p>
        {!script && offered.length > 0 && (
          <div className="script-form__suggest" role="group" aria-label="From this project">
            {offered.map((s) => (
              <button
                key={s.command}
                type="button"
                className="script-chip"
                onClick={() => {
                  setName(s.name)
                  setCommand(s.command)
                  setIcon(s.icon)
                }}
              >
                <ScriptGlyph icon={s.icon} size={12} />
                {s.command}
              </button>
            ))}
          </div>
        )}
        <label className="script-form__field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            autoFocus
            placeholder="Dev server"
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value)
              if (!iconTouched) setIcon(scriptIcon(e.target.value))
            }}
          />
        </label>
        <label className="script-form__field">
          <span>Command</span>
          <input className="input script-form__command" value={command} placeholder="npm run dev" spellCheck={false} onChange={(e) => setCommand(e.target.value)} />
        </label>
        <div className="script-form__field">
          <span>Icon</span>
          <div className="script-form__icons" role="radiogroup" aria-label="Icon">
            {ICONS.map((i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={icon === i}
                className="script-form__icon"
                title={ICON_LABEL[i]}
                onClick={() => {
                  setIcon(i)
                  setIconTouched(true)
                }}
              >
                <ScriptGlyph icon={i} size={15} />
                {icon === i && <Check size={10} strokeWidth={3} className="script-form__tick" />}
              </button>
            ))}
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

