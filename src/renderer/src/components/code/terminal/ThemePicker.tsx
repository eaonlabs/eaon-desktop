import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, X } from 'lucide-react'
import { useApp } from '../../../state/store'
import { Switch } from '../../ui'
import { appTheme, terminals } from './registry'
import { SCENES, scenes, seedOf } from './scenes'
import { findTheme, TERMINAL_THEMES, type TerminalColors, type TerminalTheme } from './themes'
import { useTerminals } from './terminalStore'

/**
 * The ADE's theme picker: `/theme` typed in any pane, or the header's Theme
 * button. Moving through the list previews each theme on every pane and in
 * the sample at the top, scene and all, and restyles the whole app in its
 * colours (appLook.ts); Enter or a click keeps it, Escape
 * puts back what was there.
 */

/** The colours of the `eaon` theme, which are the app's own, as a palette. */
function appColors(): TerminalColors {
  const t = appTheme()
  return {
    background: t.background ?? '#111111',
    foreground: t.foreground ?? '#fcfcfc',
    cursor: t.cursor ?? '#fcfcfc',
    selection: t.selectionBackground ?? '#ffffff33',
    black: t.black ?? '#1f2328',
    red: t.red ?? '#f47067',
    green: t.green ?? '#57ab5a',
    yellow: t.yellow ?? '#c69026',
    blue: t.blue ?? '#539bf5',
    magenta: t.magenta ?? '#b083f0',
    cyan: t.cyan ?? '#39c5cf',
    white: t.white ?? '#adbac7',
    brightBlack: t.brightBlack ?? '#636e7b',
    brightRed: t.brightRed ?? '#ff938a',
    brightGreen: t.brightGreen ?? '#6bc46d',
    brightYellow: t.brightYellow ?? '#daaa3f',
    brightBlue: t.brightBlue ?? '#6cb6ff',
    brightMagenta: t.brightMagenta ?? '#dcbdfb',
    brightCyan: t.brightCyan ?? '#56d4dd',
    brightWhite: t.brightWhite ?? '#f0f6fc'
  }
}

const colorsOf = (theme: TerminalTheme): TerminalColors => theme.colors ?? appColors()

/** CLIs with a theme picker of their own, and what opens it. */
const OWN_THEME_COMMAND: Partial<Record<string, string>> = { claude: '/theme', opencode: '/themes', 'eaon-cli': '/themes' }

/** The sample's colours as CSS variables, so it is drawn in the theme being looked at. */
function sampleStyle(c: TerminalColors): CSSProperties {
  return {
    ['--s-bg' as string]: c.background,
    ['--s-fg' as string]: c.foreground,
    ['--s-red' as string]: c.red,
    ['--s-green' as string]: c.green,
    ['--s-yellow' as string]: c.yellow,
    ['--s-blue' as string]: c.blue,
    ['--s-magenta' as string]: c.magenta,
    ['--s-cyan' as string]: c.cyan,
    ['--s-muted' as string]: c.brightBlack
  }
}

