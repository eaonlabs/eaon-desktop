// Eaon Remote (rc.eaon.dev): your Eaon Desktop computers, their ADE sessions
// and live terminals, and their Workers, from any browser.
//
// The page talks to each computer through the relay (/relay/web, a WebSocket
// opened with your sign-in cookie). Requests go out as {t:'req', dev, id,
// method, path, body} and come back as {t:'res', id, status, body}; a terminal
// is watched with {t:'sub'} and streams {t:'snap'} then {t:'term'} chunks.
// Everything is drawn with textContent: nothing an agent writes is ever HTML.
//
// It looks like the app on purpose: the same floating sidebar with the
// computer's sessions and Workers, the same terminal panes, composer, menus
// and motion (see app.css), so it reads as Eaon seen from another screen.

const app = document.getElementById('app')
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')

// ------------------------------------------------------------------ helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k === 'style' && typeof v === 'object') for (const [prop, value] of Object.entries(v)) prop.startsWith('--') ? el.style.setProperty(prop, String(value)) : (el.style[prop] = value)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

const SVG = 'http://www.w3.org/2000/svg'
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v))
  el.append(...children)
  return el
}

// Lucide's icons, as the app uses them (lucide-react, ISC licence).
const ICONS = {
  terminal: [['path', { d: 'm7 11 2-2-2-2' }], ['path', { d: 'M11 13h4' }], ['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }]],
  bot: [['path', { d: 'M12 8V4H8' }], ['rect', { width: 16, height: 12, x: 4, y: 8, rx: 2 }], ['path', { d: 'M2 14h2' }], ['path', { d: 'M20 14h2' }], ['path', { d: 'M15 13v2' }], ['path', { d: 'M9 13v2' }]],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
  'chevrons-up-down': [['path', { d: 'm7 15 5 5 5-5' }], ['path', { d: 'm7 9 5-5 5 5' }]],
  plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
  'arrow-up': [['path', { d: 'm5 12 7-7 7 7' }], ['path', { d: 'M12 19V5' }]],
  'log-out': [['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }], ['polyline', { points: '16 17 21 12 16 7' }], ['line', { x1: 21, x2: 9, y1: 12, y2: 12 }]],
  monitor: [['rect', { width: 20, height: 14, x: 2, y: 3, rx: 2 }], ['line', { x1: 8, x2: 16, y1: 21, y2: 21 }], ['line', { x1: 12, x2: 12, y1: 17, y2: 21 }]],
  laptop: [['rect', { width: 18, height: 12, x: 3, y: 4, rx: 2, ry: 2 }], ['line', { x1: 2, x2: 22, y1: 20, y2: 20 }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v2' }], ['path', { d: 'M12 20v2' }], ['path', { d: 'm4.93 4.93 1.41 1.41' }], ['path', { d: 'm17.66 17.66 1.41 1.41' }], ['path', { d: 'M2 12h2' }], ['path', { d: 'M20 12h2' }], ['path', { d: 'm6.34 17.66-1.41 1.41' }], ['path', { d: 'm19.07 4.93-1.41 1.41' }]],
  moon: [['path', { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  play: [['polygon', { points: '6 3 20 12 6 21 6 3' }]],
  alert: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 12, x2: 12, y1: 8, y2: 12 }], ['line', { x1: 12, x2: 12.01, y1: 16, y2: 16 }]],
  branch: [['line', { x1: 6, x2: 6, y1: 3, y2: 15 }], ['circle', { cx: 18, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }], ['path', { d: 'M18 9a9 9 0 0 1-9 9' }]],
  link: [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }], ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]],
  'wifi-off': [['path', { d: 'M12 20h.01' }], ['path', { d: 'M8.5 16.429a5 5 0 0 1 7 0' }], ['path', { d: 'M5 12.859a10 10 0 0 1 5.17-2.69' }], ['path', { d: 'M19 12.859a10 10 0 0 0-2.007-1.523' }], ['path', { d: 'M2 8.82a15 15 0 0 1 4.177-2.643' }], ['path', { d: 'M22 8.82a15 15 0 0 0-11.288-3.764' }], ['path', { d: 'm2 2 20 20' }]],
  folder: [['path', { d: 'M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5' }], ['circle', { cx: 13, cy: 12, r: 2 }], ['path', { d: 'M18 19c-2.8 0-5-2.2-5-5v8' }], ['circle', { cx: 20, cy: 19, r: 2 }]],
  'panel-left': [['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }], ['path', { d: 'M9 3v18' }]],
  hand: [['path', { d: 'M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2' }], ['path', { d: 'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2' }], ['path', { d: 'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8' }], ['path', { d: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15' }]],
  home: [['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }], ['path', { d: 'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  dot: [['circle', { cx: 12, cy: 12, r: 1.5 }]]
}

function icon(name, size = 16, stroke = 1.75) {
  return s(
    'svg',
    { class: 'i', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...(ICONS[name] ?? []).map(([tag, attrs]) => s(tag, attrs))
  )
}

/** Eaon's symbol: the "e" cut from a circle. */
function symbol(cls) {
  return s('svg', { class: cls, viewBox: '0 0 200 200', 'aria-hidden': 'true' }, s('path', { fill: 'currentColor', 'fill-rule': 'evenodd', d: 'M186.6 50A100 100 0 1 0 186.6 150H103A15 15 0 0 1 103 120H197.98A100 100 0 0 0 197.98 80H103A15 15 0 0 1 103 50Z' }))
}

const GITHUB_MARK =
  'M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z'
const githubIcon = () => s('svg', { class: 'gh', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: GITHUB_MARK, fill: 'currentColor' }))

const link = (href, props, ...children) =>
  h(
    'a',
    {
      ...props,
      href,
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        go(href)
      }
    },
    ...children
  )

function toast(text) {
  const el = h('div', { class: 'toast', role: 'status' }, icon('alert', 16), h('span', { text }))
  document.body.append(el)
  setTimeout(() => {
    el.dataset.leaving = ''
    setTimeout(() => el.remove(), 180)
  }, 3200)
}

function ago(ms) {
  if (!ms) return ''
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (sec < 45) return 'just now'
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}

const PLATFORMS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

async function api(path, init = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status })
  return body
}

const skeletonRows = (n, cls = 'card__row') =>
  Array.from({ length: n }, (_, i) =>
    h(
      'div',
      { class: cls, 'aria-hidden': 'true' },
      h('span', { class: 'skeleton', style: { width: '9px', height: '9px', flex: 'none' } }),
      h('span', { class: 'card__row-body' }, h('span', { class: 'skeleton', style: { width: `${46 - i * 9}%` } }), h('span', { class: 'skeleton', style: { width: `${28 + i * 7}%`, marginTop: '8px', height: '8px' } }))
    )
  )

function empty(iconName, title, text, ...actions) {
  return h('div', { class: 'empty' }, h('span', { class: 'empty__icon' }, icon(iconName, 18)), h('div', { class: 'empty__title', text: title }), text && h('div', { class: 'empty__text', text }), ...actions)
}

// ------------------------------------------------------------------ theme

const prefersLight = matchMedia('(prefers-color-scheme: light)')
const themeListeners = new Set()
function themeChoice() {
  try {
    return localStorage.getItem('rc-theme') || 'system'
  } catch {
    return 'system'
  }
}
function applyTheme() {
  const choice = themeChoice()
  document.documentElement.dataset.theme = choice === 'system' ? (prefersLight.matches ? 'light' : 'dark') : choice
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolveColor('var(--canvas)'))
  for (const l of themeListeners) l()
}
prefersLight.addEventListener('change', () => themeChoice() === 'system' && applyTheme())

/** Switches the theme; the new one sweeps out from where it was picked, as in the app's setup. */
function setTheme(choice, event) {
  try {
    localStorage.setItem('rc-theme', choice)
  } catch {}
  const before = document.documentElement.dataset.theme
  const after = choice === 'system' ? (prefersLight.matches ? 'light' : 'dark') : choice
  if (before === after || !document.startViewTransition || reduceMotion.matches) return applyTheme()
  const rect = event?.currentTarget?.getBoundingClientRect?.()
  const x = rect ? rect.left + rect.width / 2 : innerWidth / 2
  const y = rect ? rect.top + rect.height / 2 : innerHeight / 2
  const root = document.documentElement
  root.style.setProperty('--reveal-x', `${x}px`)
  root.style.setProperty('--reveal-y', `${y}px`)
  root.style.setProperty('--reveal-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`)
  root.dataset.themeReveal = ''
  const t = document.startViewTransition(applyTheme)
  t.finished.finally(() => delete root.dataset.themeReveal)
}

/** A CSS colour (color-mix and custom properties included) as #rrggbb, for xterm and the browser chrome. */
function resolveColor(css) {
  const probe = document.createElement('span')
  probe.style.color = css
  probe.style.display = 'none'
  document.body.append(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) return '#000000'
  ctx.fillStyle = computed
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

// The ADE's own palettes (registry.ts in the app).
const DARK_ANSI = { black: '#1f2328', red: '#f47067', green: '#57ab5a', yellow: '#c69026', blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#adbac7', brightBlack: '#636e7b', brightRed: '#ff938a', brightGreen: '#6bc46d', brightYellow: '#daaa3f', brightBlue: '#6cb6ff', brightMagenta: '#dcbdfb', brightCyan: '#56d4dd', brightWhite: '#f0f6fc' }
const LIGHT_ANSI = { black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781', brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f' }
function xtermTheme() {
  const bg = resolveColor('var(--term-bg)')
  return {
    background: bg,
    foreground: resolveColor('var(--text)'),
    cursor: resolveColor('var(--accent)'),
    cursorAccent: bg,
    selectionBackground: resolveColor('color-mix(in srgb, var(--accent) 35%, var(--term-bg))'),
    ...(document.documentElement.dataset.theme === 'light' ? LIGHT_ANSI : DARK_ANSI)
  }
}

// ------------------------------------------------------------------ worker faces

// WorkerFace in the app, drawn once: a circle in the worker's colour with two
// soft eyes in its mood, blinking now and then. Eyes on a 100×100 grid.
const PILL = 'M -6.75 -5.85 A 6.75 6.75 0 0 1 6.75 -5.85 L 6.75 5.85 A 6.75 6.75 0 0 1 -6.75 5.85 Z'
const EYES = {
  neutral: PILL,
  happy: 'M -6.75 -5.85 A 6.75 6.75 0 0 1 6.75 -5.85 L 6.75 2.4 Q 0 -1.9 -6.75 2.4 Z',
  serious: 'M -6.75 -5 L 6.75 -5 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z',
  curious: 'M -7.2 -6.6 A 7.2 7.2 0 0 1 7.2 -6.6 L 7.2 5.6 A 7.2 7.2 0 0 1 -7.2 5.6 Z',
  surprised: 'M -9.4 0 A 9.4 12.4 0 1 1 9.4 0 A 9.4 12.4 0 1 1 -9.4 0 Z',
  sad: 'M -6.75 -1.4 L 6.75 -7.2 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z',
  angry: 'M -6.75 -7.6 L 6.75 -1.6 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z',
  sleepy: 'M -6.75 0.6 L 6.75 0.6 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z'
}
const MOOD = { excited: 'happy', asleep: 'sleepy', dead: 'sad' }
function eyeColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  const ch = (v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255) > 0.62 ? '#1d2127' : '#ffffff'
}
function face(worker, size = 28) {
  const color = /^#[0-9a-f]{6}$/i.test(worker.color ?? '') ? worker.color : '#3e86c6'
  const mood = MOOD[worker.mood] ?? (EYES[worker.mood] ? worker.mood : 'neutral')
  const busy = worker.status === 'working'
  const eye = eyeColor(color)
  const ring = busy && size >= 36
  const sw = Math.min(4.5, Math.max(3, 280 / size))
  return s(
    'svg',
    { class: 'wf', width: size, height: size, viewBox: '0 0 100 100', 'data-busy': busy ? '' : undefined, role: 'img', 'aria-label': `${worker.name ?? 'Worker'}` },
    ...(ring
      ? [s('g', { class: 'wf-ring' }, s('circle', { class: 'wf-ring__track', cx: 50, cy: 50, r: 57, fill: 'none', stroke: color, 'stroke-width': sw }), s('circle', { class: 'wf-ring__arc', cx: 50, cy: 50, r: 57, fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', pathLength: 100 }))]
      : []),
    s('circle', { cx: 50, cy: 50, r: 50, fill: color }),
    s(
      'g',
      { class: 'wf-eyes', style: `--blink-delay:${(-Math.random() * 5).toFixed(2)}s` },
      ...[33.3, 66.7].map((x, side) => s('g', { transform: `translate(${x} 40)${side ? ' scale(-1 1)' : ''}` }, s('path', { d: EYES[mood], fill: eye })))
    )
  )
}
const workerState = (w) => (w.paused ? 'paused' : w.status)

// ------------------------------------------------------------------ the relay

class Relay {
  constructor() {
    this.ws = null
    this.devices = new Map()
    this.pending = new Map()
    this.subs = new Map() // `${dev}/${pane}` -> handlers
    this.listeners = new Set()
    this.seq = 0
    this.backoff = 1000
    this.connected = false
  }

  on(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    for (const l of [...this.listeners]) l()
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay/web`)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.backoff = 1000
      this.ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25_000)
      // Terminals being watched start again where they are.
      for (const key of this.subs.keys()) {
        const [dev, pane] = key.split('/')
        this.raw({ t: 'sub', dev, pane })
      }
      this.emit()
    }
    ws.onmessage = (event) => {
      if (event.data === 'pong') return
      let m
      try {
        m = JSON.parse(event.data)
      } catch {
        return
      }
      this.handle(m)
    }
    ws.onclose = () => {
      clearInterval(this.ping)
      const was = this.connected
      this.connected = false
      for (const [, p] of this.pending) p.reject(new Error('The connection dropped. Trying again…'))
      this.pending.clear()
      if (was) this.emit()
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 15_000)
    }
  }

  handle(m) {
    if (m.t === 'hello') {
      this.devices = new Map(m.devices.map((d) => [d.id, d]))
      this.emit()
    } else if (m.t === 'presence') {
      const d = this.devices.get(m.dev)
      if (m.removed) this.devices.delete(m.dev)
      else if (d) Object.assign(d, { online: m.online, ...(m.name ? { name: m.name } : {}), ...(m.online ? { lastSeen: Date.now() } : {}) })
      else refreshDevices()
      this.emit()
    } else if (m.t === 'res') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.status >= 400) p.reject(Object.assign(new Error(m.body?.error?.message || `Error ${m.status}`), { status: m.status, code: m.body?.error?.code }))
      else p.resolve(m.body)
    } else if (m.t === 'snap' || m.t === 'term' || m.t === 'exit') {
      const handlers = this.subs.get(`${m.dev}/${m.pane}`)
      if (handlers) handlers[m.t]?.(m)
    }
  }

  raw(message) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message))
  }

  /** Resolves once the relay is open: a request made while it connects waits instead of failing. */
  ready(ms = 12_000) {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error('Can’t reach Eaon Remote. Check your connection.'))
      }, ms)
      const off = this.on(() => {
        if (!this.connected) return
        clearTimeout(timer)
        off()
        resolve()
      })
    })
  }

  async request(dev, method, path, body) {
    await this.ready()
    return new Promise((resolve, reject) => {
      const id = `r${++this.seq}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The computer didn’t answer in time.'))
      }, 25_000)
      this.pending.set(id, { resolve, reject, timer })
      this.raw({ t: 'req', dev, id, method, path, body })
    })
  }

  watch(dev, pane, handlers) {
    const key = `${dev}/${pane}`
    this.subs.set(key, handlers)
    this.raw({ t: 'sub', dev, pane })
    return () => {
      this.subs.delete(key)
      this.raw({ t: 'unsub', dev, pane })
    }
  }

  input(dev, pane, data) {
    this.raw({ t: 'input', dev, pane, data })
  }
}

const relay = new Relay()
let me = null

async function refreshDevices() {
  try {
    const { devices } = await api('/api/devices')
    relay.devices = new Map(devices.map((d) => [d.id, d]))
    relay.emit()
  } catch {}
}

// ------------------------------------------------------------------ the open computer

/**
 * What the sidebar and the pages show for the computer that's open: its
 * sessions and Workers, polled while it's open. Listeners hear only real
 * changes, so nothing redraws (and loses its hover) when nothing moved.
 */
const device = {
  id: null,
  sessions: null,
  agents: [],
  workers: null,
  sessionsError: null,
  workersError: null,
  keys: {},
  listeners: new Set(),
  timers: {},
  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },
  emit() {
    for (const l of [...this.listeners]) l()
  },
  open(id) {
    if (this.id === id) return
    for (const t of Object.values(this.timers)) clearTimeout(t)
    Object.assign(this, { id, sessions: null, agents: [], workers: null, sessionsError: null, workersError: null, keys: {}, timers: {} })
    this.emit()
    this.kick()
  },
  /** Polls now, then on the usual beat. */
  kick() {
    if (!this.id) return
    this.loop('sessions', 2500, async () => {
      const data = await relay.request(this.id, 'GET', '/ade/sessions')
      return { sessions: data.sessions, agents: data.agents }
    })
    this.loop('workers', 3000, async () => ({ workers: (await relay.request(this.id, 'GET', '/remote/v1/workers')).workers }))
  },
  loop(kind, ms, load) {
    clearTimeout(this.timers[kind])
    const id = this.id
    const tick = async () => {
      if (this.id !== id) return
      if (document.hidden) return (this.timers[kind] = setTimeout(tick, ms))
      let next
      try {
        next = { ...(await load()), [`${kind}Error`]: null }
      } catch (error) {
        next = { [`${kind}Error`]: error.message, ...(error.code === 'offline' ? { [kind]: this[kind] ?? null } : {}) }
      }
      if (this.id !== id) return
      const key = JSON.stringify(next)
      if (key !== this.keys[kind]) {
        this.keys[kind] = key
        Object.assign(this, next)
        this.emit()
      }
      this.timers[kind] = setTimeout(tick, ms)
    }
    this.timers[kind] = setTimeout(tick, 0)
  },
  refresh() {
    this.kick()
  }
}
relay.on(() => relay.connected && device.id && !device.sessions && device.kick())
document.addEventListener('visibilitychange', () => !document.hidden && device.kick())

// ------------------------------------------------------------------ menus

let menu = null
function closeMenu() {
  if (!menu) return
  const { el, anchor, off } = menu
  menu = null
  off()
  delete anchor.dataset.open
  el.dataset.leaving = ''
  setTimeout(() => el.remove(), 130)
}
/** A popover menu under (or over) `anchor`, like the app's Popover. */
function popover(anchor, build, { width, align = 'start' } = {}) {
  if (menu?.anchor === anchor) return closeMenu()
  closeMenu()
  const el = h('div', { class: 'menu', role: 'menu' })
  el.append(...[build(closeMenu)].flat(Infinity).filter(Boolean))
  if (width) el.style.width = `${width}px`
  document.body.append(el)
  const r = anchor.getBoundingClientRect()
  const mh = el.offsetHeight
  const mw = el.offsetWidth
  const below = r.bottom + 6 + mh <= innerHeight - 8 || r.top < mh + 14
  const top = below ? r.bottom + 6 : r.top - 6 - mh
  let left = align === 'end' ? r.right - mw : r.left
  left = Math.max(8, Math.min(left, innerWidth - mw - 8))
  Object.assign(el.style, { top: `${Math.max(8, top)}px`, left: `${left}px` })
  el.style.setProperty('--pop-origin', `${align === 'end' ? 'right' : 'left'} ${below ? 'top' : 'bottom'}`)
  anchor.dataset.open = ''
  const onDown = (e) => !el.contains(e.target) && !anchor.contains(e.target) && closeMenu()
  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeMenu()
      anchor.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = [...el.querySelectorAll('.menu__item:not(:disabled)')]
      const i = items.indexOf(document.activeElement)
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
  }
  setTimeout(() => addEventListener('pointerdown', onDown), 0)
  addEventListener('keydown', onKey)
  addEventListener('resize', closeMenu)
  menu = { el, anchor, off: () => (removeEventListener('pointerdown', onDown), removeEventListener('keydown', onKey), removeEventListener('resize', closeMenu)) }
  return closeMenu
}
function menuItem({ iconNode, title, desc, hint, check, disabled, onclick }) {
  return h(
    'button',
    { class: 'menu__item', role: 'menuitem', type: 'button', disabled, onclick },
    iconNode && h('span', { class: 'menu__item-icon' }, iconNode),
    h('span', { class: 'menu__item-body' }, h('span', { class: 'menu__item-title', text: title }), desc && h('span', { class: 'menu__item-desc', text: desc })),
    hint && h('span', { class: 'menu__item-hint', text: hint }),
    check && h('span', { class: 'menu__item-check' }, icon('check', 15))
  )
}

/** The agents a terminal can run, as a menu; picking one starts it in the session and opens it. */
function newTerminalMenu(anchor, dev, sessionId, opts) {
  popover(
    anchor,
    (close) => [
      h('div', { class: 'menu__label', text: 'New terminal' }),
      device.agents.length
        ? device.agents.map((a) =>
            menuItem({
              iconNode: icon(a.id === 'shell' ? 'terminal' : 'bot', 16),
              title: a.label,
              hint: a.installed ? null : 'Not installed',
              disabled: !a.installed,
              onclick: async () => {
                close()
                try {
                  const { pane } = await relay.request(dev, 'POST', `/ade/sessions/${encodeURIComponent(sessionId)}/panes`, { agent: a.id })
                  device.refresh()
                  go(`/d/${dev}/t/${encodeURIComponent(pane.id)}`)
                } catch (error) {
                  toast(error.message)
                }
              }
            })
          )
        : h('div', { class: 'menu__label', text: 'Loading…' })
    ],
    opts
  )
}

// ------------------------------------------------------------------ routing

let cleanup = []
const onLeave = (fn) => cleanup.push(fn)
let shell = null
let route = { kind: 'home' }

function go(path, replace = false) {
  if (path === location.pathname + location.search) return
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  render()
}
addEventListener('popstate', render)

async function signOut() {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {})
  location.href = '/'
}

function lastDevice() {
  try {
    return localStorage.getItem('rc-last')
  } catch {
    return null
  }
}

function dropShell() {
  shell?.destroy()
  shell = null
}

function render() {
  for (const fn of cleanup.splice(0)) fn()
  closeMenu()
  const path = location.pathname
  const params = new URLSearchParams(location.search)
  if (!me) {
    dropShell()
    return app.replaceChildren(signedOut())
  }
  if (path === '/link') {
    dropShell()
    return app.replaceChildren(solo(linkPage(params.get('code'))))
  }
  const m = path.match(/^\/d\/([\w-]+)(?:\/(s|t|w)(?:\/([^/]+))?)?\/?$/)
  if (!m) {
    const devices = [...relay.devices.values()]
    if (!devices.length) {
      dropShell()
      // Linking from another tab shows up here by itself.
      const wait = () => relay.devices.size && render()
      onLeave(relay.on(wait))
      return app.replaceChildren(solo(noComputers()))
    }
    const pick = devices.find((d) => d.id === lastDevice()) ?? devices.find((d) => d.online) ?? devices[0]
    return go(`/d/${pick.id}`, true)
  }
  const [, dev, kind, rawId] = m
  const id = rawId ? decodeURIComponent(rawId) : null
  route = { dev, kind: kind && id ? kind : kind === 'w' ? 'workers' : 'overview', id }
  try {
    localStorage.setItem('rc-last', dev)
  } catch {}
  device.open(dev)
  if (!shell || shell.dev !== dev || !app.contains(shell.root)) {
    dropShell()
    shell = makeShell(dev)
  }
  shell.setDrawer(false)
  shell.drawSide()
  const page =
    route.kind === 't' ? terminalPage(dev, id) : route.kind === 's' ? sessionPage(dev, id) : route.kind === 'w' ? workerPage(dev, id) : route.kind === 'workers' ? workersPage(dev) : overviewPage(dev)
  shell.show(page)
}

// ------------------------------------------------------------------ the shell: sidebar and main

function makeShell(dev) {
  const side = h('div', { class: 'sidebar__scroll' })
  const switcherSlot = h('div')
  const account = accountButton()
  const sidebar = h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Computer' },
    h(
      'div',
      { class: 'sidebar__panel' },
      h(
        'div',
        { class: 'sidebar__top' },
        link('/', { class: 'brand' }, symbol('brand__symbol'), 'Eaon', h('span', { class: 'brand__sub', text: 'Remote' })),
        h('button', { class: 'icon-btn sidebar__close', type: 'button', 'aria-label': 'Close', onclick: () => setDrawer(false) }, icon('x', 16))
      ),
      switcherSlot,
      side,
      h('div', { class: 'sidebar__foot' }, account)
    )
  )
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Where you are' })
  const actions = h('div', { class: 'head__actions', style: { paddingTop: '0' } })
  const bar = h(
    'header',
    { class: 'main__bar' },
    h('button', { class: 'icon-btn main__menu', type: 'button', 'aria-label': 'Open the sidebar', onclick: () => setDrawer(true) }, icon('panel-left', 17)),
    crumbs,
    h('span', { class: 'main__spacer' }),
    actions
  )
  const body = h('div', { class: 'main__scroll' })
  const main = h('main', { class: 'main' }, bar, body)
  const root = h('div', { class: 'shell' }, sidebar, h('div', { class: 'scrim', onclick: () => setDrawer(false) }), main)
  const setDrawer = (open) => (open ? (root.dataset.drawer = '') : delete root.dataset.drawer)
  app.replaceChildren(root)

  // The switcher and the lists stay mounted from page to page; only what changed redraws.
  let firstSide = true
  const drawSwitcher = () => switcherSlot.replaceChildren(switcher(dev))
  const drawSide = () => {
    const nodes = sidebarLists(dev)
    side.replaceChildren(...nodes)
    if (firstSide && device.sessions) {
      firstSide = false
      side.classList.add('stagger')
      side.querySelectorAll(':scope > *').forEach((el, i) => el.style.setProperty('--i', String(i)))
      setTimeout(() => side.classList.remove('stagger'), 700)
    }
  }
  const offs = [relay.on(drawSwitcher), relay.on(drawSide), device.on(drawSide)]
  drawSwitcher()
  const crumbOff = { fn: null }

  return {
    dev,
    root,
    setDrawer,
    drawSide,
    show(page) {
      crumbOff.fn?.()
      const drawCrumbs = () => crumbs.replaceChildren(...crumbTrail(dev))
      drawCrumbs()
      crumbOff.fn = (() => {
        const a = relay.on(drawCrumbs)
        const b = device.on(drawCrumbs)
        return () => (a(), b())
      })()
      actions.replaceChildren(...(page.actions ?? []))
      body.className = page.full ? 'main__scroll main__scroll--full' : 'main__scroll'
      body.style.overflow = page.full ? 'hidden' : ''
      body.style.display = page.full ? 'flex' : ''
      body.replaceChildren(page.node)
      body.scrollTop = 0
    },
    destroy() {
      offs.forEach((off) => off())
      crumbOff.fn?.()
    }
  }
}

function switcher(dev) {
  const d = relay.devices.get(dev)
  const online = Boolean(d?.online)
  const btn = h(
    'button',
    { class: 'switcher', type: 'button', 'aria-haspopup': 'menu' },
    h('span', { class: 'switcher__icon' }, icon(d?.platform === 'darwin' ? 'laptop' : 'monitor', 16), h('span', { class: 'state', dataset: { s: online ? 'online' : 'offline' } })),
    h(
      'span',
      { class: 'switcher__body' },
      h('span', { class: 'switcher__name', text: d?.name ?? 'Computer' }),
      h('span', { class: 'switcher__sub', text: !relay.connected ? 'Connecting…' : online ? 'Online' : d?.lastSeen ? `Offline · seen ${ago(d.lastSeen)}` : 'Offline' })
    ),
    h('span', { class: 'switcher__chev' }, icon('chevrons-up-down', 15))
  )
  btn.onclick = () =>
    popover(
      btn,
      (close) => {
        const devices = [...relay.devices.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
        return [
          h('div', { class: 'menu__label', text: 'Your computers' }),
          devices.map((x) =>
            menuItem({
              iconNode: h('span', { class: 'state', dataset: { s: x.online ? 'online' : 'offline' } }),
              title: x.name,
              desc: x.online ? `Online${PLATFORMS[x.platform] ? ` · ${PLATFORMS[x.platform]}` : ''}` : `Offline${x.lastSeen ? ` · seen ${ago(x.lastSeen)}` : ''}`,
              check: x.id === dev,
              onclick: () => (close(), go(`/d/${x.id}`))
            })
          ),
          h('div', { class: 'menu__sep' }),
          menuItem({ iconNode: icon('link', 16), title: 'Link a computer', onclick: () => (close(), go('/link')) })
        ]
      },
      { width: btn.offsetWidth }
    )
  return btn
}

function sessionRow(dev, session, current) {
  return link(
    `/d/${dev}/s/${encodeURIComponent(session.id)}`,
    { class: 'ade-session', 'aria-current': current ? 'page' : null },
    h('span', { class: 'state', dataset: { s: session.state } }),
    h('span', { class: 'ade-session__text' }, h('span', { class: 'ade-session__title', text: session.title }), h('span', { class: 'ade-session__branch', text: session.branch || session.subtitle })),
    diff(session.changes)
  )
}

function paneState(p) {
  return p.status === 'working' ? 'working' : p.status === 'idle' ? 'idle-pane' : p.status
}

function sidebarLists(dev) {
  const out = []
  const sessions = device.sessions
  const openSession = route.kind === 's' ? route.id : route.kind === 't' ? sessions?.find((x) => x.panes.some((p) => p.id === route.id))?.id : null
  out.push(
    h('div', { class: 'sidebar__section' }, 'Overview'),
    link(`/d/${dev}`, { class: 'nav-item', 'aria-current': route.kind === 'overview' ? 'page' : null }, h('span', { class: 'nav-item__icon' }, icon('home', 16)), h('span', { class: 'nav-item__label', text: 'This computer' }))
  )
  out.push(h('div', { class: 'sidebar__section' }, 'Sessions'))
  if (!sessions) out.push(device.sessionsError ? h('div', { class: 'sidebar__empty', text: shortError(device.sessionsError) }) : skeletonRows(3, 'ade-session'))
  else if (!sessions.length) out.push(h('div', { class: 'sidebar__empty', text: 'No sessions yet' }))
  else
    for (const session of sessions) {
      const open = session.id === openSession
      out.push(sessionRow(dev, session, open && route.kind === 's'))
      if (open && session.panes.length) {
        out.push(
          h(
            'div',
            { class: 'ade-panes' },
            session.panes.map((p) =>
              link(
                `/d/${dev}/t/${encodeURIComponent(p.id)}`,
                { class: 'nav-item nav-item--pane', 'aria-current': route.kind === 't' && route.id === p.id ? 'page' : null },
                h('span', { class: 'state', dataset: { s: paneState(p) } }),
                h('span', { class: 'nav-item__label', text: p.task || p.name })
              )
            )
          )
        )
      }
    }
  const workers = device.workers
  out.push(h('div', { class: 'sidebar__section' }, link(`/d/${dev}/w`, { style: { color: 'inherit' } }, 'Workers')))
  if (!workers) out.push(device.workersError ? h('div', { class: 'sidebar__empty', text: shortError(device.workersError) }) : skeletonRows(2, 'nav-item'))
  else if (!workers.length) out.push(h('div', { class: 'sidebar__empty', text: 'No Workers yet' }))
  else
    for (const w of workers)
      out.push(
        link(
          `/d/${dev}/w/${encodeURIComponent(w.id)}`,
          { class: 'nav-item', 'aria-current': route.kind === 'w' && route.id === w.id ? 'page' : null },
          h('span', { class: 'nav-item__icon' }, face(w, 18)),
          h('span', { class: 'nav-item__label', text: w.name }),
          h(
            'span',
            { class: 'nav-item__trail' },
            w.asks.length ? h('span', { class: 'badge', dataset: { tone: 'attention' }, title: 'Waiting on you', text: w.asks.length }) : w.unread ? h('span', { class: 'badge', text: w.unread }) : h('span', { class: 'status-dot', dataset: { s: workerState(w) } })
          )
        )
      )
  return out
}

const shortError = (message) => (/offline/i.test(message) ? 'Offline' : /reach|connect/i.test(message) ? 'Connecting…' : 'Couldn’t load')

function accountButton() {
  const btn = h(
    'button',
    { class: 'account', type: 'button', 'aria-haspopup': 'menu' },
    avatar(),
    h('span', { class: 'account__name', text: `@${me.login}` }),
    h('span', { class: 'switcher__chev' }, icon('chevrons-up-down', 14))
  )
  btn.onclick = () =>
    popover(btn, (close) => {
      const seg = h('div', { class: 'segment', role: 'radiogroup', 'aria-label': 'Theme' })
      const draw = () =>
        seg.replaceChildren(
          ...[
            ['system', 'monitor', 'System'],
            ['light', 'sun', 'Light'],
            ['dark', 'moon', 'Dark']
          ].map(([value, ic, label]) =>
            h(
              'button',
              {
                class: 'segment__item',
                type: 'button',
                role: 'radio',
                'aria-checked': String(themeChoice() === value),
                dataset: { active: String(themeChoice() === value) },
                onclick: (e) => {
                  setTheme(value, e)
                  draw()
                }
              },
              icon(ic, 13),
              label
            )
          )
        )
      draw()
      return [
        h('div', { class: 'menu__label', text: 'Theme' }),
        h('div', { class: 'menu__row' }, seg),
        h('div', { class: 'menu__sep' }),
        menuItem({ iconNode: icon('link', 16), title: 'Link a computer', onclick: () => (close(), go('/link')) }),
        menuItem({ iconNode: icon('log-out', 16), title: 'Sign out', onclick: signOut })
      ]
    }, { width: Math.max(btn.offsetWidth, 240) })
  return btn
}

function avatar() {
  if (me.avatar) return h('img', { class: 'avatar', src: me.avatar, alt: '' })
  return h('span', { class: 'avatar', text: (me.login[0] ?? '?').toUpperCase() })
}

function crumbTrail(dev) {
  const d = relay.devices.get(dev)
  const chev = () => icon('chevron-right', 13)
  const trail = []
  const here = (text) => h('span', { class: 'crumbs__here', text })
  if (route.kind === 'overview') return [here(d?.name ?? 'Computer')]
  trail.push(link(`/d/${dev}`, {}, d?.name ?? 'Computer'), chev())
  if (route.kind === 'workers') trail.push(here('Workers'))
  else if (route.kind === 'w') {
    const w = device.workers?.find((x) => x.id === route.id)
    trail.push(link(`/d/${dev}/w`, {}, 'Workers'), chev(), here(w?.name ?? 'Worker'))
  } else if (route.kind === 's') {
    trail.push(here(device.sessions?.find((x) => x.id === route.id)?.title ?? 'Session'))
  } else if (route.kind === 't') {
    const session = device.sessions?.find((x) => x.panes.some((p) => p.id === route.id))
    const pane = session?.panes.find((p) => p.id === route.id)
    if (session) trail.push(link(`/d/${dev}/s/${encodeURIComponent(session.id)}`, {}, session.title), chev())
    trail.push(here(pane ? pane.task || pane.name : 'Terminal'))
  }
  return trail
}

function diff(c) {
  if (!c || (!c.added && !c.removed)) return null
  return h('span', { class: 'diff' }, h('span', { class: 'diff__add', text: `+${c.added}` }), h('span', { class: 'diff__del', text: `−${c.removed}` }))
}

/** Re-renders `build()` into `container` whenever the relay or the computer's data changes, until the page is left. */
function live(container, build) {
  let filled = false
  const draw = () => {
    const nodes = [build()].flat(Infinity).filter(Boolean)
    container.replaceChildren(...nodes)
    const real = !container.querySelector('.skeleton')
    if (real && !filled) {
      filled = true
      container.classList.add('fill-in')
    }
  }
  draw()
  onLeave(relay.on(draw))
  onLeave(device.on(draw))
  return container
}

/** The banner a page shows while the relay is down or the computer is offline. */
function offlineNotice(dev) {
  return live(h('div'), () => {
    const d = relay.devices.get(dev)
    if (!relay.connected) return h('div', { class: 'notice' }, icon('wifi-off', 16), h('span', {}, 'Reconnecting to Eaon Remote…'))
    if (d && !d.online)
      return h(
        'div',
        { class: 'notice' },
        icon('wifi-off', 16),
        h('span', {}, h('b', { text: `${d.name} is offline.` }), ' Open Eaon on it, and check Settings → Remote devices is on.')
      )
    return null
  })
}

// ------------------------------------------------------------------ pages

function overviewPage(dev) {
  const head = live(h('div'), () => {
    const d = relay.devices.get(dev)
    if (!d && relay.devices.size)
      return h('div', { class: 'card' }, empty('monitor', 'This computer isn’t linked any more', 'It was unlinked, from Eaon or from here.', link('/', { class: 'btn' }, 'Your computers')))
    return [
      h('h1', { class: 'title', text: d?.name ?? 'Computer' }),
      h(
        'div',
        { class: 'meta' },
        h('span', { class: 'meta__item' }, h('span', { class: 'state', dataset: { s: d?.online ? 'online' : 'offline' } }), d?.online ? 'Online' : 'Offline'),
        PLATFORMS[d?.platform] && h('span', { class: 'meta__item', text: PLATFORMS[d.platform] }),
        d?.createdAt && h('span', { class: 'meta__item', text: `Linked ${ago(d.createdAt)}` })
      )
    ]
  })
  const sessions = live(h('div', { class: 'card' }), () => {
    if (!device.sessions) return device.sessionsError ? loadError('sessions', device.sessionsError) : skeletonRows(3)
    if (!device.sessions.length) return empty('folder', 'No ADE sessions yet', 'Open a project in the ADE on this computer and its sessions show up here.')
    return device.sessions.map((x) =>
      link(
        `/d/${dev}/s/${encodeURIComponent(x.id)}`,
        { class: 'card__row' },
        h('span', { class: 'state', dataset: { s: x.state } }),
        h('span', { class: 'card__row-body' }, h('span', { class: 'card__row-title', text: x.title }), h('span', { class: 'card__row-desc', text: x.subtitle })),
        h('span', { class: 'card__row-trail' }, diff(x.changes), x.panes.length ? `${x.panes.length} ${x.panes.length === 1 ? 'terminal' : 'terminals'}` : '', icon('chevron-right', 15))
      )
    )
  })
  const workers = live(h('div', { class: 'card' }), () => workerRows(dev))
  return {
    node: h(
      'div',
      { class: 'page' },
      offlineNotice(dev),
      head,
      h('section', { class: 'section' }, h('div', { class: 'section__label', text: 'Sessions' }), sessions),
      h('section', { class: 'section' }, h('div', { class: 'section__label', text: 'Workers' }), workers)
    )
  }
}

function workerRows(dev) {
  if (!device.workers) return device.workersError ? loadError('Workers', device.workersError) : skeletonRows(2)
  if (!device.workers.length) return empty('bot', 'No Workers yet', 'Workers are agents that keep working on their own. Make one in Eaon and talk to it from here.')
  return device.workers.map((w) =>
    link(
      `/d/${dev}/w/${encodeURIComponent(w.id)}`,
      { class: 'card__row' },
      face(w, 30),
      h('span', { class: 'card__row-body' }, h('span', { class: 'card__row-title', text: w.name }), h('span', { class: 'card__row-desc', text: w.activity || w.purpose })),
      h(
        'span',
        { class: 'card__row-trail' },
        w.asks.length ? h('span', { class: 'chip' }, h('span', { class: 'badge', dataset: { tone: 'attention' }, text: w.asks.length }), h('span', { class: 'chip__text', text: 'Waiting on you' })) : null,
        w.unread ? h('span', { class: 'badge', text: `${w.unread} new` }) : null,
        h('span', { class: 'status-dot', dataset: { s: workerState(w) }, title: workerState(w) }),
        icon('chevron-right', 15)
      )
    )
  )
}

/** Offline isn't an error: it's said once, in the banner, and the lists just wait for the computer. */
function loadError(what, message) {
  if (/offline/i.test(message)) return empty('wifi-off', `Its ${what} show up when it’s back online`, null)
  return empty('alert', `Couldn’t load the ${what}`, message)
}

function workersPage(dev) {
  return {
    node: h('div', { class: 'page' }, offlineNotice(dev), h('h1', { class: 'title', text: 'Workers' }), h('p', { class: 'lede', text: 'Agents on this computer that keep working on their own. Answer them and send them work from here.' }), h('section', { class: 'section' }, live(h('div', { class: 'card' }), () => workerRows(dev))))
  }
}

function sessionPage(dev, id) {
  const newBtn = h('button', { class: 'btn', type: 'button' }, icon('plus', 15), h('span', { class: 'btn__label', text: 'New terminal' }))
  newBtn.onclick = () => newTerminalMenu(newBtn, dev, id, { align: 'end' })
  const head = live(h('div'), () => {
    const x = device.sessions?.find((y) => y.id === id)
    if (!device.sessions) return [h('span', { class: 'skeleton', style: { width: '40%', height: '22px' } }), h('span', { class: 'skeleton', style: { width: '60%', marginTop: '14px' } })]
    if (!x) return h('div', { class: 'card' }, empty('folder', 'This session isn’t on the computer any more', null, link(`/d/${dev}`, { class: 'btn' }, 'Back to the computer')))
    return [
      h('h1', { class: 'title', text: x.title }),
      h(
        'div',
        { class: 'meta' },
        x.branch && h('span', { class: 'meta__item' }, icon('branch', 14), x.branch),
        h('span', { class: 'meta__item', text: x.subtitle.split(' · ')[0] }),
        diff(x.changes)
      )
    ]
  })
  const panes = live(h('div', { class: 'panes' }), () => {
    const x = device.sessions?.find((y) => y.id === id)
    if (!x) return device.sessions ? null : [1, 2].map(() => h('div', { class: 'pane-card' }, h('div', { class: 'term-head' }, h('span', { class: 'skeleton', style: { width: '50%' } }))))
    const add = h('button', { class: 'pane-card pane-card--new', type: 'button' }, icon('plus', 18), 'New terminal')
    add.onclick = () => newTerminalMenu(add, dev, id)
    return [
      ...x.panes.map((p) =>
        link(
          `/d/${dev}/t/${encodeURIComponent(p.id)}`,
          { class: 'pane-card', dataset: { s: p.status } },
          h(
            'div',
            { class: 'term-head' },
            h('span', { class: 'state', dataset: { s: paneState(p) } }),
            h('span', { class: 'term-head__name', text: p.name }),
            p.name !== p.agentLabel && h('span', { class: 'term-head__agent', text: p.agentLabel }),
            h('span', { class: 'term-head__spacer' }),
            h('span', { class: 'term-head__status', text: { working: 'Working', idle: 'Waiting', stopped: 'Not running', exited: 'Ended' }[p.status] ?? '' })
          ),
          h('div', { class: 'pane-card__body', text: p.task || (p.status === 'stopped' ? 'Not started since Eaon opened' : 'Ready for a prompt') })
        )
      ),
      add
    ]
  })
  return {
    actions: [newBtn],
    node: h('div', { class: 'page' }, offlineNotice(dev), head, h('section', { class: 'section' }, h('div', { class: 'section__label', text: 'Terminals' }), panes))
  }
}

const KEYS = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['⇧Tab', '\x1b[Z'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['Ctrl-C', '\x03'],
  ['Enter', '\r']
]

function terminalPage(dev, pane) {
  const dot = h('span', { class: 'state' })
  const name = h('span', { class: 'term-head__name', text: 'Terminal' })
  const agent = h('span', { class: 'term-head__agent' })
  const status = h('span', { class: 'term-head__status', text: 'Connecting…' })
  const screen = h('div', { class: 'term-screen' }, h('div', { class: 'term-screen__wait' }, h('span', { class: 'spinner' })))
  const view = h(
    'div',
    { class: 'term-pane' },
    h('div', { class: 'term-head' }, dot, name, agent, h('span', { class: 'term-head__spacer' }), status),
    screen
  )
  let term = null
  const keys = h(
    'div',
    { class: 'term-keys', role: 'toolbar', 'aria-label': 'Keys' },
    KEYS.map(([label, data]) => h('button', { class: 'keycap', type: 'button', text: label, onclick: () => (relay.input(dev, pane, data), term?.focus()) }))
  )
  const line = h('input', { class: 'composer__input', placeholder: 'Type to this terminal, then send', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send' })
  const send = h('button', { class: 'send', type: 'submit', 'aria-label': 'Send' }, icon('arrow-up', 16, 2.2))
  const form = h(
    'form',
    {
      class: 'composer composer--mono',
      onsubmit: (e) => {
        e.preventDefault()
        if (!line.value) return relay.input(dev, pane, '\r')
        // Pasted, then Enter: a CLI sees one paste rather than a burst of keys.
        relay.input(dev, pane, `\x1b[200~${line.value}\x1b[201~`)
        setTimeout(() => relay.input(dev, pane, '\r'), 60)
        line.value = ''
      }
    },
    line,
    send
  )
  const page = h('div', { class: 'term-page' }, offlineNotice(dev), view, keys, form)

  const setState = (s, text) => {
    dot.dataset.s = s
    status.replaceChildren(text)
  }
  // The pane's own status from the sessions list (working, waiting) when the stream doesn't say.
  const fromList = () => {
    const p = device.sessions?.flatMap((x) => x.panes).find((x) => x.id === pane)
    if (!p) return
    name.textContent = p.task || p.name
    agent.textContent = p.agentLabel
    line.placeholder = p.agent === 'shell' ? 'Type a command, then send' : `Message ${p.agentLabel}`
    if (status.dataset.stream !== 'live') return
    setState(paneState(p), p.status === 'working' ? 'Working' : 'Live')
  }
  onLeave(device.on(fromList))
  fromList()

  const size = { cols: 120, rows: 32 }
  const fontFor = () => Math.max(8, Math.min(14, Math.floor((screen.clientWidth - 20) / (size.cols * 0.6))))
  const make = () => {
    if (!window.Terminal) return setTimeout(make, 50)
    if (!page.isConnected) return
    term = new window.Terminal({
      cols: size.cols,
      rows: size.rows,
      fontSize: fontFor(),
      fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace",
      theme: xtermTheme(),
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
      cursorBlink: true
    })
    term.open(screen)
    term.onData((data) => relay.input(dev, pane, data))
    const retheme = () => term && (term.options.theme = xtermTheme())
    themeListeners.add(retheme)
    onLeave(() => themeListeners.delete(retheme))
    onLeave(
      relay.watch(dev, pane, {
        snap: (m) => {
          screen.querySelector('.term-screen__wait')?.remove()
          size.cols = m.cols || size.cols
          size.rows = m.rows || size.rows
          term.reset()
          term.resize(size.cols, size.rows)
          term.options.fontSize = fontFor()
          term.write(m.data)
          status.dataset.stream = m.running ? 'live' : 'stopped'
          if (m.running) setState('idle-pane', 'Live')
          else setState('stopped', 'Not running')
          if (!name.textContent || name.textContent === 'Terminal') name.textContent = m.name || 'Terminal'
          fromList()
        },
        term: (m) => {
          screen.querySelector('.term-screen__wait')?.remove()
          term.write(m.data)
          if (status.dataset.stream !== 'live') {
            status.dataset.stream = 'live'
            setState('idle-pane', 'Live')
          }
        },
        exit: () => {
          status.dataset.stream = 'ended'
          setState('exited', 'Ended')
        }
      })
    )
    const onResize = () => (term.options.fontSize = fontFor())
    addEventListener('resize', onResize)
    onLeave(() => {
      removeEventListener('resize', onResize)
      term.dispose()
      term = null
    })
  }
  requestAnimationFrame(make)
  // A pane the computer hasn't started since Eaon opened: start it from here.
  relay
    .request(dev, 'GET', `/ade/panes/${encodeURIComponent(pane)}`)
    .then((p) => {
      name.textContent = p.task || p.name
      agent.textContent = p.agentLabel
      if (p.status === 'stopped') {
        const btn = h('button', { class: 'btn btn--sm', type: 'button' }, icon('play', 12, 2), 'Start it')
        btn.onclick = () => {
          btn.disabled = true
          relay.request(dev, 'POST', `/ade/panes/${encodeURIComponent(pane)}/start`).then(
            () => (relay.raw({ t: 'sub', dev, pane }), device.refresh()),
            (e) => (toast(e.message), (btn.disabled = false))
          )
        }
        dot.dataset.s = 'stopped'
        status.replaceChildren('Not running', btn)
        screen.querySelector('.term-screen__wait')?.replaceChildren(h('span', { text: 'This terminal hasn’t started since Eaon opened.' }))
      }
    })
    .catch((e) => setState('exited', e.message))
  return { node: page, full: true }
}

function workerPage(dev, id) {
  const head = h('div')
  const asks = h('div')
  const thread = h('div', { class: 'thread' })
  const box = h('textarea', { class: 'composer__input', rows: 1, placeholder: 'Message this worker', enterkeyhint: 'send' })
  const send = h('button', { class: 'send', type: 'submit', 'aria-label': 'Send', disabled: true }, icon('arrow-up', 16, 2.2))
  const composer = h('form', { class: 'composer' }, box, send)
  const fit = () => {
    box.style.height = 'auto'
    box.style.height = `${Math.min(180, box.scrollHeight)}px`
    send.disabled = !box.value.trim()
  }
  box.addEventListener('input', fit)
  composer.onsubmit = async (e) => {
    e.preventDefault()
    const text = box.value.trim()
    if (!text) return
    send.disabled = true
    try {
      await relay.request(dev, 'POST', `/remote/v1/workers/${encodeURIComponent(id)}/send`, { text })
      box.value = ''
      fit()
      load()
    } catch (error) {
      toast(error.message)
      send.disabled = false
    }
  }
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault()
      composer.requestSubmit()
    }
  })
  const scroller = () => shell?.root.querySelector('.main__scroll')
  const page = h('div', { class: 'page worker-page' }, offlineNotice(dev), head, asks, thread, h('div', { class: 'worker-composer' }, composer))

  let seen = ''
  let known = null
  let headKey = ''
  const answer = (askId, body, btn) => {
    btn.closest('.ask')?.querySelectorAll('button').forEach((b) => (b.disabled = true))
    relay
      .request(dev, 'POST', `/remote/v1/workers/${encodeURIComponent(id)}/answer`, { askId, ...body })
      .then(() => (load(), device.refresh()))
      .catch((e) => (toast(e.message), btn.closest('.ask')?.querySelectorAll('button').forEach((b) => (b.disabled = false))))
  }
  async function load() {
    const [{ worker }, threadPage] = await Promise.all([
      relay.request(dev, 'GET', `/remote/v1/workers/${encodeURIComponent(id)}`),
      relay.request(dev, 'GET', `/remote/v1/workers/${encodeURIComponent(id)}/thread?limit=40`)
    ])
    if (!page.isConnected) return
    box.placeholder = `Message ${worker.name}`
    const hk = JSON.stringify([worker.name, worker.color, worker.mood, worker.status, worker.paused, worker.activity, worker.purpose, worker.asks])
    if (hk !== headKey) {
      headKey = hk
      const state = workerState(worker)
      head.replaceChildren(
        h(
          'div',
          { class: 'worker-head' },
          face(worker, 46),
          h(
            'div',
            { class: 'head__body' },
            h('h1', { class: 'title', text: worker.name }),
            h(
              'div',
              { class: 'meta', style: { marginTop: '6px' } },
              h('span', { class: 'meta__item' }, h('span', { class: 'status-dot', dataset: { s: state } }), { working: 'Working', idle: 'Idle', asleep: 'Asleep', paused: 'Paused', failed: 'Failed' }[state] ?? state),
              h('span', { class: 'meta__item', text: worker.activity || worker.purpose })
            )
          )
        )
      )
      asks.replaceChildren(
        ...worker.asks.map((ask) =>
          h(
            'div',
            { class: 'ask' },
            h('div', { class: 'ask__head' }, icon(ask.approve ? 'hand' : 'alert', 14), ask.approve ? `${worker.name} wants to do something` : `${worker.name} has a question`, h('span', { class: 'main__spacer' }), ago(ask.at)),
            h('div', { class: 'ask__q', text: ask.question }),
            ask.approve && h('div', { class: 'ask__cmd', text: ask.approve.summary }),
            h(
              'div',
              { class: 'ask__actions' },
              ask.approve
                ? [
                    h('button', { class: 'btn btn--primary', type: 'button', text: 'Allow', onclick: (e) => answer(ask.id, { approved: true }, e.currentTarget) }),
                    h('button', { class: 'btn', type: 'button', text: 'Don’t allow', onclick: (e) => answer(ask.id, { approved: false }, e.currentTarget) })
                  ]
                : ask.options.map((o) => h('button', { class: 'btn', type: 'button', text: o, onclick: (e) => answer(ask.id, { text: o }, e.currentTarget) }))
            )
          )
        )
      )
    }
    const key = JSON.stringify(threadPage.messages.map((m) => [m.id, m.parts.length, m.streaming, m.error, m.parts.map((p) => p.status ?? (p.text ?? '').length)]))
    if (key !== seen) {
      seen = key
      const sc = scroller()
      const atBottom = !sc || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 120
      const first = known === null
      known ??= new Set()
      thread.replaceChildren(
        ...(threadPage.messages.length
          ? threadPage.messages.map((m) => {
              const isNew = !first && !known.has(m.id)
              known.add(m.id)
              if (m.role === 'user')
                return h('div', { class: 'msg msg--user', dataset: isNew ? { new: '' } : {} }, m.from && h('span', { class: 'msg__from', text: m.from.name }), m.parts.map((p) => p.text ?? '').join('\n'))
              return h(
                'div',
                { class: 'msg msg--assistant', dataset: isNew ? { new: '' } : {} },
                m.parts.map((p) =>
                  p.kind === 'text'
                    ? h('div', { text: p.text })
                    : h(
                        'div',
                        { class: 'step', dataset: { s: p.status } },
                        h('span', { class: 'step__icon' }, p.status === 'running' ? h('span', { class: 'spinner' }) : icon(p.status === 'done' ? 'check' : 'x', 14, 2)),
                        h('span', { class: 'step__title', text: p.title }),
                        p.detail && h('span', { class: 'step__detail', text: p.detail })
                      )
                ),
                m.streaming && !m.parts.some((p) => p.status === 'running') && h('span', { class: 'caret' }),
                m.error && h('div', { class: 'msg__error' }, icon('alert', 14), m.error)
              )
            })
          : [h('div', { class: 'empty' }, face(worker, 56), h('div', { class: 'empty__title', style: { marginTop: '10px' }, text: `Say hello to ${worker.name}` }), h('div', { class: 'empty__text', text: worker.purpose }))])
      )
      if (atBottom && sc) requestAnimationFrame(() => sc.scrollTo({ top: sc.scrollHeight, behavior: first ? 'instant' : 'smooth' }))
    }
    if (worker.unread) relay.request(dev, 'POST', `/remote/v1/workers/${encodeURIComponent(id)}/read`).catch(() => {})
  }

  // Skeleton until the first answer.
  head.append(h('span', { class: 'skeleton', style: { width: '36%', height: '22px' } }))
  let stopped = false
  let timer = 0
  const tick = async () => {
    if (stopped) return
    await load().catch((e) => {
      if (known === null) thread.replaceChildren(h('div', { class: 'card' }, empty('alert', 'Couldn’t load this worker', e.message)))
    })
    if (!stopped) timer = setTimeout(tick, 2000)
  }
  timer = setTimeout(tick, 0)
  onLeave(() => {
    stopped = true
    clearTimeout(timer)
  })
  return { node: page }
}

// ------------------------------------------------------------------ signed out, linking

/** A page with no sidebar: a brand bar and one thing in the middle. */
function solo(...children) {
  return h(
    'div',
    { class: 'solo' },
    h(
      'header',
      { class: 'solo__bar' },
      link('/', { class: 'brand' }, symbol('brand__symbol'), 'Eaon', h('span', { class: 'brand__sub', text: 'Remote' })),
      h('span', { class: 'main__spacer' }),
      me && accountButton()
    ),
    h('main', { class: 'solo__main' }, ...children)
  )
}

function signedOut() {
  const next = location.pathname + location.search
  return h(
    'div',
    { class: 'solo' },
    h('header', { class: 'solo__bar' }, h('span', { class: 'brand' }, symbol('brand__symbol'), 'Eaon', h('span', { class: 'brand__sub', text: 'Remote' }))),
    h(
      'main',
      { class: 'solo__main' },
      h(
        'div',
        { class: 'hero' },
        h(
          'div',
          { class: 'hero__copy' },
          h('h1', { class: 'hero__title', text: 'Your agents, wherever you are' }),
          h('p', { class: 'hero__lede', text: 'Watch the ADE’s terminals live, type into them, start new ones and answer your Workers, from your phone or any browser.' }),
          h('a', { class: 'btn btn--primary btn--lg', href: `/auth/github?next=${encodeURIComponent(next)}` }, githubIcon(), 'Sign in with GitHub'),
          h('p', { class: 'hero__fine', text: 'Only your public GitHub profile is read, to know which computers are yours.' })
        ),
        demo()
      )
    )
  )
}

/** A small Eaon Remote doing its thing, on a loop: the preview beside the sign-in. */
function demo() {
  const screen = h('div', { class: 'demo__screen' })
  const typed = h('span')
  const sideRow = (state, text, on) => h('div', { class: 'demo__row', dataset: on ? { on: '' } : {} }, h('span', { class: 'state', dataset: { s: state } }), text)
  const working = sideRow('working', 'eaon-desktop', true)
  const root = h(
    'div',
    { class: 'demo', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'demo__side' },
      h(
        'div',
        {},
        h('div', { class: 'demo__brand' }, symbol(), 'Eaon', h('span', { class: 'brand__sub', text: 'Remote' })),
        h('div', { class: 'demo__label', text: 'Sessions' }),
        working,
        sideRow('live', 'tokn'),
        sideRow('idle', 'portfolio-site'),
        h('div', { class: 'demo__label', text: 'Workers' }),
        h('div', { class: 'demo__row' }, face({ color: '#3E86C6', mood: 'happy' }, 14), 'Scout'),
        h('div', { class: 'demo__row' }, face({ color: '#3fb950', mood: 'neutral' }, 14), 'Ledger')
      )
    ),
    h(
      'div',
      { class: 'demo__main' },
      h(
        'div',
        { class: 'demo__term' },
        h('div', { class: 'term-head' }, h('span', { class: 'state', dataset: { s: 'working' } }), h('span', { class: 'term-head__name', text: 'Claude Code' }), h('span', { class: 'term-head__agent', text: 'eaon-desktop' }), h('span', { class: 'term-head__spacer' }), h('span', { class: 'term-head__status', text: 'Live' })),
        screen
      ),
      h('div', { class: 'demo__composer' }, typed, h('span', { class: 'send', style: { flex: 'none' } }, icon('arrow-up', 13, 2.4)))
    )
  )
  const span = (cls, text) => h('span', { class: cls, text })
  const SCRIPT = [
    [() => [span('ok', '⏺ '), 'Read ', h('b', { text: 'src/relay/client.ts' })], 500],
    [() => [span('dim', '  ⎿  111 lines')], 400],
    [() => [span('ok', '⏺ '), 'The backoff never resets after a clean close.'], 700],
    [() => [span('ok', '⏺ '), 'Update ', h('b', { text: 'client.ts' }), span('dim', '  +4 −1')], 700],
    [() => [span('work', '✶ Running the tests…')], 1100],
    [() => [span('ok', '✓ 17 passed')], 900],
    [() => [span('ok', '⏺ '), 'Fixed. Want me to open a PR?'], 900]
  ]
  const PROMPT = 'Yes, open the PR'
  let timer = 0
  const wait = (ms) => new Promise((r) => (timer = setTimeout(r, ms)))
  const add = (nodes) => {
    screen.append(h('div', { class: 'demo__line' }, ...nodes))
    while (screen.children.length > 13) screen.firstChild.remove()
  }
  const run = async () => {
    for (;;) {
      if (!root.isConnected) return
      screen.replaceChildren(h('div', {}, span('dim', '> '), 'Fix the flaky reconnect and add a test'), h('div', { text: ' ' }))
      working.querySelector('.state').dataset.s = 'working'
      for (const [line, ms] of SCRIPT) {
        await wait(ms)
        if (!root.isConnected) return
        add(line())
      }
      working.querySelector('.state').dataset.s = 'live'
      await wait(900)
      for (let i = 1; i <= PROMPT.length; i++) {
        typed.textContent = PROMPT.slice(0, i)
        await wait(45 + Math.random() * 50)
      }
      await wait(450)
      typed.textContent = ''
      add([span('dim', '> '), PROMPT])
      working.querySelector('.state').dataset.s = 'working'
      await wait(800)
      add([span('ok', '⏺ '), 'Opened ', h('b', { text: '#482' }), ' “Reset the relay backoff”'])
      working.querySelector('.state').dataset.s = 'live'
      await wait(3600)
    }
  }
  if (reduceMotion.matches) {
    screen.replaceChildren(h('div', {}, span('dim', '> '), 'Fix the flaky reconnect and add a test'))
    for (const [line] of SCRIPT) add(line())
  } else setTimeout(run, 700)
  onLeave(() => clearTimeout(timer))
  return root
}

function noComputers() {
  const typed = h('input', { class: 'input', placeholder: 'ABCD-1234', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 9, 'aria-label': 'Link code' })
  return h(
    'div',
    { class: 'link-card' },
    h('div', { class: 'link-card__icon' }, icon('laptop', 24, 1.6)),
    h('h1', { class: 'link-card__title', text: 'Link your first computer' }),
    h('p', { class: 'link-card__text', text: 'In Eaon Desktop, open Settings → Remote devices and choose Link with GitHub. It opens this site with the code filled in, or type the code it shows.' }),
    h('form', { class: 'code-input', onsubmit: (e) => (e.preventDefault(), typed.value.trim() && go(`/link?code=${encodeURIComponent(typed.value.trim())}`)) }, typed, h('button', { class: 'btn btn--primary', type: 'submit', text: 'Continue' }))
  )
}

function codeChars(code) {
  const chars = code.replace('-', '').split('')
  return h(
    'div',
    { class: 'code', 'aria-label': `Code ${code}` },
    chars.slice(0, 4).map((c, i) => h('span', { class: 'code__char', style: { '--i': i }, text: c })),
    h('span', { class: 'code__dash' }),
    chars.slice(4).map((c, i) => h('span', { class: 'code__char', style: { '--i': i + 4 }, text: c }))
  )
}

function linkPage(code) {
  const box = h('div', { style: { width: '100%', display: 'flex', justifyContent: 'center' } })
  const typed = h('input', { class: 'input', placeholder: 'ABCD-1234', value: code ?? '', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 9, 'aria-label': 'Link code' })
  const card = (...children) => h('div', { class: 'link-card' }, ...children)
  const showForm = (message) => {
    box.replaceChildren(
      card(
        h('div', { class: 'link-card__icon' }, icon('link', 22, 1.7)),
        h('h1', { class: 'link-card__title', text: 'Link a computer' }),
        h('p', { class: 'link-card__text', text: 'In Eaon on your computer: Settings → Remote devices → Link with GitHub. Type the code it shows.' }),
        h('form', { class: 'code-input', onsubmit: (e) => (e.preventDefault(), go(`/link?code=${encodeURIComponent(typed.value.trim())}`, true)) }, typed, h('button', { class: 'btn btn--primary', type: 'submit', text: 'Continue' })),
        message && h('div', { class: 'link-card__error' }, icon('alert', 14), message)
      )
    )
    requestAnimationFrame(() => typed.focus())
  }
  if (!code) {
    showForm()
    return box
  }
  box.append(card(h('div', { class: 'link-card__icon' }, h('span', { class: 'spinner' })), h('p', { class: 'link-card__text', text: 'Checking the code…' })))
  api(`/api/link/info?code=${encodeURIComponent(code)}`)
    .then((info) => {
      const confirm = h('button', { class: 'btn btn--primary btn--lg', type: 'button', text: 'Link it' })
      const deny = h('button', { class: 'btn btn--lg', type: 'button', text: 'That’s not mine' })
      confirm.onclick = async () => {
        confirm.disabled = deny.disabled = true
        try {
          const { device: made } = await api('/api/link/confirm', { method: 'POST', body: JSON.stringify({ code: info.code }) })
          await refreshDevices()
          box.replaceChildren(
            card(
              s('svg', { class: 'done-mark', viewBox: '0 0 56 56', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, s('circle', { cx: 28, cy: 28, r: 25 }), s('path', { d: 'M17 29l7 7 15-16' })),
              h('h1', { class: 'link-card__title', text: `${info.name} is linked` }),
              h('p', { class: 'link-card__text', text: 'Eaon is connecting now. You can close the window it opened.' }),
              h('div', { class: 'link-card__actions' }, link(`/d/${made?.id ?? ''}`, { class: 'btn btn--primary btn--lg' }, `Open ${info.name}`))
            )
          )
        } catch (error) {
          confirm.disabled = deny.disabled = false
          toast(error.message)
        }
      }
      deny.onclick = async () => {
        confirm.disabled = deny.disabled = true
        await api('/api/link/deny', { method: 'POST', body: JSON.stringify({ code: info.code }) }).catch(() => {})
        box.replaceChildren(
          card(
            h('div', { class: 'link-card__icon' }, icon('x', 22, 1.8)),
            h('h1', { class: 'link-card__title', text: 'Nothing was linked' }),
            h('p', { class: 'link-card__text', text: 'If you didn’t start this, you can ignore it. The code stops working by itself.' }),
            h('div', { class: 'link-card__actions' }, link('/', { class: 'btn btn--lg' }, 'Your computers'))
          )
        )
      }
      box.replaceChildren(
        card(
          h('div', { class: 'link-card__icon' }, icon(info.platform === 'darwin' ? 'laptop' : 'monitor', 24, 1.6)),
          h('h1', { class: 'link-card__title', text: `Link ${info.name}?` }),
          h('p', { class: 'link-card__text', text: `It will be linked to @${me.login}. From here you’ll see and type into its ADE terminals and talk to its Workers.` }),
          codeChars(info.code),
          h('p', { class: 'link-card__text', style: { fontSize: '12px', marginTop: '4px' }, text: 'Check that Eaon shows the same code.' }),
          h('div', { class: 'link-card__actions' }, deny, confirm)
        )
      )
    })
    .catch((error) => showForm(error.message))
  return box
}

// ------------------------------------------------------------------ start

;(async () => {
  applyTheme()
  try {
    me = (await api('/api/me')).user
  } catch {
    me = null
  }
  if (me) {
    relay.connect()
    await refreshDevices()
  }
  render()
})()
