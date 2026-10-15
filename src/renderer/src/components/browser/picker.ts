import type { PickedElement } from '@shared/browser'

/**
 * Design Mode's picker, run inside the page (`webview.executeJavaScript`).
 * Plain JavaScript in a string, so nothing the bundler adds can leak into a
 * page that doesn't have it; installed once per document as
 * `window.__eaonDesign`.
 *
 * While armed it outlines what the pointer is over, takes the click (the page
 * never sees it, so a button picked is not a button pressed) and reads the
 * element: a selector, its markup, computed styles, the components around it
 * and, in a dev build that says, the file and line it was written at.
 * ↑ and ↓ walk to the parent and back; Enter picks; Escape stops.
 */
export const PICKER_SOURCE = String.raw`(() => {
  const VERSION = 3
  if (window.__eaonDesign && window.__eaonDesign.version === VERSION) return true
  if (window.__eaonDesign) window.__eaonDesign.disarm()

  const STYLE_PROPS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'margin', 'padding', 'box-sizing', 'overflow',
    'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self', 'flex', 'gap',
    'grid-template-columns', 'grid-template-rows',
    'color', 'background-color', 'background-image', 'opacity',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'white-space',
    'border', 'border-radius', 'outline', 'box-shadow', 'transform', 'transition', 'cursor'
  ]
  const BORING = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static', 'visible', 'content-box', '0px none rgb(0, 0, 0)', 'start', 'nowrap', 'stretch', '0 1 auto', 'row', 'all', 'ease', '1'])

  let host = null, box = null, tag = null, cursor = null
  let armed = null
  let current = null
  const trail = []

  const ensureOverlay = (accent) => {
    if (!host || !host.isConnected) {
      host = document.createElement('eaon-design-overlay')
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:none'
      const root = host.attachShadow({ mode: 'closed' })
      root.innerHTML = '<style>' +
        '.box{position:fixed;box-sizing:border-box;border:1.5px solid var(--a);background:color-mix(in srgb,var(--a) 14%,transparent);border-radius:2px;transition:all 60ms ease-out}' +
        '.tag{position:fixed;max-width:360px;padding:3px 7px;border-radius:5px;background:#111;color:#fff;font:500 11px/1.4 ui-sans-serif,-apple-system,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.25)}' +
        '.tag b{color:var(--a);font-weight:600}.tag i{opacity:.6;font-style:normal}' +
        '</style><div class="box"></div><div class="tag"></div>'
      box = root.querySelector('.box')
      tag = root.querySelector('.tag')
      document.documentElement.appendChild(host)
    }
    host.style.setProperty('--a', accent || '#3b82f6')
  }

  const hideOverlay = () => { if (host) host.style.display = 'none' }

  const labelOf = (el) => {
    let out = el.tagName.toLowerCase()
    if (el.id) out += '#' + el.id
    const classes = [...el.classList].filter((c) => c.length < 40).slice(0, 2)
    if (classes.length) out += '.' + classes.join('.')
    return out
  }

  const show = (el) => {
    if (!el || !box) return
    const r = el.getBoundingClientRect()
    host.style.display = 'block'
    box.style.left = r.left + 'px'
    box.style.top = r.top + 'px'
    box.style.width = r.width + 'px'
    box.style.height = r.height + 'px'
    const comps = componentsOf(el)
    tag.innerHTML = ''
    const b = document.createElement('b'); b.textContent = labelOf(el)
    const dims = document.createElement('i'); dims.textContent = '  ' + Math.round(r.width) + '×' + Math.round(r.height)
    tag.append(b, dims)
    if (comps.length) { const c = document.createElement('span'); c.textContent = '  ' + comps[0]; tag.append(c) }
    const above = r.top > 26
    tag.style.left = Math.max(4, Math.min(r.left, innerWidth - 200)) + 'px'
    tag.style.top = (above ? r.top - 24 : Math.min(r.bottom + 4, innerHeight - 24)) + 'px'
  }

  const deepTarget = (event) => {
    const path = event.composedPath ? event.composedPath() : []
    for (const node of path) if (node instanceof Element && node !== host) return node
    return event.target instanceof Element ? event.target : null
  }

  const deepAt = (x, y) => {
    let el = document.elementFromPoint(x, y)
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === el) break
      el = inner
    }
    return el
  }

  // ---- What the element is ----

  const selectorOf = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id)
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 7) {
      let part = node.tagName.toLowerCase()
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) { parts.unshift('#' + CSS.escape(node.id)); break }
      const classes = [...node.classList].filter((c) => /^[a-zA-Z_-][\w-]{0,30}$/.test(c)).slice(0, 2)
      if (classes.length) part += '.' + classes.map((c) => CSS.escape(c)).join('.')
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      const sel = parts.join(' > ')
      try { if (document.querySelectorAll(sel).length === 1) return sel } catch (e) {}
      node = parent
    }
    return parts.join(' > ')
  }

  const fiberOf = (el) => {
    for (const key in el) if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return el[key]
    return null
  }

  const nameOfType = (type) => {
    if (!type || typeof type === 'string') return null
    if (typeof type === 'function') return type.displayName || type.name || null
    if (type.displayName) return type.displayName
    if (type.render) return type.render.displayName || type.render.name || null
    if (type.type) return nameOfType(type.type)
    return null
  }

  const componentsOf = (el) => {
    const out = []
    let fiber = fiberOf(el)
    while (fiber && out.length < 6) {
      const name = nameOfType(fiber.type)
      if (name && !/^(Fragment|Suspense|StrictMode|Provider|Consumer|Context|Anonymous|_c\d*)$/.test(name) && out[out.length - 1] !== name) out.push(name)
      fiber = fiber.return
    }
    if (out.length) return out
    let vue = el.__vueParentComponent
    while (vue && out.length < 6) {
      const name = vue.type && (vue.type.name || vue.type.__name || (vue.type.__file && vue.type.__file.split('/').pop()))
      if (name) out.push(name)
      vue = vue.parent
    }
    return out
  }

  const fromStack = (stack) => {
    if (typeof stack !== 'string') return null
    for (const line of stack.split('\n').slice(1)) {
      if (/react-stack-top-frame|jsx-dev-runtime|jsx-runtime|node_modules|\/\.vite\/deps\/|react-dom|chunk-|\/@react-refresh/.test(line)) continue
      const m = line.match(/\(?((?:https?|webpack-internal|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/)
      if (!m) continue
      let file = m[1]
      try {
        const u = new URL(file.replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?\.?/, 'http://x/'))
        file = decodeURIComponent(u.pathname).replace(/^\/@fs\//, '/').replace(/^\//, '')
      } catch (e) {}
      return { file, line: Number(m[2]), column: Number(m[3]), approximate: true }
    }
    return null
  }

  const fromAttributes = (el) => {
    const a = (n) => el.getAttribute && el.getAttribute(n)
    const spec = a('data-source') || a('data-loc') || a('data-insp-path') || a('data-locatorjs-id') || a('data-locator')
    if (spec) {
      const m = spec.match(/^(.*?):(\d+)(?::(\d+))?/)
      if (m) return { file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined }
      return { file: spec }
    }
    const rel = a('data-inspector-relative-path')
    if (rel) return { file: rel, line: Number(a('data-inspector-line')) || undefined, column: Number(a('data-inspector-column')) || undefined }
    const sentry = a('data-sentry-source-file')
    if (sentry) return { file: sentry, approximate: true }
    return null
  }

  const sourceOf = (el) => {
    const attr = fromAttributes(el)
    if (attr) return attr
    let fiber = fiberOf(el)
    const first = fiber
    while (fiber) {
      const s = fiber._debugSource
      if (s && s.fileName) return { file: s.fileName, line: s.lineNumber, column: s.columnNumber }
      fiber = fiber.return
    }
    const vue = el.__vueParentComponent
    if (vue && vue.type && vue.type.__file) return { file: vue.type.__file }
    if (el.__vue__ && el.__vue__.$options && el.__vue__.$options.__file) return { file: el.__vue__.$options.__file }
    const svelte = el.__svelte_meta && el.__svelte_meta.loc
    if (svelte && svelte.file) return { file: svelte.file, line: svelte.line, column: svelte.column, approximate: true }
    fiber = first
    while (fiber) {
      const s = fromStack(fiber._debugStack && fiber._debugStack.stack)
      if (s) return s
      fiber = fiber._debugOwner || fiber.return
    }
    let up = el.parentElement
    for (let i = 0; up && i < 4; i++, up = up.parentElement) {
      const s = fromAttributes(up)
      if (s) return Object.assign(s, { approximate: true })
    }
    return null
  }

  const trimHtml = (html, max) => {
    html = html.replace(/="data:[^"]{80,}"/g, '="data:…"').replace(/\sd="[^"]{120,}"/g, ' d="…"').replace(/\s{2,}/g, ' ')
    return html.length > max ? html.slice(0, max) + '…' : html
  }

  const describe = (el) => {
    const cs = getComputedStyle(el)
    const styles = {}
    for (const prop of STYLE_PROPS) {
      let value = cs.getPropertyValue(prop)
      if (!value || BORING.has(value)) continue
      if (prop === 'background-image' && value.length > 160) value = value.slice(0, 160) + '…'
      if (prop === 'font-family') value = value.split(',').slice(0, 3).join(',')
      styles[prop] = value
    }
    const r = el.getBoundingClientRect()
    const parent = el.parentElement
    return {
      url: location.href,
      title: document.title,
      selector: selectorOf(el),
      label: labelOf(el),
      components: componentsOf(el),
      source: sourceOf(el),
      html: trimHtml(el.outerHTML, 1800),
      parentTag: parent ? trimHtml(parent.outerHTML.slice(0, parent.outerHTML.indexOf('>') + 1), 240) : '',
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 280),
      styles,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: innerWidth, height: innerHeight }
    }
  }

  const settle = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))

  // ---- Armed: the page's own pointer and keys are ours ----

  const block = (event) => {
    if (!armed) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const onMove = (event) => {
    if (!armed) return
    const el = deepTarget(event)
    if (!el || el === current) return
    current = el
    trail.length = 0
    show(el)
  }

  const finish = async (value) => {
    const done = armed
    if (!done) return
    detach()
    hideOverlay()
    if (value && value.element) {
      await settle()
      value.element = describe(value.element)
    }
    done(value)
  }

  const onClick = (event) => {
    if (!armed) return
    block(event)
    const el = deepTarget(event) || current
    if (el) finish({ element: current && current.contains(el) && trail.length ? current : el })
  }

  const onKey = (event) => {
    if (!armed) return
    if (event.key === 'Escape') { block(event); finish({ cancelled: true }); return }
    if (event.key === 'ArrowUp' && current && current.parentElement && current.parentElement !== document.documentElement) {
      block(event); trail.push(current); current = current.parentElement; show(current); return
    }
    if (event.key === 'ArrowDown' && trail.length) { block(event); current = trail.pop(); show(current); return }
    if (event.key === 'Enter' && current) { block(event); finish({ element: current }) }
  }

  const onScroll = () => { if (armed && current) show(current) }

  const POINTER = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'touchstart', 'touchend']
  const attach = () => {
    for (const type of POINTER) addEventListener(type, block, true)
    addEventListener('click', onClick, true)
    addEventListener('mousemove', onMove, true)
    addEventListener('keydown', onKey, true)
    addEventListener('scroll', onScroll, true)
    addEventListener('resize', onScroll, true)
    cursor = document.createElement('style')
    cursor.textContent = '*,*::before,*::after{cursor:crosshair!important}'
    document.documentElement.appendChild(cursor)
  }
  const detach = () => {
    armed = null
    for (const type of POINTER) removeEventListener(type, block, true)
    removeEventListener('click', onClick, true)
    removeEventListener('mousemove', onMove, true)
    removeEventListener('keydown', onKey, true)
    removeEventListener('scroll', onScroll, true)
    removeEventListener('resize', onScroll, true)
    if (cursor) cursor.remove()
    cursor = null
  }

  window.__eaonDesign = {
    version: VERSION,
    arm(options) {
      if (armed) armed(null)
      ensureOverlay(options && options.accent)
      return new Promise((resolve) => {
        armed = resolve
        attach()
        if (current && current.isConnected) show(current)
      })
    },
    disarm() {
      if (armed) { const done = armed; detach(); hideOverlay(); done(null) }
    },
    async pickAt(x, y, options) {
      const el = deepAt(x, y)
      if (!el) return null
      hideOverlay()
      await settle()
      const element = describe(el)
      if (armed && current) show(current)
      return { element }
    },
    highlight(selector, options) {
      if (armed) return
      let el = null
      try { el = document.querySelector(selector) } catch (e) {}
      if (!el) return
      ensureOverlay(options && options.accent)
      show(el)
    },
    clear() { if (!armed) hideOverlay() }
  }
  return true
})()`