export function ThemePicker(): JSX.Element | null {
  const { open, close, setPreview, saveLook, from, cli } = useTerminals(
    useShallow((s) => {
      // The CLI in the pane `/theme` came from, which may have a /theme of its own.
      const pane = s.pickerFrom ? Object.values(s.layout).flat().find((p) => p.id === s.pickerFrom) : undefined
      const agent = pane && OWN_THEME_COMMAND[pane.agent] ? s.agents.find((a) => a.id === pane.agent) : undefined
      return {
        open: s.pickerOpen,
        close: s.closePicker,
        setPreview: s.setPreview,
        saveLook: s.saveLook,
        from: s.pickerFrom,
        cli: agent ? { label: agent.label, command: OWN_THEME_COMMAND[agent.id] as string } : null
      }
    })
  )
  const look = useApp((s) => s.settings?.ade ?? { theme: 'eaon', scenes: true })
  const saved = findTheme(look.theme)
  const [index, setIndex] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const sceneCanvas = useRef<HTMLCanvasElement>(null)

  // Opening starts on the theme in use, with the keyboard in the picker.
  useEffect(() => {
    if (!open) return
    setIndex(Math.max(0, TERMINAL_THEMES.findIndex((t) => t.id === saved.id)))
    requestAnimationFrame(() => panel.current?.focus())
    // Only on opening: what is saved changes as the picker applies things.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const hovered = TERMINAL_THEMES[index] ?? saved
  const colors = useMemo(() => colorsOf(hovered), [hovered])

  // The sample's own scene, for the theme under the cursor.
  useEffect(() => {
    const canvas = sceneCanvas.current
    if (!open || !canvas) return
    if (look.scenes && hovered.scene) scenes.show(canvas, { scene: hovered.scene, colors, seed: seedOf('theme-picker') })
    else scenes.hide(canvas)
    return () => scenes.hide(canvas)
  }, [open, hovered, colors, look.scenes])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null

  const move = (to: number): void => {
    const next = (to + TERMINAL_THEMES.length) % TERMINAL_THEMES.length
    setIndex(next)
    setPreview(TERMINAL_THEMES[next].id)
  }
  const apply = (theme: TerminalTheme): void => {
    saveLook({ theme: theme.id })
    close()
  }

  return (
    <>
      <div className="theme-picker__scrim" onMouseDown={close} />
      <div
        ref={panel}
        className="theme-picker"
        role="dialog"
        aria-label="Terminal themes"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'j') move(index + 1)
          else if (e.key === 'ArrowUp' || e.key === 'k') move(index - 1)
          else if (e.key === 'Enter') apply(hovered)
          else if (e.key === 'Escape') close()
          else if (e.key.toLowerCase() === 's') saveLook({ scenes: !look.scenes })
          else return
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <header className="theme-picker__head">
          <div className="theme-picker__title">
            <span className="theme-picker__dot" aria-hidden="true" />
            Themes
            <span className="theme-picker__count">{TERMINAL_THEMES.length}</span>
            <span className="theme-picker__now">now {saved.name}</span>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={close}>
            <X size={15} strokeWidth={2} />
          </button>
        </header>
        <p className="theme-picker__keys">
          <kbd>↑↓</kbd> preview everywhere · <kbd>⏎</kbd> or click to apply · <kbd>S</kbd> scenes · <kbd>esc</kbd> close
        </p>

        <div className="theme-sample" style={sampleStyle(colors)}>
          <canvas ref={sceneCanvas} className="term-scene" aria-hidden="true" />
          <div className="theme-sample__lines">
            <div>
              <span className="s-muted">❯</span> git push origin main
            </div>
            <div>
              <span className="s-badge s-badge--green">✓ 46 passed</span> <span className="s-bar" /> <span className="s-green">+12</span>{' '}
              <span className="s-red">−3</span>
            </div>
            <div>
              <span className="s-badge s-badge--blue">◆ eaon-desktop</span> <span className="s-magenta">⎇ main</span>
              <span className="s-muted"> · ctx </span>
              <span className="s-meter">
                <span />
              </span>
              <span className="s-muted"> 62%</span>
            </div>
            <div>
              <span className="s-block" /> <span className="s-cyan">Musing…</span> <span className="s-muted">12s</span>
            </div>
            <div>
              Plain text, <span className="s-muted">muted</span>, <span className="s-yellow">warning</span>, <span className="s-red">error</span>
            </div>
            <div className="s-blurb">
              ◆ {hovered.blurb}
              {hovered.scene && !look.scenes ? ' (scenes are off)' : ''}
            </div>
          </div>
        </div>

        <ul ref={list} className="theme-picker__list" role="listbox" aria-label="Themes" aria-activedescendant={`theme-${hovered.id}`}>
          {TERMINAL_THEMES.map((theme, i) => {
            const c = colorsOf(theme)
            return (
              <li
                key={theme.id}
                id={`theme-${theme.id}`}
                data-index={i}
                role="option"
                aria-selected={i === index}
                className="theme-row"
                data-active={i === index || undefined}
                onMouseEnter={() => {
                  setIndex(i)
                  setPreview(theme.id)
                }}
                onClick={() => apply(theme)}
              >
                <span className="theme-row__swatch" style={{ background: c.background }}>
                  {[c.red, c.yellow, c.green, c.cyan, c.blue, c.magenta].map((color, k) => (
                    <span key={k} className="theme-row__dot" style={{ background: color }} />
                  ))}
                  <span className="theme-row__aa" style={{ color: c.foreground }}>
                    Aa
                  </span>
                </span>
                <span className="theme-row__name">{theme.name}</span>
                {theme.id === saved.id && <Check className="theme-row__check" size={13} strokeWidth={2.4} />}
                {theme.mode === 'light' && <span className="theme-row__tag">light</span>}
                {theme.scene && <span className="theme-row__scene">{SCENES[theme.scene].name}</span>}
              </li>
            )
          })}
        </ul>

        <footer className="theme-picker__foot">
          <span>Draw each theme’s scene behind the text</span>
          <Switch label="Scenes" checked={look.scenes} onChange={(on) => saveLook({ scenes: on })} />
        </footer>
        {from && cli && (
          // The CLI's own /theme (Claude Code's light and dark text styles): still one click away.
          <button
            className="theme-picker__own"
            onClick={() => {
              close()
              requestAnimationFrame(() => terminals.send(from, `${cli.command}\r`))
            }}
          >
            Open {cli.label}’s own {cli.command} instead
          </button>
        )}
      </div>
    </>
  )
}
