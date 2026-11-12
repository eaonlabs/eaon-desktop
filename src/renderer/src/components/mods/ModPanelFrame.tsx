import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '../../state/store'
import { panelsOf, useMods } from '../../state/mods'
import { useDockPlace } from '../ide/dockPlace'
import { notify } from '../Notice'
import type { ModHostCall } from '@shared/mods'
import './mods.css'

/**
 * A mod's panel in the dock. The page runs in a frame sandboxed to scripts
 * alone: an opaque origin with no `window.api`, no storage of its own, no
 * popups or navigation, and (from the policy main serves it under) no
 * network. It reaches the app only through messages, and this host answers
 * just the calls its manifest declared (`ModPanel.host`):
 *
 *   { eaon: 'mod', id, call: 'storage.get' | 'storage.set' | 'storage.remove' | 'storage.keys', args }
 *   { eaon: 'mod', id, call: 'composer.insert', args: [text] }
 *   { eaon: 'mod', id, call: 'notify', args: [text] }
 *
 * and answers `{ eaon: 'mod', id, ok, result | error }`. It also sends the
 * app's colours as `{ eaon: 'mod', event: 'theme', theme }` when the page
 * loads and whenever they change, so a panel can match the app. docs/mods.md
 * has a small client for this.
 */

interface Request {
  eaon: 'mod'
  id: number
  call: string
  args?: unknown[]
}

const NEEDS: Record<string, ModHostCall> = {
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.remove': 'storage',
  'storage.keys': 'storage',
  'composer.insert': 'composer',
  notify: 'notify'
}

/** The app's colours, resolved to plain rgb() values, for a page that can't read the app's CSS. */
function themeTokens(): Record<string, string> {
  const probe = document.createElement('div')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const read = (token: string): string => {
    probe.style.color = `var(${token})`
    return getComputedStyle(probe).color
  }
  const root = getComputedStyle(document.documentElement)
  const tokens = {
    mode: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    background: read('--canvas'),
    surface: read('--surface-2'),
    raised: read('--surface-3'),
    text: read('--text'),
    text2: read('--text-2'),
    text3: read('--text-3'),
    border: read('--border'),
    accent: read('--accent-fill'),
    onAccent: read('--on-accent'),
    danger: read('--danger'),
    font: root.getPropertyValue('--font-ui').trim(),
    mono: root.getPropertyValue('--font-mono').trim(),
    fontSize: root.getPropertyValue('--fs-base').trim() || '14px'
  }
  probe.remove()
  return tokens
}

export function ModPanelFrame({ panelKey }: { panelKey: string }): JSX.Element {
  const enabled = useMods((s) => s.enabled)
  const panel = useMemo(() => panelsOf(enabled).find((p) => p.key === panelKey), [enabled, panelKey])
  const place = useDockPlace()
  const frame = useRef<HTMLIFrameElement>(null)
  const data = useRef<Record<string, string> | null>(null)
  const appearance = useApp((s) => s.settings?.appearance)
  const [loaded, setLoaded] = useState(0)

  // The app's look, again whenever it changes.
  useEffect(() => {
    if (!loaded) return
    frame.current?.contentWindow?.postMessage({ eaon: 'mod', event: 'theme', theme: themeTokens() }, '*')
  }, [loaded, appearance])

  useEffect(() => {
    if (!panel) return
    const modId = panel.modId
    const allowed = new Set(panel.host)
    const onMessage = async (event: MessageEvent): Promise<void> => {
      // Only this frame's page, and only its own kind of message.
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const req = event.data as Request
      if (!req || req.eaon !== 'mod' || typeof req.id !== 'number' || typeof req.call !== 'string') return
      const reply = (body: { ok: true; result?: unknown } | { ok: false; error: string }): void =>
        frame.current?.contentWindow?.postMessage({ eaon: 'mod', id: req.id, ...body }, '*')
      const need = NEEDS[req.call]
      if (!need) return reply({ ok: false, error: `There’s no host call named ${req.call}.` })
      if (!allowed.has(need)) return reply({ ok: false, error: `This panel didn’t ask for "${need}" in its mod.json.` })
      const args = Array.isArray(req.args) ? req.args : []
      try {
        if (need === 'storage') {
          data.current ??= await window.api.mods.panelLoad(modId)
          const key = String(args[0] ?? '')
          if (req.call === 'storage.keys') return reply({ ok: true, result: Object.keys(data.current) })
          if (req.call === 'storage.get') return reply({ ok: true, result: data.current[key] ?? null })
          const value = req.call === 'storage.set' ? String(args[1] ?? '') : null
          await window.api.mods.panelSave(modId, key, value)
          if (value === null) delete data.current[key]
          else data.current[key] = value
          return reply({ ok: true })
        }
        if (need === 'composer') {
          const text = String(args[0] ?? '').slice(0, 20_000)
          if (!text.trim()) return reply({ ok: false, error: 'Nothing to insert.' })
          place.addToPrompt(text, panel.title)
          return reply({ ok: true })
        }
        notify(String(args[0] ?? '').slice(0, 200))
        return reply({ ok: true })
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error) })
      }
    }
    const listener = (event: MessageEvent): void => void onMessage(event)
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [panel, place])

  if (!panel) {
    return (
      <div className="mod-panel mod-panel--gone">
        <p>This panel’s mod is off or was removed.</p>
        <button type="button" className="btn btn--sm" onClick={() => useApp.getState().setSettingsPage('mods')}>
          Open Mods
        </button>
      </div>
    )
  }
  return (
    <div className="mod-panel">
      <iframe
        ref={frame}
        className="mod-panel__frame"
        title={`${panel.title}, from the ${panel.modName} mod`}
        src={panel.url}
        sandbox="allow-scripts"
        allow=""
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded((n) => n + 1)}
      />
    </div>
  )
}
