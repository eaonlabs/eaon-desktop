/*
 * Injected on demand into a tab the agent is using (never declared as a
 * content script, so pages the agent is not working in are never touched).
 * Runs in the extension's isolated world: the page's own scripts cannot see
 * or tamper with anything here, while the DOM and its events are shared.
 *
 * The service worker calls `globalThis.__eaonAgent.run(action, params)` through
 * chrome.scripting and gets back a plain object — `{ error }` on failure,
 * because an exception thrown here would not survive the trip.
 */
(() => {
  if (globalThis.__eaonAgent) return true

  /* Identifies this document. Refs are only meaningful inside the document
     that issued them; after a navigation the service worker's recorded docId
     no longer matches and stale refs are refused instead of landing on
     whatever element happens to hold the same number on the new page. */
  const docId = Math.random().toString(36).slice(2, 10)
  const refs = new Map()
  const refOf = new WeakMap()
  let nextRef = 1
  const HOST_TAG = 'eaon-agent-indicator'

  function refFor(el) {
    let ref = refOf.get(el)
    if (!ref) {
      ref = nextRef++
      refOf.set(el, ref)
      refs.set(ref, new WeakRef(el))
    }
    return ref
  }

  // ------------------------------------------------------------ Text helpers

  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  const norm = (s) => squash(s).toLowerCase()
  const quote = (s) => JSON.stringify(s)

  function shortHref(a) {
    const raw = a.getAttribute('href') || ''
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return ''
    try {
      const url = new URL(a.href)
      const path = `${url.pathname}${url.search}`
      return clip(url.origin === location.origin ? path : `${url.host}${path === '/' ? '' : path}`, 60)
    } catch {
      return ''
    }
  }

  // --------------------------------------------------------------- Geometry

  function hasBox(el) {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function isShown(el) {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    return hasBox(el)
  }

  /** The deepest element at a point, looking inside open shadow roots. */
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y)
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === el) break
      el = inner
    }
    return el
  }

  function deepActiveElement() {
    let el = document.activeElement
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
    return el
  }

  // ------------------------------------------------------ Roles and names

  const ROLE_ELEMENTS = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem'
  ])
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', color: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox'
  }
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''])
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'svg', 'canvas', 'object', 'embed', HOST_TAG])
  const INTERACTIVE_SELECTOR =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox]'

  /** A hidden native checkbox styled through its label: the label is what a person clicks. */
  function isProxyLabel(el) {
    const control = el.control
    return Boolean(control && (control.type === 'checkbox' || control.type === 'radio') && !isShown(control))
  }

  /**
   * Whether the element is something to act on, and as what. Beyond native
   * controls and ARIA roles, a `cursor: pointer` that does not merely inherit
   * from its parent catches the div-with-a-click-handler buttons most modern
   * sites are built from, which have no role to find them by.
   */
  function interactiveRole(el, style, parentStyle) {
    const tag = el.localName
    const role = (el.getAttribute('role') || '').split(' ')[0]
    if (ROLE_ELEMENTS.has(role)) return role
    switch (tag) {
      case 'a':
        if (el.hasAttribute('href')) return 'link'
        break
      case 'button':
        return 'button'
      case 'input':
        if (el.type === 'hidden') return null
        if (el.type === 'checkbox' || el.type === 'radio') return isShown(el) ? el.type : null
        return INPUT_ROLES[el.type] || (el.list ? 'combobox' : 'textbox')
      case 'select':
        return el.multiple ? 'listbox' : 'combobox'
      case 'textarea':
        return 'textbox'
      case 'summary':
        return 'button'
      case 'label':
        if (isProxyLabel(el)) return el.control.type
        break
      default:
        break
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox'
    if (el.hasAttribute('onclick')) return 'clickable'
    if (style.cursor === 'pointer' && (!parentStyle || parentStyle.cursor !== 'pointer')) return 'clickable'
    return null
  }

  function labelledBy(el) {
    const ids = el.getAttribute('aria-labelledby')
    if (!ids) return ''
    const root = el.getRootNode()
    return squash(
      ids
        .split(/\s+/)
        .map((id) => {
          const node = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id)
          return node ? node.innerText || node.textContent : ''
        })
        .join(' ')
    )
  }

  function nameOf(el) {
    const named = labelledBy(el) || squash(el.getAttribute('aria-label'))
    if (named) return clip(named, 100)
    const tag = el.localName
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type)) {
        return clip(squash(el.value) || (el.type === 'reset' ? 'Reset' : 'Submit'), 100)
      }
      if (tag === 'input' && el.type === 'image') return clip(squash(el.alt) || 'Submit', 100)
      const labels = el.labels ? squash([...el.labels].map((l) => l.innerText).join(' ')) : ''
      return clip(labels || squash(el.placeholder || el.getAttribute('aria-placeholder') || el.title || el.name), 100)
    }
    // An editor's text is its value, not its name; naming it by its content
    // would make the name change with every keystroke.
    if (el.isContentEditable) {
      return clip(squash(el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || el.title), 100)
    }
    if (tag === 'img') return clip(squash(el.alt), 100)
    let text = squash(el.innerText)
    if (!text) {
      const img = el.querySelector('img[alt]')
      const svg = el.querySelector('svg[aria-label], svg > title')
      text = squash((img && img.alt) || (svg && (svg.getAttribute('aria-label') || svg.textContent)) || '')
    }
    if (!text) text = squash(el.title || el.getAttribute('data-tooltip') || el.getAttribute('placeholder') || '')
    if (!text && tag === 'a') text = shortHref(el)
    return clip(text, 100)
  }

  function checkedState(el) {
    const control = el.localName === 'label' ? el.control : el
    if (control && (control.type === 'checkbox' || control.type === 'radio')) {
      return control.indeterminate ? 'mixed' : control.checked ? 'checked' : 'unchecked'
    }
    const aria = el.getAttribute('aria-checked')
    if (aria === 'true') return 'checked'
    if (aria === 'false') return 'unchecked'
    if (aria === 'mixed') return 'mixed'
    return ''
  }

  function stateOf(el, role) {
    const parts = []
    const tag = el.localName
    if (tag === 'select') {
      const chosen = squash([...el.selectedOptions].map((o) => o.text).join(', '))
      parts.push(`value=${quote(clip(chosen, 60))}`)
      const options = [...el.options].map((o) => clip(squash(o.text), 30)).filter(Boolean)
      parts.push(`options: ${options.slice(0, 8).join(' | ')}${options.length > 8 ? ` …(+${options.length - 8})` : ''}`)
    } else if (tag === 'input' && role === 'slider') {
      parts.push(`value=${el.value} (${el.min || 0}–${el.max || 100})`)
    } else if (['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(role)) {
      const value = el.isContentEditable ? squash(el.innerText) : typeof el.value === 'string' ? el.value : ''
      if (value) parts.push(tag === 'input' && el.type === 'password' ? 'value="••••"' : `value=${quote(clip(squash(value), 80))}`)
      else if (el.placeholder && squash(el.placeholder) !== nameOf(el)) parts.push(`placeholder=${quote(clip(squash(el.placeholder), 40))}`)
      if (tag === 'input' && !TEXT_INPUTS.has(el.type)) parts.push(`type=${el.type}`)
    }
    const checked = checkedState(el)
    if (checked) parts.push(checked)
    const expanded = el.getAttribute('aria-expanded')
    if (expanded === 'true') parts.push('expanded')
    else if (expanded === 'false') parts.push('collapsed')
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected')
    if (el.getAttribute('aria-pressed') === 'true') parts.push('pressed')
    const current = el.getAttribute('aria-current')
    if (current && current !== 'false') parts.push('current')
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled')
    if (el.required || el.getAttribute('aria-required') === 'true') parts.push('required')
    if (el.readOnly) parts.push('readonly')
    if (el.getAttribute('aria-invalid') === 'true') parts.push('invalid')
    if (deepActiveElement() === el) parts.push('focused')
    if (tag === 'a') {
      const href = shortHref(el)
      if (href && href !== nameOf(el)) parts.push(`→ ${href}`)
    }
    return parts.join(' ')
  }

  /** What the bridge needs to judge a click or keystroke on this element as risky. */
  function riskHints(el, cache) {
    const hints = {}
    if (el.localName === 'input') hints.inputType = el.type
    const autocomplete = el.getAttribute('autocomplete')
    if (autocomplete) hints.autocomplete = autocomplete.toLowerCase()
    const form = el.form || el.closest('form')
    if (form) {
      if (!cache.forms.has(form)) {
        const submit = form.querySelector('button[type=submit], input[type=submit], button:not([type])')
        cache.forms.set(form, submit ? nameOf(submit) : '')
      }
      if (cache.forms.get(form)) hints.form = cache.forms.get(form)
    }
    const dialog = el.closest('dialog, [role=dialog], [role=alertdialog]')
    if (dialog) {
      if (!cache.dialogs.has(dialog)) cache.dialogs.set(dialog, dialogTitle(dialog))
      if (cache.dialogs.get(dialog)) hints.context = cache.dialogs.get(dialog)
    }
    return hints
  }

  function dialogTitle(dialog) {
    const named = labelledBy(dialog) || squash(dialog.getAttribute('aria-label'))
    if (named) return clip(named, 120)
    const heading = dialog.querySelector('h1, h2, h3, [role=heading]')
    return clip(squash(heading ? heading.innerText : dialog.innerText), 120)
  }

  function openDialog() {
    const dialog = [...document.querySelectorAll('dialog[open], [role=dialog][aria-modal=true], [role=alertdialog]')].find(isShown)
    return dialog ? dialogTitle(dialog) || 'untitled' : ''
  }

  // --------------------------------------------------------------- Snapshot

  const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root)$/

  function snapshot({ maxChars = 8000, refBase = 1 } = {}) {
    // Numbering carries on from the tab's previous page instead of restarting
    // at 1, so a ref remembered from an older page can never name an element
    // on this one — it is simply "no longer on the page".
    if (nextRef === 1 && refBase > 1) nextRef = refBase
    const viewportH = innerHeight
    const lines = []
    const elements = []
    const styles = new WeakMap()
    const cache = { forms: new Map(), dialogs: new Map() }
    let buffer = ''
    let bufferRect = null
    let visited = 0
    let prefix = ''

    const inView = (rect) => rect && rect.bottom > 0 && rect.top < viewportH

    function push(text, kind, rect) {
      const visible = inView(rect)
      const prio = visible ? 0 : kind === 'element' ? 1 : kind === 'heading' ? 2 : 3
      lines.push({ text: prefix && kind !== 'heading' ? `${prefix} ${text}` : text, prio })
    }

    function flush() {
      const text = squash(buffer)
      if (text && text !== '|') push(clip(text.replace(/^\|\s*|\s*\|$/g, ''), 500), 'text', bufferRect)
      buffer = ''
      bufferRect = null
    }

    function childrenOf(el) {
      if (el.shadowRoot) return el.shadowRoot.childNodes
      if (el.localName === 'slot') {
        const assigned = el.assignedNodes({ flatten: true })
        return assigned.length ? assigned : el.childNodes
      }
      return el.childNodes
    }

    function walk(node, parentStyle) {
      if (++visited > 40000) return
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue
        if (!text) return
        if (!text.trim()) {
          if (buffer && !buffer.endsWith(' ')) buffer += ' '
          return
        }
        if (!bufferRect && node.parentElement) bufferRect = node.parentElement.getBoundingClientRect()
        buffer += text
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const el = node
      const tag = el.localName
      if (SKIP_TAGS.has(tag)) return
      if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return
      const style = getComputedStyle(el)
      styles.set(el, style)
      if (style.display === 'none') return
      const isContents = style.display === 'contents'
      if (!isContents && el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return
      if (style.opacity === '0' && tag !== 'label') return

      const block = BLOCK.test(style.display)
      if (block) flush()

      if (tag === 'iframe' || tag === 'frame') {
        flush()
        let doc = null
        try {
          doc = el.contentDocument
        } catch {
          doc = null
        }
        if (doc && doc.body) {
          walk(doc.body, null)
          flush()
        } else if (hasBox(el)) {
          let where = ''
          try {
            where = new URL(el.src).host
          } catch {
            where = ''
          }
          push(`[frame${el.title ? ` ${quote(el.title)}` : ''}${where ? ` from ${where}` : ''} — its content can't be read]`, 'text', el.getBoundingClientRect())
        }
        return
      }

      if (tag === 'img') {
        const alt = squash(el.alt)
        if (alt && el.width >= 24 && el.height >= 24) buffer += ` [image: ${clip(alt, 80)}] `
        return
      }

      const role = interactiveRole(el, style, parentStyle)
      if (role) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) {
          flush()
          const ref = refFor(el)
          const name = nameOf(el)
          const state = stateOf(el, role)
          push(`[${ref}] ${role}${name ? ` ${quote(name)}` : ''}${state ? ` ${state}` : ''}`, 'element', rect)
          elements.push({ ref, role, name, ...riskHints(el, cache) })
          // Controls are leaves: their name already carries their text. A
          // clickable card that wraps real links and buttons is walked too,
          // so those stay individually reachable.
          const wraps = role === 'clickable' || role === 'link' || role === 'button' ? el.querySelector(INTERACTIVE_SELECTOR) : null
          if (!wraps) {
            if (block) flush()
            return
          }
        }
      }

      const headingLevel = /^h[1-6]$/.test(tag) ? Number(tag[1]) : el.getAttribute('role') === 'heading' ? Number(el.getAttribute('aria-level')) || 2 : 0
      const outerPrefix = prefix
      if (headingLevel) {
        flush()
        prefix = '#'.repeat(headingLevel)
        bufferRect = el.getBoundingClientRect()
      }

      for (const child of childrenOf(el)) walk(child, isContents ? parentStyle : style)

      if (headingLevel) {
        const text = squash(buffer)
        if (text) lines.push({ text: `${prefix} ${clip(text, 200)}`, prio: inView(bufferRect) ? 0 : 2 })
        buffer = ''
        bufferRect = null
        prefix = outerPrefix
      } else if (style.display === 'table-cell') {
        buffer += ' | '
      } else if (block || tag === 'br') {
        flush()
      }
    }

    walk(document.body || document.documentElement, null)
    flush()

    const scroller = document.scrollingElement || document.documentElement
    const total = Math.max(scroller.scrollHeight, viewportH)
    const top = Math.round(scroller.scrollTop)
    const header = [
      `Title: ${document.title || '(untitled)'}`,
      `URL: ${location.href}`,
      total > viewportH + 4
        ? `Scroll: showing ${top}–${top + viewportH}px of ${total}px${top + viewportH < total - 4 ? ' (more below)' : ''}`
        : 'Scroll: the whole page fits on screen',
      openDialog() ? `Dialog open: ${quote(openDialog())}` : ''
    ]
      .filter(Boolean)
      .join('\n')

    // Over budget: keep everything on screen, then off-screen controls, then
    // headings, then off-screen text — and mark each gap so the agent knows
    // to scroll rather than assume the page ends there.
    const budget = Math.max(1000, maxChars - header.length - 200)
    const cost = (line) => line.text.length + 1
    let keep = lines.map(() => true)
    const size = lines.reduce((n, line) => n + cost(line), 0)
    if (size > budget) {
      keep = lines.map(() => false)
      const order = lines.map((_, i) => i).sort((a, b) => lines[a].prio - lines[b].prio || a - b)
      let used = 0
      for (const i of order) {
        if (used + cost(lines[i]) > budget) continue
        keep[i] = true
        used += cost(lines[i])
      }
    }
    const out = []
    let gap = 0
    lines.forEach((line, i) => {
      if (!keep[i]) {
        gap++
        return
      }
      if (gap) out.push(`… ${gap} line${gap === 1 ? '' : 's'} left out`)
      gap = 0
      out.push(line.text)
    })
    if (gap) out.push(`… ${gap} line${gap === 1 ? '' : 's'} left out`)
    const trimmed = size > budget
    const body = out.length ? out.join('\n') : '(no readable content)'
    return {
      docId,
      url: location.href,
      title: document.title,
      text: `${header}\n\n${body}${trimmed ? '\n\n(Trimmed to fit: off-screen text went first. Scroll and snapshot again to read further.)' : ''}`,
      elements: elements.slice(0, 3000),
      nextRef
    }
  }

  // ---------------------------------------------------------------- Actions

  function resolve(p) {
    if (!p.docId) throw new Error('Take a snapshot of this page first; element refs come from snapshots.')
    if (p.docId !== docId) {
      throw new Error('The page has changed since your last snapshot (it navigated or reloaded). Take a new snapshot and use its refs.')
    }
    const el = refs.get(p.ref) && refs.get(p.ref).deref()
    if (!el || !el.isConnected) throw new Error(`Element [${p.ref}] is no longer on the page. Take a new snapshot.`)
    if (typeof p.expectName === 'string') {
      const now = nameOf(el)
      if (norm(now) !== norm(p.expectName)) {
        throw new Error(`Element [${p.ref}] changed since your snapshot: it was ${quote(p.expectName)}, now ${quote(now)}. Take a new snapshot before acting on it.`)
      }
    }
    return el
  }

  const describe = (el, ref) => {
    const role = interactiveRole(el, getComputedStyle(el), el.parentElement ? getComputedStyle(el.parentElement) : null) || el.localName
    const name = nameOf(el)
    return `[${ref}] ${role}${name ? ` ${quote(name)}` : ''}`
  }

  function describeNode(el) {
    const id = el.id ? `#${el.id}` : ''
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
    const text = clip(squash(el.innerText || ''), 40)
    return `<${el.localName}${id}${cls}>${text ? ` ${quote(text)}` : ''}`
  }

  const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true'

  function focusTarget(el) {
    return el.closest('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable=true]')
  }

  function mouseInit(x, y, extra = {}) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + screenX,
      screenY: y + screenY,
      button: 0,
      ...extra
    }
  }

  function hoverSequence(el, x, y) {
    const pointer = { ...mouseInit(x, y), pointerId: 1, pointerType: 'mouse', isPrimary: true }
    el.dispatchEvent(new PointerEvent('pointerover', pointer))
    el.dispatchEvent(new PointerEvent('pointerenter', { ...pointer, bubbles: false }))
    el.dispatchEvent(new MouseEvent('mouseover', mouseInit(x, y)))
    el.dispatchEvent(new MouseEvent('mouseenter', mouseInit(x, y, { bubbles: false })))
    el.dispatchEvent(new PointerEvent('pointermove', pointer))
    el.dispatchEvent(new MouseEvent('mousemove', mouseInit(x, y)))
  }

  /** The full pointer sequence a real click produces, so listeners on any of them fire. */
  function clickSequence(el, x, y) {
    const pointer = { ...mouseInit(x, y), pointerId: 1, pointerType: 'mouse', isPrimary: true }
    hoverSequence(el, x, y)
    const down = el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }))
    const mouseDown = down ? el.dispatchEvent(new MouseEvent('mousedown', mouseInit(x, y, { buttons: 1, detail: 1 }))) : false
    if (mouseDown) {
      const focusable = focusTarget(el)
      if (focusable && typeof focusable.focus === 'function') focusable.focus({ preventScroll: true })
    }
    el.dispatchEvent(new PointerEvent('pointerup', pointer))
    if (down) el.dispatchEvent(new MouseEvent('mouseup', mouseInit(x, y, { detail: 1 })))
    // A synthetic click still runs the element's activation behaviour:
    // links navigate, checkboxes toggle, submit buttons submit.
    el.dispatchEvent(new MouseEvent('click', mouseInit(x, y, { detail: 1 })))
  }

  function centerOf(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }

  function click(p) {
    const el = resolve(p)
    const label = describe(el, p.ref)
    if (isDisabled(el)) throw new Error(`${label} is disabled.`)
    if (el.localName === 'input' && el.type === 'file') {
      throw new Error("File pickers can't be operated by the agent. Ask the user to choose the file themselves.")
    }
    if (el.localName === 'select') throw new Error(`${label} is a dropdown; use select {ref, option} instead of clicking it.`)
    const target = el.localName === 'input' && !isShown(el) && el.labels && el.labels[0] ? el.labels[0] : el

    // Pages may only open tabs in response to real user input, so a
    // simulated click on a target=_blank link would be swallowed by the popup
    // blocker. Hand the URL back for the extension to open in the Eaon group.
    const link = target.closest('a[href]')
    if (link && /^https?:/i.test(link.href) && link.target && !['_self', '_top', '_parent'].includes(link.target.toLowerCase())) {
      return { message: `Opened ${label} in a new tab`, openTab: link.href }
    }

    const { x, y } = centerOf(target)
    const hit = deepElementFromPoint(x, y)
    const covered =
      hit &&
      hit.localName !== HOST_TAG &&
      hit !== target &&
      !target.contains(hit) &&
      !hit.contains(target) &&
      !(hit.localName === 'label' && hit.control === target)
    clickSequence(target, x, y)
    return {
      message: `Clicked ${label}${covered ? `. It looked covered by ${describeNode(hit)} — if nothing happened, deal with that first` : ''}`
    }
  }

  function hover(p) {
    const el = resolve(p)
    const { x, y } = centerOf(el)
    hoverSequence(el, x, y)
    return { message: `Hovering ${describe(el, p.ref)}. Menus that open on CSS :hover alone may not react to a simulated pointer` }
  }

  /** The text field an element stands for: itself, or the input inside a wrapper. */
  function editableOf(el) {
    const isField = (n) =>
      (n.localName === 'input' && !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden'].includes(n.type)) ||
      n.localName === 'textarea' ||
      n.isContentEditable
    if (isField(el)) return el
    return [...el.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable=true]')].find(isField) || null
  }

  function setNativeValue(field, value) {
    // The prototype's setter, not the property: frameworks such as React
    // shadow `value` on the instance and would swallow a plain assignment.
    const proto = field.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value)
  }

  function type(p) {
    const el = resolve(p)
    const field = editableOf(el)
    const label = describe(el, p.ref)
    if (!field) throw new Error(`${label} is not a text field.`)
    if (isDisabled(field) || field.readOnly) throw new Error(`${label} is ${field.readOnly ? 'read-only' : 'disabled'}.`)
    field.scrollIntoView({ block: 'center', behavior: 'instant' })
    field.focus({ preventScroll: true })
    const text = String(p.text ?? '')

    if (field.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(field)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      // execCommand fires beforeinput/input the way typing does, which rich
      // editors (ProseMirror, Lexical, Draft) listen for.
      const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete')
      if (!ok) {
        field.textContent = text
        field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }))
      }
    } else {
      let ok = false
      if (TEXT_INPUTS.has(field.type) || field.localName === 'textarea') {
        try {
          field.select()
          ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete')
        } catch {
          ok = false
        }
      }
      if (!ok || field.value !== text) {
        setNativeValue(field, text)
        field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }))
      }
      field.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const now = field.isContentEditable ? squash(field.innerText) : field.value
    const masked = field.type === 'password'
    const differs = !masked && squash(now) !== squash(text)
    return {
      message: `Typed into ${label}${differs ? `. The field now reads ${quote(clip(squash(now), 120))}` : ''}`
    }
  }

  function select(p) {
    const el = resolve(p)
    const label = describe(el, p.ref)
    if (el.localName !== 'select') {
      throw new Error(`${label} is not a native dropdown. Click it to open the list, take a snapshot, then click the option.`)
    }
    const want = norm(p.option)
    const options = [...el.options]
    const match =
      options.find((o) => norm(o.value) === want || norm(o.text) === want) || options.find((o) => norm(o.text).includes(want))
    if (!match) {
      throw new Error(`No option ${quote(p.option)} in ${label}. Options: ${options.map((o) => squash(o.text)).slice(0, 30).join(' | ')}`)
    }
    if (match.disabled) throw new Error(`The option ${quote(squash(match.text))} is disabled.`)
    el.focus({ preventScroll: true })
    if (el.multiple) match.selected = true
    else el.value = match.value
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { message: `Selected ${quote(squash(match.text))} in ${label}` }
  }

  // -------------------------------------------------------------- Keyboard

  const KEYS = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    return: { key: 'Enter', code: 'Enter', keyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    ' ': { key: ' ', code: 'Space', keyCode: 32 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
  }

  function parseKey(spec) {
    if (spec === ' ') return { ...KEYS.space, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, printable: true }
    const parts = String(spec).split('+').map((s) => s.trim()).filter((s, i, all) => s || i === all.length - 1)
    const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
    let main = parts.pop() || ''
    if (main === '' && String(spec).endsWith('+')) main = '+'
    for (const mod of parts.map((m) => m.toLowerCase())) {
      if (mod === 'ctrl' || mod === 'control') mods.ctrlKey = true
      else if (mod === 'shift') mods.shiftKey = true
      else if (mod === 'alt' || mod === 'option') mods.altKey = true
      else if (mod === 'meta' || mod === 'cmd' || mod === 'command') mods.metaKey = true
      else throw new Error(`Unknown modifier "${mod}". Use Control, Shift, Alt or Meta.`)
    }
    const named = KEYS[main.toLowerCase()]
    if (named) return { ...named, ...mods, printable: named.key === ' ' }
    if (/^f([1-9]|1[0-2])$/i.test(main)) return { key: main.toUpperCase(), code: main.toUpperCase(), keyCode: 111 + Number(main.slice(1)), ...mods, printable: false }
    if ([...main].length === 1) {
      const upper = main.toUpperCase()
      const code = /[a-z]/i.test(main) ? `Key${upper}` : /[0-9]/.test(main) ? `Digit${main}` : ''
      return { key: mods.shiftKey && /[a-z]/i.test(main) ? upper : main, code, keyCode: upper.charCodeAt(0), ...mods, printable: true }
    }
    throw new Error(`Unknown key "${main}". Use names like Enter, Escape, Tab, ArrowDown, Backspace, or a single character.`)
  }

  function tabbables() {
    return [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable=true]')].filter(
      (el) => el.tabIndex >= 0 && !isDisabled(el) && isShown(el)
    )
  }

  function isTextEntry(el) {
    return (el.localName === 'input' && TEXT_INPUTS.has(el.type)) || el.localName === 'textarea' || el.isContentEditable
  }

  /**
   * Dispatches the key's events and then performs what the browser would
   * have done by default, since simulated key events carry no default action
   * of their own: Enter submits, Tab moves focus, Backspace deletes.
   */
  function press(p) {
    const key = parseKey(p.key)
    let target
    if (p.ref !== undefined && p.ref !== null) {
      target = resolve(p)
      const focusable = focusTarget(target)
      if (focusable) focusable.focus({ preventScroll: false })
    } else {
      target = deepActiveElement() || document.body
    }
    const init = {
      key: key.key,
      code: key.code,
      keyCode: key.keyCode,
      which: key.keyCode,
      ctrlKey: key.ctrlKey,
      shiftKey: key.shiftKey,
      altKey: key.altKey,
      metaKey: key.metaKey,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    }
    const allowed = target.dispatchEvent(new KeyboardEvent('keydown', init))
    let pressAllowed = allowed
    if (allowed && (key.printable || key.key === 'Enter') && !key.ctrlKey && !key.metaKey) {
      pressAllowed = target.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: key.key === 'Enter' ? 13 : key.key.charCodeAt(0) }))
    }
    let effect = ''
    if (allowed && pressAllowed) effect = defaultKeyAction(target, key)
    target.dispatchEvent(new KeyboardEvent('keyup', init))
    const where = target === document.body ? 'the page' : describe(target, refOf.get(target) || '?')
    return { message: `Pressed ${p.key} in ${where}${effect ? ` — ${effect}` : allowed ? '' : ' (the page handled it)'}` }
  }

  function defaultKeyAction(target, key) {
    const mod = key.ctrlKey || key.metaKey
    if (key.key === 'Enter' && !mod) {
      if (target.localName === 'input') {
        const form = target.form
        if (!form) return ''
        if (!form.checkValidity()) {
          const invalid = [...form.elements].filter((f) => f.willValidate && !f.checkValidity())
          form.reportValidity()
          return `the form did not submit — ${invalid.length} field${invalid.length === 1 ? ' is' : 's are'} invalid: ${invalid
            .slice(0, 3)
            .map((f) => `${quote(nameOf(f))} (${f.validationMessage})`)
            .join(', ')}`
        }
        form.requestSubmit()
        return 'submitted the form'
      }
      if (target.localName === 'textarea' || target.isContentEditable) {
        document.execCommand(target.isContentEditable ? 'insertParagraph' : 'insertLineBreak')
        return 'new line'
      }
      if (target.matches('a[href], button, summary, [role=button], [role=link]')) {
        const { x, y } = centerOf(target)
        clickSequence(target, x, y)
        return 'activated it'
      }
      return ''
    }
    if (key.key === 'Tab' && !mod) {
      const list = tabbables()
      const index = list.indexOf(target)
      const next = list[(index + (key.shiftKey ? -1 : 1) + list.length) % list.length]
      if (next) {
        next.focus()
        return `focus moved to ${describe(next, refFor(next))}`
      }
      return ''
    }
    if (key.key === ' ' && !mod && !isTextEntry(target)) {
      if (target.matches('button, summary, input[type=checkbox], input[type=radio], [role=button], [role=checkbox], [role=switch]')) {
        const { x, y } = centerOf(target)
        clickSequence(target, x, y)
        return 'activated it'
      }
      scrollBy({ top: innerHeight * 0.8 * (key.shiftKey ? -1 : 1), behavior: 'instant' })
      return 'scrolled'
    }
    if (isTextEntry(target)) {
      if (key.key === 'Backspace') return document.execCommand('delete') ? 'deleted' : ''
      if (key.key === 'Delete') return document.execCommand('forwardDelete') ? 'deleted' : ''
      if (mod && key.key.toLowerCase() === 'a') {
        document.execCommand('selectAll')
        return 'selected all'
      }
      if (key.printable && !mod) return document.execCommand('insertText', false, key.key) ? 'typed' : ''
      return ''
    }
    if (target.localName === 'select' && (key.key === 'ArrowDown' || key.key === 'ArrowUp')) {
      const next = target.selectedIndex + (key.key === 'ArrowDown' ? 1 : -1)
      if (next >= 0 && next < target.options.length) {
        target.selectedIndex = next
        target.dispatchEvent(new Event('change', { bubbles: true }))
        return `now ${quote(squash(target.options[next].text))}`
      }
      return ''
    }
    const page = { ArrowDown: 40, ArrowUp: -40, PageDown: innerHeight * 0.9, PageUp: -innerHeight * 0.9 }
    if (key.key in page) {
      scrollBy({ top: page[key.key], behavior: 'instant' })
      return 'scrolled'
    }
    if (key.key === 'Home' || key.key === 'End') {
      scrollTo({ top: key.key === 'Home' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' })
      return 'scrolled'
    }
    return ''
  }

  // ---------------------------------------------------------------- Scroll

  function canScroll(el, vertical) {
    const style = getComputedStyle(el)
    const overflow = vertical ? style.overflowY : style.overflowX
    const room = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
    return room > 1 && /(auto|scroll|overlay)/.test(overflow)
  }

  /**
   * What actually scrolls. Many web apps pin the document and scroll an inner
   * panel instead, where window.scrollBy would silently do nothing.
   */
  function mainScroller(vertical) {
    const root = document.scrollingElement || document.documentElement
    const room = vertical ? root.scrollHeight - innerHeight : root.scrollWidth - innerWidth
    const rootStyle = getComputedStyle(document.body || root)
    if (room > 1 && (vertical ? rootStyle.overflowY : rootStyle.overflowX) !== 'hidden') return root
    let best = null
    let bestArea = 0
    for (const el of document.querySelectorAll('body *')) {
      if (!canScroll(el, vertical)) continue
      const r = el.getBoundingClientRect()
      const area = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
      if (area > bestArea) {
        best = el
        bestArea = area
      }
    }
    return best || root
  }

  function scroll(p) {
    const vertical = p.direction !== 'left' && p.direction !== 'right'
    const sign = p.direction === 'up' || p.direction === 'left' ? -1 : 1
    let scroller
    if (p.ref !== undefined && p.ref !== null) {
      const el = resolve(p)
      if (p.intoView) {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        return { message: `Scrolled ${describe(el, p.ref)} into view` }
      }
      scroller = el
      while (scroller && scroller !== document.body && !canScroll(scroller, vertical)) scroller = scroller.parentElement
      if (!scroller || scroller === document.body) scroller = mainScroller(vertical)
    } else {
      scroller = mainScroller(vertical)
    }
    const root = document.scrollingElement || document.documentElement
    const isRoot = scroller === root
    const view = isRoot ? (vertical ? innerHeight : innerWidth) : vertical ? scroller.clientHeight : scroller.clientWidth
    const amount = Math.round((typeof p.amount === 'number' && p.amount > 0 ? p.amount : view * 0.8) * sign)
    const before = vertical ? scroller.scrollTop : scroller.scrollLeft
    const delta = vertical ? { top: amount, behavior: 'instant' } : { left: amount, behavior: 'instant' }
    if (isRoot) window.scrollBy(delta)
    else scroller.scrollBy(delta)
    const after = vertical ? scroller.scrollTop : scroller.scrollLeft
    const extent = vertical ? scroller.scrollHeight : scroller.scrollWidth
    const moved = Math.round(after - before)
    const where = isRoot ? 'the page' : describeNode(scroller)
    if (moved === 0) return { message: `Could not scroll ${p.direction || 'down'} in ${where}: already at the ${sign > 0 ? 'end' : 'start'}` }
    return {
      message: `Scrolled ${where} ${p.direction || 'down'} by ${Math.abs(moved)}px. Now showing ${Math.round(after)}–${Math.round(after + view)} of ${extent}px`
    }
  }

  // ------------------------------------------------------------------- Wait

  function find(p) {
    if (p.selector) {
      let el
      try {
        el = document.querySelector(p.selector)
      } catch {
        throw new Error(`"${p.selector}" is not a valid CSS selector.`)
      }
      return { found: Boolean(el && isShown(el)) }
    }
    if (p.text) return { found: norm(document.body ? document.body.innerText : '').includes(norm(p.text)) }
    return { found: document.readyState === 'complete' }
  }

  // -------------------------------------------------------------- Indicator

  let indicator = null

  function buildIndicator() {
    const host = document.createElement(HOST_TAG)
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;'
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = `
      .frame {
        position: fixed; inset: 0; pointer-events: none;
        box-shadow: inset 0 0 0 2px rgba(51, 156, 255, 0.85), inset 0 0 22px 2px rgba(51, 156, 255, 0.28);
        animation: fade 240ms cubic-bezier(0.32, 0.72, 0, 1) both;
      }
      .pill {
        position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 8px; padding: 5px 5px 5px 12px;
        border-radius: 999px; background: rgba(22, 22, 24, 0.92); color: #fcfcfc;
        font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32), 0 0 0 0.5px rgba(255, 255, 255, 0.14);
        pointer-events: auto; animation: rise 240ms cubic-bezier(0.32, 0.72, 0, 1) both;
      }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #339cff; box-shadow: 0 0 0 3px rgba(51, 156, 255, 0.25); animation: pulse 1.6s ease-in-out infinite; }
      button {
        all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px;
        background: rgba(255, 255, 255, 0.12); font-weight: 600; font-size: 12px;
      }
      button:hover { background: rgba(255, 255, 255, 0.2); }
      button:focus-visible { outline: 2px solid #339cff; outline-offset: 1px; }
      @keyframes fade { from { opacity: 0; } }
      @keyframes rise { from { opacity: 0; transform: translate(-50%, 6px); } }
      @keyframes pulse { 50% { opacity: 0.45; } }
      @media (prefers-reduced-motion: reduce) { .frame, .pill, .dot { animation: none; } }
    `
    const frame = document.createElement('div')
    frame.className = 'frame'
    const pill = document.createElement('div')
    pill.className = 'pill'
    pill.setAttribute('role', 'status')
    const dot = document.createElement('span')
    dot.className = 'dot'
    const text = document.createElement('span')
    text.textContent = 'Eaon is using this tab'
    const stop = document.createElement('button')
    stop.type = 'button'
    stop.textContent = 'Stop'
    stop.title = 'Stop the Eaon agent from controlling the browser'
    stop.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'eaon-stop' }).catch(() => {})
    })
    pill.append(dot, text, stop)
    root.append(style, frame, pill)
    return host
  }

  function setIndicator(on) {
    if (!on) {
      if (indicator) indicator.style.display = 'none'
      return
    }
    if (!indicator || !indicator.isConnected) {
      indicator = buildIndicator()
      // On <html> rather than <body>: a transformed body would turn
      // position: fixed into position: absolute.
      document.documentElement.appendChild(indicator)
    }
    indicator.style.display = ''
  }

  // ------------------------------------------------------------- Dispatcher

  const ACTIONS = { snapshot, click, hover, type, select, press, scroll, find }

  async function run(action, params = {}) {
    try {
      if (action === 'indicator') {
        setIndicator(params.on !== false)
        // Hidden for a screenshot: wait until a frame without it has been
        // painted, or the capture would still show it. rAF stalls in hidden
        // tabs, hence the timeout.
        if (params.on === false) {
          await Promise.race([
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            new Promise((resolve) => setTimeout(resolve, 150))
          ])
        }
        return { ok: true }
      }
      if (action === 'info') return { url: location.href, title: document.title, readyState: document.readyState }
      const handler = ACTIONS[action]
      if (!handler) throw new Error(`Unknown page action "${action}".`)
      if (action !== 'find') setIndicator(true)
      return handler(params)
    } catch (error) {
      return { error: error && error.message ? error.message : String(error) }
    }
  }

  Object.defineProperty(globalThis, '__eaonAgent', { value: { docId, run }, configurable: false })
  return true
})()
