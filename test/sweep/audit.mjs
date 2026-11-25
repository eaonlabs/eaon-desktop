/**
 * What the UI sweep checks on every screen. `auditPage` runs inside the app's
 * window (it is sent there as source, so it uses nothing from outside its own
 * body) and returns what a person looking at the screen would call broken:
 *
 *   error  the app crashed, the window scrolls sideways, an image didn't load,
 *          "undefined" or "[object Object]" is on screen, text is unreadable
 *          (contrast under 2:1)
 *   warn   a control is cut off or covered, text is clipped without an
 *          ellipsis or runs into other text, contrast is under the WCAG line,
 *          a control has no name, text is tinier than 10px, the screen is empty
 *   info   copy that breaks the house style (em dashes), text truncated with
 *          an ellipsis and no way to read the rest
 *
 * Content people wrote (chat messages, code, terminals, editors) is not held
 * to the copy and junk-text checks.
 *
 * @param {{ skipContrast?: boolean, overlay?: string | null }} options
 */
export function auditPage(options) {
  const { skipContrast = false, overlay = null } = options || {}
  const vw = window.innerWidth
  const vh = window.innerHeight
  /** @type {{ kind: string, severity: 'error' | 'warn' | 'info', message: string, where: string, rect?: { x: number, y: number, w: number, h: number } }[]} */
  const issues = []
  const CONTENT = 'pre, code, textarea, input, [contenteditable="true"], .xterm, .cm-editor, .monaco-editor, .msg--assistant, .msg-user-block, .msg-row, .terminal, [data-user-content]'

  const describe = (el) => {
    if (!el || !el.tagName) return ''
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('') : ''
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
    return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes}>${name ? ` "${name}"` : ''}`
  }
  const box = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })
  const add = (kind, severity, message, el, rect) => {
    issues.push({ kind, severity, message, where: describe(el), ...(rect || el ? { rect: box(rect || el.getBoundingClientRect()) } : {}) })
  }
  const shown = (el) => {
    const r = el.getBoundingClientRect()
    // A 1px box (or a clipped one) is text for screen readers only, hidden on purpose.
    if (r.width <= 2 || r.height <= 2) return false
    const s = getComputedStyle(el)
    if (s.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(s.clipPath)) return false
    if (el.closest('[aria-hidden="true"], [inert], .splash')) return false
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true
  }
  const inContent = (el) => Boolean(el.closest(CONTENT))
  /** Inside the open overlay (a menu, the palette), when the screen is one. */
  const inOverlay = (el) => !overlay || Boolean(el.closest(overlay))

  // 1. The app's own crash screens.
  for (const el of document.querySelectorAll('.crash-screen, .crash-panel')) {
    if (shown(el)) add('crash', 'error', `A crash screen is showing: ${(el.querySelector('.crash-screen__error')?.textContent || el.textContent || '').trim().slice(0, 200)}`, el)
  }

  // 2. The window itself scrolls sideways.
  const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  if (pageWidth > vw + 1) add('layout', 'error', `The window scrolls sideways: the page is ${pageWidth}px wide in a ${vw}px window`, null)

  // 3. Controls cut off by the window or a container that doesn't scroll.
  const CONTROLS = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"]'
  const scrolls = (el) => {
    const s = getComputedStyle(el)
    return (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1)
  }
  const clips = (el) => {
    const s = getComputedStyle(el)
    return s.overflowX !== 'visible' || s.overflowY !== 'visible'
  }
  const controls = [...document.querySelectorAll(CONTROLS)].filter((el) => shown(el) && inOverlay(el))
  const scrollerOf = (el) => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) if (scrolls(a)) return a
    return null
  }
  // Content scrolled up under a see-through title bar (or anything else its
  // scroll area runs beneath) is the design, not a collision: it scrolls back.
  const underHeader = (content, header) => {
    const scroller = scrollerOf(content)
    if (!scroller || scroller.contains(header)) return false
    const s = scroller.getBoundingClientRect()
    const h = header.getBoundingClientRect()
    return h.bottom > s.top && h.top < s.bottom && h.right > s.left && h.left < s.right
  }
  for (const el of controls) {
    const r = el.getBoundingClientRect()
    let visible = { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, vw), bottom: Math.min(r.bottom, vh) }
    let reachable = false
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (scrolls(a)) {
        reachable = true
        break
      }
      if (!clips(a)) continue
      const c = a.getBoundingClientRect()
      visible = { left: Math.max(visible.left, c.left), top: Math.max(visible.top, c.top), right: Math.min(visible.right, c.right), bottom: Math.min(visible.bottom, c.bottom) }
    }
    if (reachable) continue
    const area = r.width * r.height
    const seen = Math.max(0, visible.right - visible.left) * Math.max(0, visible.bottom - visible.top)
    // Wholly out of sight is a drawer or a slide-out by design; partly is a bug.
    if (seen > 0 && seen < area * 0.9 && area - seen > 16) add('cut-off', 'warn', `A control is cut off: ${Math.round((100 * seen) / area)}% of it shows`, el)
  }

  // 4. Controls something else sits on top of (only fully on-screen ones; menus and dialogs are allowed to).
  for (const el of controls) {
    const r = el.getBoundingClientRect()
    if (r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh || r.width < 6 || r.height < 6) continue
    if (el.disabled) continue
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    // Scrolled out of its list (under the list's own header or past its end): it scrolls back.
    let outside = false
    for (let a = el.parentElement; a && a !== document.documentElement && !outside; a = a.parentElement) {
      if (!clips(a)) continue
      const c = a.getBoundingClientRect()
      outside = x < c.left || x > c.right || y < c.top || y > c.bottom
    }
    if (outside) continue
    const hit = document.elementFromPoint(x, y)
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue
    if (hit.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], .popover, .menu, .palette, .toast, .tooltip')) continue
    if (underHeader(el, hit)) continue
    // Behind a scroll container's edge (scrolled out under a sticky header): it scrolls back.
    let scrolled = false
    for (let a = el.parentElement; a; a = a.parentElement) if (scrolls(a) && a.contains(hit)) scrolled = true
    if (scrolled) continue
    add('covered', 'warn', `A control is covered by ${describe(hit)}`, el)
  }

  // 5. Controls with no name: nothing for a screen reader, and no tooltip on an icon.
  for (const el of controls) {
    if (el.matches('input, select, textarea')) {
      const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('placeholder') || el.getAttribute('title') || el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))
      if (!labelled && !['checkbox', 'radio', 'range', 'color', 'file'].includes(el.getAttribute('type') || '')) add('a11y', 'warn', 'A field has no label', el)
      continue
    }
    const name = (el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt') || el.querySelector('svg title')?.textContent
    if (!name) add('a11y', 'warn', 'A control has no name (no text, aria-label or title)', el)
  }

  // 6. Images that didn't load.
  for (const img of document.querySelectorAll('img')) {
    if (!shown(img)) continue
    if (!img.getAttribute('src')) add('image', 'error', 'An image has no src', img)
    else if (img.complete && img.naturalWidth === 0) add('image', 'error', `An image didn't load: ${img.getAttribute('src').slice(0, 120)}`, img)
  }

  // 7. Text: what's on screen, run by run.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  })
  /** @type {{ node: Text, el: Element, rects: DOMRect[] }[]} */
  const runs = []
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement
    if (!el || el.closest('script, style, noscript, svg, title') || !shown(el) || !inOverlay(el)) continue
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh)
    if (rects.length) runs.push({ node: /** @type {Text} */ (node), el, rects })
  }

  const JUNK = /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date|\{\{|\}\}|\bnull\b/
  const junkSeen = new Set()
  const dashSeen = new Set()
  for (const { node, el } of runs) {
    if (inContent(el)) continue
    const text = node.nodeValue.trim()
    const junk = JUNK.exec(text)
    if (junk && !junkSeen.has(text)) {
      junkSeen.add(text)
      add('junk-text', 'error', `"${junk[0]}" is on screen: "${text.slice(0, 100)}"`, el)
    }
    if (text.includes('—') && !dashSeen.has(text)) {
      dashSeen.add(text)
      add('copy', 'info', `An em dash in the copy: "${text.slice(0, 120)}"`, el)
    }
  }

  // 8. Clipped text: cut off with no ellipsis, or ellipsised with no way to read the rest.
  const clippedSeen = new Set()
  for (const { el } of runs) {
    if (clippedSeen.has(el) || inContent(el)) continue
    clippedSeen.add(el)
    const s = getComputedStyle(el)
    // Where the glyphs really are: scrollWidth also grows with padding and effects that paint nothing past the edge.
    range.selectNodeContents(el)
    const text = range.getBoundingClientRect()
    const own = el.getBoundingClientRect()
    const past = { x: text.right > own.right + 1 || text.left < own.left - 1, y: text.bottom > own.bottom + 2 }
    const wide = past.x && el.scrollWidth > el.clientWidth + 1 && /(hidden|clip)/.test(s.overflowX) && el.clientWidth > 0
    const tall = past.y && el.scrollHeight > el.clientHeight + 2 && /(hidden|clip)/.test(s.overflowY) && el.clientHeight > 0 && s.webkitLineClamp === 'none'
    const readable = el.getAttribute('title') || el.closest('[title]') || el.getAttribute('aria-label')
    if (wide && s.textOverflow !== 'ellipsis') add('clipped-text', 'warn', `Text is cut off mid-word: "${(el.textContent || '').trim().slice(0, 80)}"`, el)
    else if (wide && !readable) add('truncated', 'info', `Text is shortened with "…" and has no tooltip: "${(el.textContent || '').trim().slice(0, 80)}"`, el)
    else if (tall) add('clipped-text', 'warn', `Text is cut off at the bottom: "${(el.textContent || '').trim().slice(0, 80)}"`, el)
  }

  // 9. Text that runs into other text and both show.
  const opaque = (el) => {
    const s = getComputedStyle(el)
    const m = /rgba?\(([^)]+)\)/.exec(s.backgroundColor)
    const alpha = m ? Number(m[1].split(',')[3] ?? 1) : 0
    return alpha > 0.85 || s.backdropFilter !== 'none' || s.backgroundImage !== 'none'
  }
  const flat = []
  for (const run of runs) for (const r of run.rects) flat.push({ run, r })
  flat.sort((a, b) => a.r.top - b.r.top)
  const overlapSeen = new Set()
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i]
    for (let j = i + 1; j < flat.length && flat[j].r.top < a.r.bottom; j++) {
      const b = flat[j]
      if (a.run.el === b.run.el || a.run.el.contains(b.run.el) || b.run.el.contains(a.run.el)) continue
      if (underHeader(a.run.el, b.run.el) || underHeader(b.run.el, a.run.el)) continue
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (w < 4 || h < 4 || h < Math.min(a.r.height, b.r.height) * 0.4) continue
      const key = `${describe(a.run.el)}|${describe(b.run.el)}`
      if (overlapSeen.has(key)) continue
      const x = Math.max(a.r.left, b.r.left) + w / 2
      const y = Math.max(a.r.top, b.r.top) + h / 2
      const stack = document.elementsFromPoint(x, y)
      const ia = stack.findIndex((e) => e === a.run.el || a.run.el.contains(e))
      const ib = stack.findIndex((e) => e === b.run.el || b.run.el.contains(e))
      if (ia === -1 || ib === -1) continue
      const [top, low] = ia < ib ? [ia, ib] : [ib, ia]
      const lowEl = stack[low]
      // Something opaque between them hides the lower one: a popover over the page, not a collision.
      if (stack.slice(top, low).some((e) => !e.contains(lowEl) && opaque(e))) continue
      overlapSeen.add(key)
      add('overlap', 'warn', `Text runs into other text: "${a.run.node.nodeValue.trim().slice(0, 40)}" and "${b.run.node.nodeValue.trim().slice(0, 40)}"`, a.run.el, { x: Math.max(a.r.left, b.r.left), y: Math.max(a.r.top, b.r.top), width: w, height: h })
    }
  }

  // 10. Tiny text, and contrast against what is really behind it.
  const parse = (css) => {
    const m = /rgba?\(([^)]+)\)/.exec(css)
    if (!m) return null
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  const over = (top, under) => {
    const a = top[3]
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]
  }
  const lum = (c) => {
    const lin = (v) => {
      v /= 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
  }
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)]
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const rootBg = parse(getComputedStyle(document.body).backgroundColor) || parse(getComputedStyle(document.documentElement).backgroundColor) || [0, 0, 0, 1]
  /** The solid colour behind an element, or null when a picture, gradient or blur is part of it. */
  const backdrop = (el) => {
    const layers = []
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a)
      if (s.backgroundImage !== 'none' || s.backdropFilter !== 'none' || s.filter !== 'none' || s.mixBlendMode !== 'normal') return null
      const c = parse(s.backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 0.999) break
      }
    }
    let colour = layers.length && layers[layers.length - 1][3] >= 0.999 ? layers.pop() : rootBg[3] >= 0.999 ? rootBg : null
    if (!colour) return null
    while (layers.length) colour = over(layers.pop(), colour)
    return colour
  }
  const opacityOf = (el) => {
    let o = 1
    for (let a = el; a; a = a.parentElement) o *= Number(getComputedStyle(a).opacity)
    return o
  }
  const tinySeen = new Set()
  const pairs = new Map()
  for (const { el } of runs) {
    if (tinySeen.has(el)) continue
    tinySeen.add(el)
    const s = getComputedStyle(el)
    const size = parseFloat(s.fontSize)
    if (size < 10 && !inContent(el)) add('tiny-text', 'warn', `Text is ${size}px: "${(el.textContent || '').trim().slice(0, 60)}"`, el)
    if (skipContrast || el.closest('button:disabled, [aria-disabled="true"], [disabled]')) continue
    const fg = parse(s.color)
    const bg = backdrop(el)
    if (!fg || !bg) continue
    const shownFg = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], bg)
    const r = ratio(shownFg, bg)
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
    const need = large ? 3 : 4.5
    if (r >= need) continue
    const key = `${s.color}|${bg.map((v) => Math.round(v)).join(',')}`
    const entry = pairs.get(key) ?? { el, r, need, count: 0, text: (el.textContent || '').trim().slice(0, 60) }
    entry.count += 1
    pairs.set(key, entry)
  }
  for (const { el, r, need, count, text } of pairs.values()) {
    add('contrast', r < 2 ? 'error' : 'warn', `Contrast ${r.toFixed(2)}:1 (needs ${need}:1), ${count} piece${count === 1 ? '' : 's'} of text like "${text}"`, el)
  }

  // 11. Nothing on screen but the sidebar.
  const mainText = runs.filter(({ el }) => !el.closest('.sidebar, .mode-switch, .top-bar, .topbar')).reduce((n, { node }) => n + node.nodeValue.trim().length, 0)
  if (!overlay && mainText < 12 && document.querySelectorAll('canvas, video, iframe, webview').length === 0) add('empty', 'warn', `The screen shows almost nothing besides the sidebar (${mainText} characters)`, null)

  return {
    issues,
    stats: { controls: controls.length, textRuns: runs.length, viewport: { w: vw, h: vh } },
    heading: (document.querySelector('.settings__h1, h1, h2')?.textContent || '').trim().slice(0, 80)
  }
}