export type PickResult = { element: PickedElement } | { cancelled: true } | null

/** The bits of `<webview>` the picker needs, so it can be driven without the DOM type. */
interface Page {
  executeJavaScript: (code: string) => Promise<unknown>
}

/**
 * Runs code in the page. A `<webview>` that is not attached (closed, or not
 * loaded yet) throws rather than rejecting; either way this rejects.
 */
function run(page: Page, code: string): Promise<unknown> {
  try {
    return page.executeJavaScript(code)
  } catch (error) {
    return Promise.reject(error)
  }
}

const install = (page: Page): Promise<unknown> => run(page, PICKER_SOURCE)

/** Waits for the next pick (a click, Enter) or Escape. Resolves null when disarmed or the page went away. */
export async function armPicker(page: Page, accent: string): Promise<PickResult> {
  await install(page)
  return (await run(page, `window.__eaonDesign.arm(${JSON.stringify({ accent })})`)) as PickResult
}

export function disarmPicker(page: Page): void {
  void run(page, 'window.__eaonDesign && window.__eaonDesign.disarm()').catch(() => undefined)
}

/** The element at a point in the page's viewport ("Annotate Element" on right-click). */
export async function pickAt(page: Page, x: number, y: number): Promise<PickResult> {
  await install(page)
  return (await run(page, `window.__eaonDesign.pickAt(${Number(x)}, ${Number(y)})`)) as PickResult
}

/** Outlines a note's element while its card in the tray is hovered. */
export function highlightOnPage(page: Page, selector: string | null, accent: string): void {
  const code = selector
    ? `window.__eaonDesign && window.__eaonDesign.highlight(${JSON.stringify(selector)}, ${JSON.stringify({ accent })})`
    : 'window.__eaonDesign && window.__eaonDesign.clear()'
  void run(page, code).catch(() => undefined)
}
