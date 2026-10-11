// Eaon Remote (rc.eaon.dev): your Eaon Desktop computers, their ADE sessions
// and live terminals, and their Workers, from any browser.
//
// The page talks to each computer through the relay (/relay/web, a WebSocket
// opened with your sign-in cookie). Requests go out as {t:'req', dev, id,
// method, path, body} and come back as {t:'res', id, status, body}; a terminal
// is watched with {t:'sub'} and streams {t:'snap'} then {t:'term'} chunks.
// Everything is drawn with textContent: nothing an agent writes is ever HTML.

const app = document.getElementById('app')

// ------------------------------------------------------------------ helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

const link = (href, props, ...children) =>
  h('a', { ...props, href, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(href) } }, ...children)

function toast(text) {
  const el = h('div', { class: 'toast', role: 'status', text })
  document.body.append(el)
  setTimeout(() => el.remove(), 2600)
}

function ago(ms) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

async function api(path, init = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status })
  return body
}

const GITHUB_MARK =
  'M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z'

function githubIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'gh')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', GITHUB_MARK)
  path.setAttribute('fill', 'currentColor')
  svg.append(path)
  return svg
}

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
    for (const l of this.listeners) l()
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
      this.connected = false
      for (const [, p] of this.pending) p.reject(new Error('The connection dropped. Trying again…'))
      this.pending.clear()
      this.emit()
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
      else if (d) Object.assign(d, { online: m.online, ...(m.name ? { name: m.name } : {}) })
      else refreshDevices()
      this.emit()
    } else if (m.t === 'res') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.status >= 400) p.reject(Object.assign(new Error(m.body?.error?.message || `Error ${m.status}`), { status: m.status }))
      else p.resolve(m.body)
    } else if (m.t === 'snap' || m.t === 'term' || m.t === 'exit') {
      const handlers = this.subs.get(`${m.dev}/${m.pane}`)
      if (handlers) handlers[m.t]?.(m)
    }
  }

  raw(message) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message))
  }

  request(dev, method, path, body) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Connecting to Eaon Remote…'))
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

// ------------------------------------------------------------------ routing

let cleanup = []
const onLeave = (fn) => cleanup.push(fn)

function go(path, replace = false) {
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  render()
}
addEventListener('popstate', render)

function frame(...children) {
  const top = h(
    'header',
    { class: 'top' },
    link('/', { class: 'brand' }, h('span', { class: 'mark', text: 'e' }), 'Eaon Remote'),
    h('span', { class: 'top__spacer' }),
    me &&
      h(
        'span',
        { class: 'me' },
        me.avatar && h('img', { src: me.avatar, alt: '' }),
        `@${me.login}`,
        h('button', { class: 'btn btn--sm btn--ghost', onclick: signOut, text: 'Sign out' })
      )
  )
  return [top, ...children]
}

async function signOut() {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {})
  location.href = '/'
}

function render() {
  for (const fn of cleanup.splice(0)) fn()
  const path = location.pathname
  const params = new URLSearchParams(location.search)
  app.replaceChildren()
  if (!me) return app.replaceChildren(signedOut())
  if (path === '/link') return app.replaceChildren(...frame(linkPage(params.get('code'))))
  const m = path.match(/^\/d\/([\w-]+)(?:\/(s|t|w)(?:\/([^/]+))?)?\/?$/)
  if (m) {
    const [, dev, kind, id] = m
    if (kind === 't' && id) return app.replaceChildren(...frame(terminalPage(dev, decodeURIComponent(id))))
    if (kind === 's' && id) return app.replaceChildren(...frame(sessionPage(dev, decodeURIComponent(id))))
    if (kind === 'w' && id) return app.replaceChildren(...frame(workerPage(dev, decodeURIComponent(id))))
    if (kind === 'w') return app.replaceChildren(...frame(devicePage(dev, 'workers')))
    return app.replaceChildren(...frame(devicePage(dev, 'sessions')))
  }
  app.replaceChildren(...frame(homePage()))
}

/** Re-renders `build()` into a container whenever the relay changes, until the page is left. */
function live(container, build) {
  const draw = () => container.replaceChildren(...[build()].flat())
  draw()
  onLeave(relay.on(draw))
  return container
}

/** Calls `load` now and every `ms` while the page is open; `load` draws its own result. */
function poll(load, ms) {
  let stopped = false
  const tick = async () => {
    if (stopped) return
    await load().catch(() => {})
    if (!stopped) timer = setTimeout(tick, ms)
  }
  let timer = setTimeout(tick, 0)
  onLeave(() => {
    stopped = true
    clearTimeout(timer)
  })
}