/**
 * Waits until the page stops changing: no DOM mutations for `quietMs` and no
 * animation or transition still playing out (a page's sections fading in),
 * or `maxMs` at most (a spinner never stops, so endless animations don't
 * count). Returns how long it took.
 * @param {number} quietMs @param {number} maxMs
 */
export function settlePage(quietMs, maxMs) {
  return new Promise((done) => {
    const start = performance.now()
    let last = start
    const observer = new MutationObserver(() => (last = performance.now()))
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    const moving = () => document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
    const tick = () => {
      const now = performance.now()
      if ((now - last >= quietMs && !moving()) || now - start >= maxMs) {
        observer.disconnect()
        done({ ms: Math.round(now - start), settled: now - last >= quietMs })
      } else setTimeout(tick, 50)
    }
    setTimeout(tick, 50)
  })
}

/** Starts recording long tasks (main-thread stalls) in the page, once. */
export function watchLongTasks() {
  if (window.__sweepLong) return true
  window.__sweepLong = []
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__sweepLong.push({ start: Math.round(entry.startTime), ms: Math.round(entry.duration) })
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    /* no long-task timing */
  }
  return true
}

/** Long tasks since `since` (performance.now() time), emptied as read. */
export function takeLongTasks() {
  const all = window.__sweepLong || []
  window.__sweepLong = []
  return all
}
