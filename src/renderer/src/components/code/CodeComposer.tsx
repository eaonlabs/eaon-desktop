import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowUp, CornerDownRight, Lightbulb, ListEnd, Network, Square, SquareTerminal, X } from 'lucide-react'
import { MenuItem, MenuSearch, MenuSeparator, Popover, useDisclosure } from '../ui'
import { BUILTIN_COMMANDS, useCode } from './codeStore'
import type { EaonModel, EaonSlashCommand, EaonThinkingLevel } from '@shared/eaonCode'

const THINKING_LABEL: Record<EaonThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

const SOURCE_LABEL: Record<EaonSlashCommand['source'], string> = {
  builtin: 'Eaon',
  extension: 'Extension',
  prompt: 'Prompt',
  skill: 'Skill'
}

export const modelLabel = (model: EaonModel | null | undefined): string => model?.name || model?.id || 'No model'

/**
 * The Code tab's composer.
 *
 * Enter sends. While the agent is working, Enter steers it (delivered after
 * the current tool calls, before its next step) and ⌥Enter queues a
 * follow-up for when it finishes — Eaon Code's own two queues, shown above
 * the box until they are delivered. Esc stops. `/` completes commands, and a
 * leading `!` runs a shell command whose output joins the context (`!!`
 * keeps it out), as in Eaon Code's terminal UI.
 */