// ------------------------------------------------------------------ pages

function signedOut() {
  const next = location.pathname + location.search
  return h(
    'main',
    { class: 'hero' },
    h('div', { class: 'mark', text: 'e' }),
    h('h1', { text: 'Eaon Remote' }),
    h('p', { class: 'lede', text: 'Your ADE sessions, live terminals and Workers on Eaon Desktop, from any browser.' }),
    h('a', { class: 'btn btn--primary', href: `/auth/github?next=${encodeURIComponent(next)}` }, githubIcon(), 'Sign in with GitHub'),
    h('p', { class: 'muted', style: 'margin-top:22px;font-size:12.5px', text: 'Only your public GitHub profile is used, to know which computers are yours.' })
  )
}

function linkPage(code) {
  const box = h('main', { class: 'hero', style: 'margin-top:8vh' })
  const typed = h('input', { class: 'input', placeholder: 'ABCD-1234', value: code ?? '', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' })
  const showForm = (message) =>
    box.replaceChildren(
      h('h1', { text: 'Link a computer' }),
      h('p', { class: 'lede', text: 'In Eaon on your computer: Settings → Remote devices → Link with GitHub. Type the code it shows.' }),
      h(
        'form',
        { class: 'field', onsubmit: (e) => (e.preventDefault(), go(`/link?code=${encodeURIComponent(typed.value.trim())}`, true)) },
        typed,
        h('button', { class: 'btn btn--primary', type: 'submit', text: 'Continue' })
      ),
      message && h('p', { class: 'error', text: message })
    )
  if (!code) {
    showForm()
    return box
  }
  box.append(h('p', { class: 'muted', text: 'Checking the code…' }))
  api(`/api/link/info?code=${encodeURIComponent(code)}`)
    .then((info) => {
      const confirm = h('button', { class: 'btn btn--primary', text: `Link ${info.name}` })
      const deny = h('button', { class: 'btn btn--ghost', text: 'That’s not mine' })
      confirm.onclick = async () => {
        confirm.disabled = deny.disabled = true
        try {
          await api('/api/link/confirm', { method: 'POST', body: JSON.stringify({ code: info.code }) })
          box.replaceChildren(
            h('div', { class: 'mark', text: '✓' }),
            h('h1', { text: 'Linked' }),
            h('p', { class: 'lede', text: `Eaon on ${info.name} is connecting. You can close the window it opened.` }),
            link('/', { class: 'btn btn--primary' }, 'Go to my computers')
          )
          refreshDevices()
        } catch (error) {
          confirm.disabled = deny.disabled = false
          toast(error.message)
        }
      }
      deny.onclick = async () => {
        await api('/api/link/deny', { method: 'POST', body: JSON.stringify({ code: info.code }) }).catch(() => {})
        box.replaceChildren(h('h1', { text: 'Not linked' }), h('p', { class: 'lede', text: 'Nothing was linked. If you didn’t start this, you can ignore it.' }))
      }
      box.replaceChildren(
        h('div', { class: 'mark', text: 'e' }),
        h('h1', { text: 'Link this computer?' }),
        h('p', { class: 'lede', text: `${info.name} will be linked to @${me.login}. From this site you’ll be able to see and type into its ADE terminals and talk to its Workers.` }),
        h('div', { class: 'code', text: info.code }),
        h('p', { class: 'muted', text: 'Check that Eaon shows the same code.' }),
        h('div', { class: 'field', style: 'justify-content:center' }, deny, confirm)
      )
    })
    .catch((error) => showForm(error.message))
  return box
}

function deviceRow(d) {
  return link(
    `/d/${d.id}`,
    { class: 'row' },
    h('span', { class: 'dot', dataset: { s: d.online ? 'online' : 'offline' } }),
    h('span', { class: 'row__main' }, h('div', { class: 'row__title', text: d.name }), h('div', { class: 'row__sub', text: d.online ? 'Online' : d.lastSeen ? `Offline · last seen ${ago(d.lastSeen)} ago` : 'Offline' })),
    h('span', { class: 'row__end', text: '›' })
  )
}

function homePage() {
  const wrap = h('main', { class: 'wrap' })
  wrap.append(h('h1', { text: 'Your computers' }), h('p', { class: 'lede', text: 'Computers running Eaon Desktop that you linked to this GitHub account.' }))
  const list = h('div', { class: 'card list' })
  live(list, () => {
    const devices = [...relay.devices.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    if (!devices.length)
      return h(
        'div',
        { class: 'empty' },
        h('div', { text: 'No computers linked yet.' }),
        h('div', { style: 'margin-top:6px', text: 'In Eaon Desktop: Settings → Remote devices → Link with GitHub.' })
      )
    return devices.map(deviceRow)
  })
  wrap.append(list)
  const status = h('p', { class: 'muted', style: 'margin-top:14px;font-size:12.5px' })
  live(status, () => (relay.connected ? '' : 'Connecting to Eaon Remote…'))
  wrap.append(status)
  return wrap
}

function deviceHeader(dev, ...trail) {
  const crumbs = h('nav', { class: 'crumbs' })
  live(crumbs, () => {
    const d = relay.devices.get(dev)
    return [link('/', {}, 'Computers'), '›', link(`/d/${dev}`, {}, d?.name ?? 'Computer'), ...trail.flatMap((t) => ['›', t])]
  })
  const banner = h('div')
  live(banner, () => {
    const d = relay.devices.get(dev)
    if (!relay.connected) return h('div', { class: 'banner', text: 'Connecting to Eaon Remote…' })
    if (d && !d.online) return h('div', { class: 'banner', text: `${d.name} is offline. Open Eaon on it (and check Settings → Remote devices is on).` })
    return []
  })
  return [crumbs, banner]
}

function devicePage(dev, tab) {
  const wrap = h('main', { class: 'wrap' }, ...deviceHeader(dev))
  wrap.append(
    h('nav', { class: 'tabs' }, link(`/d/${dev}`, { 'aria-current': tab === 'sessions' ? 'page' : null }, 'ADE sessions'), link(`/d/${dev}/w`, { 'aria-current': tab === 'workers' ? 'page' : null }, 'Workers'))
  )
  const body = h('div')
  wrap.append(body)
  if (tab === 'sessions') {
    poll(async () => {
      const data = await relay.request(dev, 'GET', '/ade/sessions')
      body.replaceChildren(sessionList(dev, data))
    }, 2500)
  } else {
    poll(async () => {
      const data = await relay.request(dev, 'GET', '/remote/v1/workers')
      body.replaceChildren(workerList(dev, data.workers))
    }, 3000)
  }
  return wrap
}

function changes(c) {
  if (!c || (!c.added && !c.removed && !c.files)) return null
  return h('span', {}, h('span', { class: 'add', text: `+${c.added}` }), ' ', h('span', { class: 'del', text: `−${c.removed}` }))
}

function sessionList(dev, data) {
  if (!data.sessions.length) return h('div', { class: 'card empty', text: 'No ADE sessions on this computer yet.' })
  return h(
    'div',
    { class: 'card list' },
    data.sessions.map((s) =>
      link(
        `/d/${dev}/s/${encodeURIComponent(s.id)}`,
        { class: 'row' },
        h('span', { class: 'dot', dataset: { s: s.state } }),
        h('span', { class: 'row__main' }, h('div', { class: 'row__title', text: s.title }), h('div', { class: 'row__sub', text: s.subtitle })),
        h('span', { class: 'row__end' }, changes(s.changes), s.panes.length ? `${s.panes.length} ${s.panes.length === 1 ? 'agent' : 'agents'}` : '', '›')
      )
    )
  )
}

function sessionPage(dev, id) {
  const title = h('span', { text: 'Session' })
  const wrap = h('main', { class: 'wrap' }, ...deviceHeader(dev, title))
  const body = h('div')
  wrap.append(body)
  let agents = []
  const picker = h('select', { class: 'input' })
  const start = h('button', { class: 'btn', text: 'New terminal' })
  start.onclick = async () => {
    start.disabled = true
    try {
      const { pane } = await relay.request(dev, 'POST', `/ade/sessions/${encodeURIComponent(id)}/panes`, { agent: picker.value })
      go(`/d/${dev}/t/${encodeURIComponent(pane.id)}`)
    } catch (error) {
      toast(error.message)
      start.disabled = false
    }
  }
  poll(async () => {
    const data = await relay.request(dev, 'GET', '/ade/sessions')
    const s = data.sessions.find((x) => x.id === id)
    if (!s) return body.replaceChildren(h('div', { class: 'card empty', text: 'This session isn’t on the computer any more.' }))
    title.textContent = s.title
    if (agents.length !== data.agents.length) {
      agents = data.agents
      picker.replaceChildren(...agents.map((a) => h('option', { value: a.id, text: a.installed ? a.label : `${a.label} (not installed)` })))
      picker.value = agents.find((a) => a.id === 'claude' && a.installed)?.id ?? 'shell'
    }
    body.replaceChildren(
      h('h1', { text: s.title }),
      h('p', { class: 'lede' }, s.subtitle, ' ', changes(s.changes)),
      h('div', { class: 'section', text: 'Terminals' }),
      s.panes.length
        ? h(
            'div',
            { class: 'card list' },
            s.panes.map((p) =>
              link(
                `/d/${dev}/t/${encodeURIComponent(p.id)}`,
                { class: 'row' },
                h('span', { class: 'dot', dataset: { s: p.status } }),
                h('span', { class: 'row__main' }, h('div', { class: 'row__title', text: p.task || p.name }), h('div', { class: 'row__sub', text: p.task ? `${p.name} · ${p.agentLabel}` : p.agentLabel })),
                h('span', { class: 'row__end' }, p.status === 'stopped' ? h('span', { class: 'tag', text: 'not running' }) : '', '›')
              )
            )
          )
        : h('div', { class: 'card empty', text: 'No terminals in this session.' }),
      h('div', { class: 'section', text: 'Start one' }),
      h('div', { class: 'field' }, picker, start)
    )
  }, 2500)
  return wrap
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
  const name = h('span', { text: 'Terminal' })
  const view = h('main', { class: 'term-view' })
  const head = h('div', { class: 'term-head' }, ...deviceHeader(dev, name))
  const screen = h('div', { class: 'term-screen' })
  const status = h('span', { class: 'muted', text: 'Connecting…' })
  head.firstChild.style.marginBottom = '0'
  head.append(h('span', { class: 'top__spacer' }), status)
  const keys = h(
    'div',
    { class: 'term-keys' },
    KEYS.map(([label, data]) => h('button', { type: 'button', text: label, onclick: () => (relay.input(dev, pane, data), term?.focus()) }))
  )
  const line = h('input', { class: 'input', placeholder: 'Type a message or command, then Send', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })
  const form = h(
    'form',
    {
      class: 'term-line',
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
    h('button', { class: 'btn btn--primary', type: 'submit', text: 'Send' })
  )
  view.append(head, screen, keys, form)

  let term = null
  const size = { cols: 120, rows: 32 }
  const fontFor = () => Math.max(7, Math.min(14, Math.floor((screen.clientWidth - 18) / (size.cols * 0.6))))
  const make = () => {
    if (!window.Terminal) return setTimeout(make, 50)
    term = new window.Terminal({
      cols: size.cols,
      rows: size.rows,
      fontSize: fontFor(),
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      theme: { background: '#0a0a0a' },
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true
    })
    term.open(screen)
    term.onData((data) => relay.input(dev, pane, data))
    onLeave(
      relay.watch(dev, pane, {
        snap: (m) => {
          size.cols = m.cols || size.cols
          size.rows = m.rows || size.rows
          term.reset()
          term.resize(size.cols, size.rows)
          term.options.fontSize = fontFor()
          term.write(m.data)
          status.textContent = m.running ? 'Live' : 'Not running'
          name.textContent = m.name || 'Terminal'
        },
        term: (m) => {
          term.write(m.data)
          status.textContent = 'Live'
        },
        exit: () => {
          status.textContent = 'Ended'
        }
      })
    )
    const onResize = () => (term.options.fontSize = fontFor())
    addEventListener('resize', onResize)
    onLeave(() => {
      removeEventListener('resize', onResize)
      term.dispose()
    })
  }
  requestAnimationFrame(make)
  // A pane the computer hasn't started since Eaon opened: start it from here.
  relay
    .request(dev, 'GET', `/ade/panes/${encodeURIComponent(pane)}`)
    .then((p) => {
      name.textContent = p.task || p.name
      if (p.status === 'stopped') {
        const btn = h('button', { class: 'btn btn--sm', text: 'Start it' })
        btn.onclick = () => relay.request(dev, 'POST', `/ade/panes/${encodeURIComponent(pane)}/start`).then(() => relay.raw({ t: 'sub', dev, pane }), (e) => toast(e.message))
        status.replaceChildren('Not running ', btn)
      }
    })
    .catch((e) => (status.textContent = e.message))
  return view
}

function workerList(dev, workers) {
  if (!workers.length) return h('div', { class: 'card empty', text: 'No Workers on this computer.' })
  return h(
    'div',
    { class: 'card list' },
    workers.map((w) =>
      link(
        `/d/${dev}/w/${encodeURIComponent(w.id)}`,
        { class: 'row' },
        h('span', { class: 'dot', dataset: { s: w.status === 'working' ? 'working' : w.status === 'failed' ? 'failed' : w.paused ? 'stopped' : 'idle' }, style: `background:${w.status === 'working' ? 'transparent' : w.color}` }),
        h('span', { class: 'row__main' }, h('div', { class: 'row__title', text: w.name }), h('div', { class: 'row__sub', text: w.activity || w.purpose })),
        h('span', { class: 'row__end' }, w.asks.length ? h('span', { class: 'tag', text: `${w.asks.length} waiting on you` }) : '', w.unread ? h('span', { class: 'tag', text: `${w.unread} new` }) : '', '›')
      )
    )
  )
}

function workerPage(dev, id) {
  const title = h('span', { text: 'Worker' })
  const wrap = h('main', { class: 'wrap' }, ...deviceHeader(dev, title))
  const head = h('div')
  const asks = h('div')
  const thread = h('div', { class: 'thread' })
  const box = h('textarea', { class: 'input', rows: 1, placeholder: 'Message this worker' })
  const send = h('button', { class: 'btn btn--primary', text: 'Send' })
  const composer = h('form', { class: 'composer' }, box, send)
  composer.onsubmit = async (e) => {
    e.preventDefault()
    const text = box.value.trim()
    if (!text) return
    send.disabled = true
    try {
      await relay.request(dev, 'POST', `/remote/v1/workers/${encodeURIComponent(id)}/send`, { text })
      box.value = ''
    } catch (error) {
      toast(error.message)
    } finally {
      send.disabled = false
    }
  }
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) composer.requestSubmit()
  })
  wrap.append(head, asks, thread, composer)
  let seen = ''
  poll(async () => {
    const [{ worker }, page] = await Promise.all([
      relay.request(dev, 'GET', `/remote/v1/workers/${encodeURIComponent(id)}`),
      relay.request(dev, 'GET', `/remote/v1/workers/${encodeURIComponent(id)}/thread?limit=40`)
    ])
    title.textContent = worker.name
    head.replaceChildren(h('h1', { text: worker.name }), h('p', { class: 'lede', text: worker.activity || worker.purpose }))
    asks.replaceChildren(
      ...worker.asks.map((ask) =>
        h(
          'div',
          { class: 'ask' },
          h('div', { text: ask.question }),
          ask.approve && h('div', { class: 'muted', style: 'margin-top:4px', text: ask.approve.summary }),
          h(
            'div',
            { class: 'ask__actions' },
            ask.approve
              ? [
                  h('button', { class: 'btn btn--sm btn--primary', text: 'Allow', onclick: () => answer(ask.id, { approved: true }) }),
                  h('button', { class: 'btn btn--sm', text: 'Don’t allow', onclick: () => answer(ask.id, { approved: false }) })
                ]
              : ask.options.map((o) => h('button', { class: 'btn btn--sm', text: o, onclick: () => answer(ask.id, { text: o }) }))
          )
        )
      )
    )
    const key = JSON.stringify(page.messages.map((m) => [m.id, m.parts.length, m.streaming, m.parts.map((p) => (p.text ?? p.status ?? '').length)]))
    if (key !== seen) {
      seen = key
      const atBottom = innerHeight + scrollY >= document.body.scrollHeight - 80
      thread.replaceChildren(
        ...page.messages.map((m) =>
          h(
            'div',
            { class: `msg${m.role === 'user' ? ' msg--user' : ''}` },
            m.parts.map((p) => (p.kind === 'text' ? h('div', { text: p.text }) : h('div', { class: 'msg__tool', text: `${p.status === 'running' ? '… ' : '· '}${p.title}${p.detail ? `: ${p.detail}` : ''}` }))),
            m.error && h('div', { class: 'error', text: m.error })
          )
        )
      )
      if (atBottom) scrollTo(0, document.body.scrollHeight)
    }
    if (worker.unread) relay.request(dev, 'POST', `/remote/v1/workers/${encodeURIComponent(id)}/read`).catch(() => {})
  }, 2000)
  const answer = (askId, body) => relay.request(dev, 'POST', `/remote/v1/workers/${encodeURIComponent(id)}/answer`, { askId, ...body }).catch((e) => toast(e.message))
  return wrap
}

// ------------------------------------------------------------------ start

;(async () => {
  try {
    me = (await api('/api/me')).user
  } catch {
    me = null
  }
  if (me) relay.connect()
  render()
})()
