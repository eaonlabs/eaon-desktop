import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import { Clock, FileCode2, Globe, LayoutGrid, Puzzle, Timer } from 'lucide-react'
import type { ClaudePluginParts, ModManifest, ModNote, ModTerminalColors } from '@shared/mods'
import { toolHost } from '@shared/mods'
import { highlight } from '../agent/highlight'
import { WorkerFace } from '../workers/WorkerFace'
import { AgentMark } from '../code/terminal/TerminalWorkspace'

/**
 * A mod's card picture, drawn from what it adds rather than from a
 * screenshot it ships: its theme's colours, its commands, its terminal, its
 * panes. So a card can't show something the mod doesn't do, and mods need
 * no image files.
 */
export function ModPreview({ manifest, claude = null, large = false }: { manifest: ModManifest; claude?: ClaudePluginParts | null; large?: boolean }): JSX.Element {
  const c = manifest.contributes
  let body: JSX.Element
  if (c.appThemes?.length) body = <AppThemePreview manifest={manifest} />
  else if (c.terminalThemes?.length) body = <TerminalPreview colors={c.terminalThemes[0].colors} names={c.terminalThemes.map((t) => t.name)} />
  else if (c.panels?.length) body = <PanelPreview manifest={manifest} />
  else if (c.workerTemplates?.length) body = <WorkersPreview manifest={manifest} />
  else if (c.sessionPresets?.length) body = <PresetPreview manifest={manifest} />
  else if (c.widgets?.length) body = <WidgetPreview manifest={manifest} />
  else if (c.tools?.length) body = <ToolsPreview manifest={manifest} />
  else if (c.snippets?.length) body = <SnippetPreview manifest={manifest} />
  else if (c.languages?.length) body = <LanguagePreview manifest={manifest} />
  else if (c.sounds) body = <SoundPreview notes={Object.values(c.sounds).flat()} />
  else if (c.claudePlugin || c.codex) body = <CliPreview manifest={manifest} claude={claude} />
  else if (c.commands?.length) body = <CommandsPreview manifest={manifest} />
  else if (c.instructions) body = <TextPreview label="Instructions" text={c.instructions} />
  else body = <div className="modp modp--plain"><Puzzle size={28} strokeWidth={1.5} /></div>
  return (
    <div className="mod-preview" data-large={large || undefined} aria-hidden>
      {body}
    </div>
  )
}

function AppThemePreview({ manifest }: { manifest: ModManifest }): JSX.Element {
  const theme = manifest.contributes.appThemes![0]
  return (
    <div className="modp modp--themes">
      {(['light', 'dark'] as const).map((mode) => {
        const tone = theme[mode]
        return (
          <div key={mode} className="modp-app" style={{ ['--p-bg' as string]: tone.background, ['--p-fg' as string]: tone.foreground, ['--p-accent' as string]: tone.accent } as CSSProperties}>
            <div className="modp-app__side">
              <i />
              <i />
              <i />
            </div>
            <div className="modp-app__main">
              <b>Aa</b>
              <i />
              <i className="short" />
              <span className="modp-app__button" />
            </div>
          </div>
        )
      })}
      {manifest.contributes.appThemes!.length > 1 && <span className="modp__more">+{manifest.contributes.appThemes!.length - 1}</span>}
    </div>
  )
}