export function CodeComposer({ variant }: { variant: 'home' | 'dock' }): JSX.Element {
  const { send, abort, running, awaiting, starting, draft, commands, queue, statuses, widgets, clearQueue } = useCode(
    useShallow((s) => ({
      send: s.send,
      abort: s.abort,
      running: s.transcript.running,
      awaiting: s.awaiting,
      starting: s.starting,
      draft: s.draft,
      commands: s.commands,
      queue: s.transcript.queue,
      statuses: s.transcript.statuses,
      widgets: s.transcript.widgets,
      clearQueue: s.clearQueue
    }))
  )
  const [text, setText] = useState('')
  const [selected, setSelected] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const busy = running || awaiting

  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 280)}px`
  }, [text])

  // A cleared queue or an extension's set_editor_text lands here.
  useEffect(() => {
    if (!draft) return
    const restored = useCode.getState().takeDraft()
    if (restored === null) return
    setText((current) => (current.trim() ? `${restored}\n\n${current}` : restored))
    textarea.current?.focus()
  }, [draft])

  useEffect(() => {
    if (variant === 'home') textarea.current?.focus()
  }, [variant])

  // `/` completion: only while the first word is still being typed.
  const slash = /^\/([\w:.-]*)$/.exec(text)
  const suggestions = useMemo(() => {
    if (!slash) return []
    const query = slash[1].toLowerCase()
    return [...BUILTIN_COMMANDS, ...commands]
      .filter((command) => command.name.toLowerCase().includes(query))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
      .slice(0, 8)
  }, [slash?.[1], commands]) // eslint-disable-line react-hooks/exhaustive-deps
  const showSuggestions = suggestions.length > 0 && dismissedFor !== text
  const activeIndex = Math.min(selected, suggestions.length - 1)

  const complete = (command: EaonSlashCommand): void => {
    setText(`/${command.name} `)
    setSelected(0)
    textarea.current?.focus()
  }

  const submit = (behavior?: 'followUp'): void => {
    if (!text.trim()) {
      if (busy) void abort()
      return
    }
    void send(text, behavior)
    setText('')
  }

  const shell = text.startsWith('!')
  const queued = [
    ...queue.steering.map((message) => ({ kind: 'steer' as const, message })),
    ...queue.followUp.map((message) => ({ kind: 'followUp' as const, message }))
  ]
  const statusLine = Object.entries(statuses)
  const widgetLines = Object.entries(widgets)

  return (
    <div className={`composer-stack code-composer ${variant === 'dock' ? 'composer-stack--chat' : ''}`}>
      {(queued.length > 0 || widgetLines.length > 0) && (
        <div className="code-queue">
          {widgetLines.map(([key, lines]) => (
            <pre key={key} className="code-queue__widget">
              {lines.join('\n')}
            </pre>
          ))}
          {queued.map((entry, index) => (
            <div key={`${entry.kind}-${index}`} className="code-queue__row">
              {entry.kind === 'steer' ? <CornerDownRight size={13} strokeWidth={2} /> : <ListEnd size={13} strokeWidth={2} />}
              <span className="code-queue__kind">{entry.kind === 'steer' ? 'Steer' : 'Follow-up'}</span>
              <span className="code-queue__text">{entry.message}</span>
            </div>
          ))}
          {queued.length > 0 && (
            <button className="code-queue__clear" onClick={() => void clearQueue()} title="Take queued messages back into the editor">
              <X size={12} strokeWidth={2.2} />
              Clear queue
            </button>
          )}
        </div>
      )}

      <div className="composer code-composer__box" data-shell={shell || undefined}>
        {showSuggestions && (
          <div className="code-slash" role="listbox">
            {suggestions.map((command, index) => (
              <button
                key={`${command.source}:${command.name}`}
                role="option"
                aria-selected={index === activeIndex}
                className="code-slash__item"
                data-active={index === activeIndex || undefined}
                onMouseEnter={() => setSelected(index)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  complete(command)
                }}
              >
                <span className="code-slash__name">/{command.name}</span>
                {command.description && <span className="code-slash__desc">{command.description}</span>}
                <span className="code-slash__source">{SOURCE_LABEL[command.source]}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          className="composer__input"
          rows={1}
          value={text}
          spellCheck={!shell}
          placeholder={
            starting
              ? 'Starting Eaon Code…'
              : busy
                ? 'Steer the agent · ⌥↵ queues a follow-up · Esc stops'
                : 'Ask Eaon Code to build, fix or explain · / for commands · ! for shell'
          }
          onChange={(e) => {
            setText(e.target.value)
            setSelected(0)
          }}
          onKeyDown={(e) => {
            if (showSuggestions) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setSelected((activeIndex + step + suggestions.length) % suggestions.length)
                return
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && suggestions[activeIndex]?.name !== slash?.[1])) {
                e.preventDefault()
                complete(suggestions[activeIndex])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setDismissedFor(text)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit(e.altKey && busy ? 'followUp' : undefined)
            } else if (e.key === 'Escape' && busy) {
              e.preventDefault()
              void abort()
            }
          }}
        />

        <div className="composer__toolbar">
          <ModePills />
          {shell && (
            <span className="code-shell-hint">
              <SquareTerminal size={13} strokeWidth={1.9} />
              {text.startsWith('!!') ? 'Shell · output kept out of context' : 'Shell · output goes into context'}
            </span>
          )}
          {!shell && statusLine.length > 0 && (
            <span className="code-status-line" title={statusLine.map(([, value]) => value).join(' · ')}>
              {statusLine.map(([, value]) => value).join(' · ')}
            </span>
          )}
          <div className="composer__spacer" />
          <ModelChip />
          <button
            className={`send ${busy && !text.trim() ? 'send--stop' : ''}`}
            disabled={!busy && !text.trim()}
            onClick={() => submit()}
            aria-label={busy && !text.trim() ? 'Stop' : busy ? 'Steer' : 'Send'}
            title={busy && !text.trim() ? 'Stop (Esc)' : busy ? 'Steer (↵) · follow-up (⌥↵)' : 'Send (↵)'}
          >
            {busy && !text.trim() ? (
              <Square size={11} strokeWidth={0} fill="currentColor" />
            ) : (
              <ArrowUp size={17} strokeWidth={2.2} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Plan and swarm. Hidden entirely until a session reports whether it has
 * them; an Eaon Code build without the RPC commands gets the pills greyed
 * with an explanation rather than toggles that silently do nothing.
 */
function ModePills(): JSX.Element | null {
  const { session, setMode } = useCode(useShallow((s) => ({ session: s.session, setMode: s.setMode })))
  const [explain, setExplain] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  if (!session) return null
  const supported = typeof session.planMode === 'boolean' && typeof session.swarmMode === 'boolean'

  return (
    <div ref={anchor} className="mode-pills code-modes" data-unsupported={!supported || undefined}>
      <button
        className="mode-pill"
        data-on={session.planMode || undefined}
        aria-pressed={session.planMode === true}
        onClick={() => (supported ? void setMode('plan', !session.planMode) : setExplain(true))}
        title={supported ? 'Plan mode: read-only exploration that ends in a plan. No edits until you turn it off.' : undefined}
      >
        <Lightbulb size={14} strokeWidth={1.9} />
        Plan
      </button>
      <button
        className="mode-pill"
        data-on={session.swarmMode || undefined}
        aria-pressed={session.swarmMode === true}
        onClick={() => (supported ? void setMode('swarm', !session.swarmMode) : setExplain(true))}
        title={supported ? 'Swarm mode: delegate work to 2–6 parallel sub-agents.' : undefined}
      >
        <Network size={14} strokeWidth={1.9} />
        Swarm
      </button>
      <Popover anchor={anchor} open={explain} onClose={() => setExplain(false)} placement="top-start" width={300}>
        <div className="code-explain">
          <strong>Update Eaon Code to use swarm and plan here</strong>
          <span>
            The installed Eaon Code does not accept plan and swarm over its RPC protocol, so the Code tab cannot switch
            them. They still work in the terminal with <code>/plan</code> and <code>/swarm</code>.
          </span>
        </div>
      </Popover>
    </div>
  )
}

/** Model and thinking level, as one chip like the Chat composer's. */
function ModelChip(): JSX.Element {
  const { session, models, thinkingLevels, setModel, setThinkingLevel } = useCode(
    useShallow((s) => ({
      session: s.session,
      models: s.models,
      thinkingLevels: s.thinkingLevels,
      setModel: s.setModel,
      setThinkingLevel: s.setThinkingLevel
    }))
  )
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const modelRow = useRef<HTMLDivElement>(null)
  const thinkingRow = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<'model' | 'thinking' | null>(null)
  const [query, setQuery] = useState('')

  const current = session?.model ?? null
  const levels = thinkingLevels.length > 0 ? thinkingLevels : (['off'] as EaonThinkingLevel[])
  const canThink = levels.some((level) => level !== 'off')
  const q = query.trim().toLowerCase()
  const filtered = q ? models.filter((m) => `${m.name ?? ''} ${m.id} ${m.provider}`.toLowerCase().includes(q)) : models
  const providers = [...new Set(filtered.map((m) => m.provider))]
  const close = (): void => {
    setSub(null)
    setQuery('')
    menu.close()
  }

  return (
    <>
      <button
        ref={anchor}
        className="chip chip--model"
        data-open={menu.open || undefined}
        onClick={menu.toggle}
        disabled={!session}
        title={current ? `${current.provider}/${current.id}` : 'Choose a model'}
      >
        <span className="chip__model">{modelLabel(current)}</span>
        {canThink && session && <span className="chip__effort">{THINKING_LABEL[session.thinkingLevel] ?? session.thinkingLevel}</span>}
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={close} placement="top-end" width={230}>
        <div ref={modelRow} onMouseEnter={() => setSub('model')}>
          <MenuItem title="Model" hint={modelLabel(current)} submenu open={sub === 'model'} onClick={() => setSub('model')} />
        </div>
        <div ref={thinkingRow} onMouseEnter={() => canThink && setSub('thinking')}>
          <MenuItem
            title="Thinking"
            hint={canThink && session ? THINKING_LABEL[session.thinkingLevel] : 'Not supported'}
            submenu={canThink}
            disabled={!canThink}
            open={sub === 'thinking'}
            onClick={() => canThink && setSub('thinking')}
          />
        </div>

        <Popover anchor={modelRow} open={sub === 'model'} onClose={() => setSub(null)} placement="right-start" width={280}>
          {models.length > 8 && <MenuSearch value={query} onChange={setQuery} placeholder="Search models" />}
          {models.length === 0 && (
            <div className="menu__empty">
              No models available. Share your API keys in Settings → Eaon Code, or run <code>/login</code> in a terminal.
            </div>
          )}
          {providers.map((provider, index) => (
            <div key={provider}>
              {index > 0 && <MenuSeparator />}
              <div className="menu__label">{provider}</div>
              {filtered
                .filter((m) => m.provider === provider)
                .map((model) => (
                  <MenuItem
                    key={`${model.provider}/${model.id}`}
                    title={modelLabel(model)}
                    checked={current?.provider === model.provider && current?.id === model.id}
                    onClick={() => {
                      void setModel(model)
                      close()
                    }}
                  />
                ))}
            </div>
          ))}
        </Popover>

        <Popover anchor={thinkingRow} open={sub === 'thinking'} onClose={() => setSub(null)} placement="right-start" width={200}>
          <div className="menu__label">Thinking</div>
          {levels.map((level) => (
            <MenuItem
              key={level}
              title={THINKING_LABEL[level] ?? level}
              checked={session?.thinkingLevel === level}
              onClick={() => {
                void setThinkingLevel(level)
                close()
              }}
            />
          ))}
        </Popover>
      </Popover>
    </>
  )
}