const ANSI: (keyof ModTerminalColors)[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']

function TerminalPreview({ colors, names }: { colors: ModTerminalColors; names: string[] }): JSX.Element {
  return (
    <div className="modp modp--term" style={{ background: colors.background, color: colors.foreground }}>
      <div>
        <span style={{ color: colors.green }}>~/project</span> <span style={{ color: colors.blue }}>main</span> <span style={{ color: colors.brightBlack }}>$</span> npm test
      </div>
      <div>
        <span style={{ color: colors.green }}>✓</span> 42 passed <span style={{ color: colors.yellow }}>2 skipped</span>
      </div>
      <div className="modp-term__swatches">
        {ANSI.map((key) => (
          <i key={key} style={{ background: colors[key] }} />
        ))}
      </div>
      <span className="modp__caption" style={{ color: colors.brightBlack }}>
        {names.length > 1 ? `${names[0]} and ${names.length - 1} more` : names[0]}
      </span>
    </div>
  )
}

function CommandsPreview({ manifest }: { manifest: ModManifest }): JSX.Element {
  const commands = manifest.contributes.commands ?? []
  return (
    <div className="modp modp--menu">
      {commands.slice(0, 4).map((cmd) => (
        <div key={cmd.name} className="modp-row">
          <span className="modp-row__name">/{cmd.name}</span>
          <span className="modp-row__desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  )
}

function TextPreview({ label, text }: { label: string; text: string }): JSX.Element {
  return (
    <div className="modp modp--text">
      <span className="modp__label">{label}</span>
      <p>{text}</p>
    </div>
  )
}

function Code({ code, lang }: { code: string; lang: string }): JSX.Element {
  return (
    <pre className="modp-code">
      {highlight(code, lang).map((t, i) => (
        <span key={i} className={t.kind ? `tok-${t.kind}` : undefined}>
          {t.text}
        </span>
      ))}
    </pre>
  )
}

function SnippetPreview({ manifest }: { manifest: ModManifest }): JSX.Element {
  const snippet = manifest.contributes.snippets![0]
  return (
    <div className="modp modp--code">
      <span className="modp__label">
        {snippet.prefix} <kbd>Tab</kbd>
      </span>
      <Code code={snippet.body.replace('$0', '').split('\n').slice(0, 5).join('\n')} lang={snippet.languages[0]} />
    </div>
  )
}

function LanguagePreview({ manifest }: { manifest: ModManifest }): JSX.Element {
  const langs = manifest.contributes.languages!
  return (
    <div className="modp modp--langs">
      {langs.slice(0, 6).map((lang) => (
        <span key={lang.id} className="modp-lang">
          <FileCode2 size={12} strokeWidth={1.9} />
          {lang.name}
          <span className="modp-lang__ext">.{lang.aliases[0]}</span>
        </span>
      ))}
    </div>
  )
}

function PanelPreview({ manifest }: { manifest: ModManifest }): JSX.Element {
  const panel = manifest.contributes.panels![0]
  return (
    <div className="modp modp--panel">
      <div className="modp-panel__tabs">
        <span>Files</span>
        <span data-on>
          <Puzzle size={10} strokeWidth={2} /> {panel.title}
        </span>
      </div>
      <div className="modp-panel__body">
        <i />
        <i />
        <i className="short" />
      </div>
    </div>
  )
}

function WorkersPreview({ manifest }: { manifest: ModManifest }): JSX.Element {
  return (
    <div className="modp modp--workers">
      {manifest.contributes.workerTemplates!.slice(0, 3).map((t) => (
        <span key={t.id} className="modp-worker">
          <WorkerFace color={t.color} shape={t.shape} size={38} mood="neutral" />
          <span>{t.name}</span>
        </span>
      ))}
    </div>
  )
}

function PresetPreview({ manifest }: { manifest: ModManifest }): JSX.Element {
  const preset = manifest.contributes.sessionPresets![0]
  const cols = preset.panes.length <= 1 ? 1 : preset.panes.length <= 4 ? 2 : 3
  return (
    <div className="modp modp--grid" style={{ ['--cols' as string]: cols } as CSSProperties}>
      {preset.panes.slice(0, 6).map((pane, i) => (
        <span key={i} className="modp-pane">
          <AgentMark agent={pane.agent} size={12} />
          {pane.name ?? pane.agent}
        </span>
      ))}
      <span className="modp__caption">
        <LayoutGrid size={11} strokeWidth={2} /> {preset.name}
      </span>
    </div>
  )
}

function WidgetPreview({ manifest }: { manifest: ModManifest }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="modp modp--bar">
      {manifest.contributes.widgets!.map((w) => (
        <span key={w.id} className="mod-widget">
          {w.kind === 'clock' ? <Clock size={12} strokeWidth={1.9} /> : <Timer size={12} strokeWidth={1.9} />}
          <span className="mod-widget__label">{w.label}</span>
          <span className="mod-widget__value">
            {w.kind === 'clock'
              ? (() => {
                  try {
                    return new Intl.DateTimeFormat(undefined, { timeZone: w.timeZone, hour: '2-digit', minute: '2-digit' }).format(now)
                  } catch {
                    return '--:--'
                  }
                })()
              : `${w.minutes}:00`}
          </span>
        </span>
      ))}
    </div>
  )
}

function ToolsPreview({ manifest }: { manifest: ModManifest }): JSX.Element {
  return (
    <div className="modp modp--menu">
      {manifest.contributes.tools!.slice(0, 4).map((tool) => (
        <div key={tool.name} className="modp-row">
          <span className="modp-row__name modp-row__name--mono">{tool.name}</span>
          <span className="modp-row__desc">
            <Globe size={10} strokeWidth={2} /> {toolHost(tool.url)}
          </span>
        </div>
      ))}
    </div>
  )
}

function SoundPreview({ notes }: { notes: ModNote[] }): JSX.Element {
  const total = notes.reduce((sum, n) => sum + n.ms, 0) || 1
  return (
    <div className="modp modp--sound">
      {notes.map((note, i) => (
        <i key={i} style={{ flexGrow: note.ms / total, height: `${20 + Math.min(70, Math.log2(note.freq / 110) * 18)}%` }} />
      ))}
    </div>
  )
}

function CliPreview({ manifest, claude }: { manifest: ModManifest; claude: ClaudePluginParts | null }): JSX.Element {
  const c = manifest.contributes
  const parts = claude
    ? [
        ...claude.commands.map((x) => `/${x}`),
        ...claude.skills.map((x) => `skill ${x}`),
        ...claude.agents.map((x) => `agent ${x}`),
        // "PreToolUse (Bash): sh …" shows as its event and tool.
        ...claude.hooks.map((x) => `hook ${x.split(':')[0]}`)
      ]
    : []
  return (
    <div className="modp modp--cli">
      <span className="modp-cli__agent">
        <AgentMark agent={c.claudePlugin ? 'claude' : 'codex'} size={13} />
        {c.claudePlugin ? 'Claude Code' : 'Codex'}
      </span>
      {parts.length > 0 ? (
        <div className="modp-cli__parts">
          {parts.slice(0, 5).map((part) => (
            <span key={part}>{part}</span>
          ))}
        </div>
      ) : (
        <p>{c.codex?.instructions ?? manifest.description}</p>
      )}
    </div>
  )
}
