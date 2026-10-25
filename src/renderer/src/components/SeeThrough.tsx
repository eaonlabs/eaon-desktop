import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import type { SeeThroughStyle, WallpaperFrame } from '@shared/types'
import { useApp } from '../state/store'
import '../styles/seeThrough.css'

/**
 * See-through (Settings → Appearance): the desktop's picture drawn behind the
 * whole app, lined up with the screen as the window moves, so the window
 * reads as glass over the desktop. Over it lies the theme's own colour, as
 * strongly as the tint setting says. The picture can be drawn as it is, as
 * a halftone screen made from it — dots that grow where it is darker — or as
 * ASCII art, a character per cell in the cell's own colour. The app's panels
 * frost over all of it (seeThrough.css).
 *
 * The picture is drawn once, at the display's size, into a layer that only
 * ever slides: a move is one transform on the compositor, never a redraw and
 * never a React render. On macOS the window server drags a window without
 * telling the app until it is let go, so while see-through is on the title
 * bars drag through main instead (features/wallpaper.ts), which reports the
 * window's place every frame — the picture keeps up with the window.
 *
 * The picture comes from main, which only reads the wallpaper's file; nothing
 * here can see other windows.
 */

/** The halftone's cell, in screen points. */
const CELL = 5

/** The title bars: where a press drags the window. Their buttons, fields and tabs don't. */
const DRAG = '.chat-header, .titlebar, .drag, .dock__bar, .page__bar, .settings__titlebar, .settings__nav-top, .browser__tabs, .crash-screen__drag'
const NO_DRAG = 'button, a, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"], .no-drag'

export function SeeThrough(): JSX.Element | null {
  const options = useApp((s) => s.settings?.appearance.seeThrough)
  // The desktop's own picture needs an OS that says what it is; a chosen one works anywhere.
  const custom = options?.source === 'custom' && Boolean(options.custom)
  const on = Boolean(options?.enabled) && (custom || window.api.platform === 'darwin' || window.api.platform === 'win32')
  /** Which picture: a new choice reloads it. */
  const source = custom ? options?.custom : 'desktop'
  const style: SeeThroughStyle = options?.style ?? (options?.texture === false ? 'photo' : 'halftone')
  const tint = Math.min(100, Math.max(0, options?.tint ?? 55))
  const light = useLightTheme()

  /** The display the window is on: only a change of display reloads the picture. */
  const [display, setDisplay] = useState<WallpaperFrame['display'] | null>(null)
  const [picture, setPicture] = useState<string | null>(null)
  /** The picture with its halftone, at the picture's own size. */
  const [plate, setPlate] = useState<HTMLCanvasElement | null>(null)
  const layer = useRef<HTMLDivElement>(null)
  const latest = useRef<WallpaperFrame | null>(null)

  /** Slides the layer so the picture's corner sits on the display's, wherever the window is. */
  const place = (): void => {
    const el = layer.current
    const f = latest.current
    if (!el || !f) return
    // Hanging past the screen's edge, the picture stops at its own edge
    // rather than running off into black.
    const dx = Math.min(0, Math.max(window.innerWidth - f.display.width, f.display.x - f.content.x))
    const dy = Math.min(0, Math.max(window.innerHeight - f.display.height, f.display.y - f.content.y))
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
  }

  // The window's place on the screen, as it moves: straight onto the layer.
  useEffect(() => {
    if (!on) return
    let live = true
    const receive = (f: WallpaperFrame): void => {
      latest.current = f
      setDisplay((current) =>
        current && current.id === f.display.id && current.width === f.display.width && current.height === f.display.height ? current : f.display
      )
      place()
    }
    void window.api.wallpaper.watch(true).then((f) => live && f && receive(f))
    const off = window.api.wallpaper.onFrame(receive)
    window.addEventListener('resize', place)
    return () => {
      live = false
      off()
      window.removeEventListener('resize', place)
      void window.api.wallpaper.watch(false)
    }
    // `place` reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on])

  // The display's picture: again when the window changes display, and on
  // coming back to the app, in case the wallpaper changed meanwhile.
  const displayId = display?.id
  useEffect(() => {
    if (!on || displayId === undefined) return
    let live = true
    const load = (): void => {
      void window.api.wallpaper.picture(displayId).then((url) => live && setPicture((current) => (current === url ? current : url)))
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [on, displayId, source])

  // The plate: the picture, and over it the halftone.
  useEffect(() => {
    if (!on || !picture || !display) return
    let live = true
    const image = new Image()
    image.onload = () => {
      if (!live) return
      const next = document.createElement('canvas')
      next.width = image.naturalWidth
      next.height = image.naturalHeight
      next.className = 'see-through__picture'
      const ctx = next.getContext('2d')
      if (!ctx) return
      ctx.drawImage(image, 0, 0)
      const scale = next.width / display.width
      if (style === 'halftone') halftone(ctx, image, scale, light)
      else if (style === 'ascii') ascii(ctx, image, scale, light)
      setPlate(next)
    }
    image.src = picture
    return () => {
      live = false
    }
  }, [on, picture, style, light, display])

  // The plate goes into the layer once; from then on only the layer moves.
  useEffect(() => {
    const el = layer.current
    if (!el || !plate || !display) return
    el.style.width = `${display.width}px`
    el.style.height = `${display.height}px`
    el.replaceChildren(plate)
    place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plate, display])

  // The page drops its own background while the picture is behind it.
  const ready = on && plate !== null
  useEffect(() => {
    if (ready) document.body.dataset.seeThrough = 'on'
    else delete document.body.dataset.seeThrough
    return () => {
      delete document.body.dataset.seeThrough
    }
  }, [ready])

  // An entry animation that keeps its last frame (`both`, `forwards`) leaves
  // its element with a live opacity or transform effect, and Chromium makes
  // such an element a backdrop root: frosted glass anywhere inside it blurs
  // nothing and shows the picture sharp behind it. Once one ends, it lets go
  // of its last frame wherever that changes nothing on screen.
  useEffect(() => {
    if (!ready) return
    const release = (animation: Animation): void => {
      const effect = animation.effect
      if (!(animation instanceof CSSAnimation) || animation.playState !== 'finished' || !(effect instanceof KeyframeEffect)) return
      const fill = effect.getTiming().fill
      const target = effect.target
      if ((fill !== 'forwards' && fill !== 'both') || !(target instanceof Element)) return
      const props = [...new Set(effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((p) => !KEYFRAME_META.has(p)).map(cssName)
      const read = (): string[] => {
        const style = getComputedStyle(target, effect.pseudoElement)
        return props.map((p) => settled(p, style.getPropertyValue(p)))
      }
      const held = read()
      effect.updateTiming({ fill: 'none' })
      if (read().some((value, i) => value !== held[i])) effect.updateTiming({ fill })
    }
    const onEnd = (event: AnimationEvent): void => {
      const target = event.target as Element | null
      target?.getAnimations().forEach(release)
    }
    document.getAnimations().forEach(release)
    document.addEventListener('animationend', onEnd, true)
    return () => document.removeEventListener('animationend', onEnd, true)
  }, [ready])

  // While a part of the page fades, Chromium blurs only what lies inside it,
  // so frosted glass in it showed the picture sharp until the fade was over:
  // every page and settings pane opened with clear panels for a moment. Its
  // motion alone doesn't do that, so an entrance with glass inside keeps its
  // motion and drops the fade. That happens as the page's new parts go in,
  // before the first frame: the fade runs on the compositor, and by the time
  // `animationstart` reaches a page busy opening, much of it has played.
  // Glass that arrives during a fade (a pane's cards once their data is in)
  // drops it then.
  useEffect(() => {
    if (!ready) return
    const seen = new WeakSet<Animation>()
    const fading = new Set<CSSAnimation>()
    const unfade = (animation: CSSAnimation): void => {
      fading.delete(animation)
      const effect = animation.effect as KeyframeEffect
      effect.setKeyframes(effect.getKeyframes().map((frame) => Object.fromEntries(Object.entries(frame).filter(([p]) => !FADES.has(p)))))
    }
    const consider = (animation: Animation): void => {
      if (seen.has(animation)) return
      seen.add(animation)
      const effect = animation.effect
      if (!(animation instanceof CSSAnimation) || animation.playState === 'finished' || !(effect instanceof KeyframeEffect)) return
      const target = effect.target
      if (!(target instanceof Element) || effect.pseudoElement || effect.getTiming().iterations === Infinity) return
      if (!effect.getKeyframes().some((frame) => Object.keys(frame).some((p) => FADES.has(p)))) return
      if (glassIn(target)) unfade(animation)
      else fading.add(animation)
    }
    // An entrance started some other way than by new elements (a class put on one).
    const onStart = (event: AnimationEvent): void => {
      const target = event.target as Element | null
      target?.getAnimations().forEach(consider)
    }
    const observer = new MutationObserver((records) => {
      // Asking for them brings the page's style up to date, which starts the new parts' entrances.
      document.getAnimations().forEach(consider)
      if (fading.size === 0) return
      for (const animation of fading) if (animation.playState === 'finished' || animation.playState === 'idle') fading.delete(animation)
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          for (const animation of fading) {
            if ((animation.effect as KeyframeEffect).target?.contains(node) && (frosted(node) || glassIn(node))) unfade(animation)
          }
        }
      }
    })
    document.getAnimations().forEach(consider)
    document.addEventListener('animationstart', onStart, true)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      document.removeEventListener('animationstart', onStart, true)
      observer.disconnect()
    }
  }, [ready])

  // macOS: the title bars drag through main, so the picture keeps up (see above).
  useEffect(() => {
    if (!ready || window.api.platform !== 'darwin') return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Element | null
      if (event.button !== 0 || !target?.closest(DRAG) || target.closest(NO_DRAG)) return
      event.preventDefault()
      if (event.detail === 2) {
        window.api.wallpaper.titleDoubleClick()
        return
      }
      window.api.wallpaper.drag('start')
      const end = (): void => {
        window.api.wallpaper.drag('end')
        window.removeEventListener('pointerup', end, true)
        window.removeEventListener('pointercancel', end, true)
        window.removeEventListener('blur', end)
      }
      window.addEventListener('pointerup', end, true)
      window.addEventListener('pointercancel', end, true)
      window.addEventListener('blur', end)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [ready])

  if (!on) return null
  return (
    <div className="see-through" data-ready={ready || undefined} style={{ '--see-tint': washOf(tint, light) } as CSSProperties} aria-hidden="true">
      <div ref={layer} className="see-through__layer" />
      <div className="see-through__tint" />
    </div>
  )
}

/** What getKeyframes() reports beside the animated properties. */
const KEYFRAME_META = new Set(['offset', 'computedOffset', 'easing', 'composite'])

/** Animated properties that keep frosted glass inside an element from blurring the picture while they run. */
const FADES = new Set(['opacity', 'filter', 'clipPath'])

/** Past this many elements, a part of the page is taken to have glass in it rather than searched. */
const GLASS_SEARCH = 4000

/** Whether this element is frosted glass itself. */
const frosted = (el: Element): boolean => getComputedStyle(el).backdropFilter !== 'none'

/** Whether any frosted glass lies inside this element. */
function glassIn(root: Element): boolean {
  const inside = root.getElementsByTagName('*')
  if (inside.length > GLASS_SEARCH) return true
  for (let i = 0; i < inside.length; i++) if (frosted(inside[i])) return true
  return false
}

/** `cssFloat`, `backgroundColor` → `float`, `background-color`. */
function cssName(prop: string): string {
  return prop === 'cssFloat' ? 'float' : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/** A computed value with the do-nothing forms of a motion folded into `none`, so a held last frame that moves nothing compares equal to no frame. */
function settled(prop: string, value: string): string {
  const v = value.trim()
  if (prop === 'transform' && v !== 'none') {
    try {
      return new DOMMatrixReadOnly(v).isIdentity ? 'none' : v
    } catch {
      return v
    }
  }
  if ((prop === 'translate' && /^0(px)?( 0(px)?){0,2}$/.test(v)) || (prop === 'scale' && /^1( 1){0,2}$/.test(v)) || (prop === 'rotate' && /^0(deg)?$/.test(v))) return 'none'
  if ((prop === 'filter' || prop === 'backdrop-filter') && /^(blur\(0px\)|brightness\(1\)|saturate\(1\))$/.test(v)) return 'none'
  return v
}

/**
 * How strongly the theme's colour covers the picture. Dark text on a light
 * wash needs more of it than light text on a dark one: the same setting
 * starts higher in light mode, so the quiet greys stay readable over a busy
 * wallpaper, and still reaches fully opaque at 100.
 */
function washOf(tint: number, light: boolean): number {
  const t = tint / 100
  return light ? 0.3 + 0.7 * t : t
}

/** Whether the app is painted light right now, following theme changes. */
function useLightTheme(): boolean {
  const [light, setLight] = useState(() => document.documentElement.dataset.theme === 'light')
  useEffect(() => {
    const observer = new MutationObserver(() => setLight(document.documentElement.dataset.theme === 'light'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return light
}

/**
 * A halftone screen over the picture: one dot per cell, larger where the
 * picture is darker, so its shapes come through as print does. Light cells
 * get no dot, which keeps the bright parts of the picture clean.
 */
function halftone(ctx: CanvasRenderingContext2D, image: HTMLImageElement, scale: number, light: boolean): void {
  const cell = Math.max(2, Math.round(CELL * scale))
  const cols = Math.ceil(ctx.canvas.width / cell)
  const rows = Math.ceil(ctx.canvas.height / cell)
  // One pixel per cell: the browser's downscale averages each cell for us.
  const sample = document.createElement('canvas')
  sample.width = cols
  sample.height = rows
  const sctx = sample.getContext('2d', { willReadFrequently: true })
  if (!sctx) return
  sctx.drawImage(image, 0, 0, cols, rows)
  const pixels = sctx.getImageData(0, 0, cols, rows).data
  // Softer ink under a light theme, where dark dots compete with dark text.
  ctx.fillStyle = light ? 'rgba(8, 6, 10, 0.34)' : 'rgba(8, 6, 10, 0.62)'
  ctx.beginPath()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 4
      const luminance = (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255
      const darkness = 1 - luminance
      // Mid-tones and highlights stay clean; the dots gather in the darker
      // shapes and swell with them, so the picture's forms come through.
      if (darkness < 0.42) continue
      const radius = cell * 0.52 * Math.pow(Math.min(1, (darkness - 0.36) / 0.5), 0.8)
      if (radius < 0.5) continue
      const x = c * cell + cell / 2
      const y = r * cell + cell / 2
      ctx.moveTo(x + radius, y)
      ctx.arc(x, y, radius, 0, Math.PI * 2)
    }
  }
  ctx.fill()
}

/** ASCII art's cell, in screen points: about a monospace character's shape. */
const ASCII_CELL = { width: 7, height: 13 }

/** From empty to full, in how much of its cell each character covers. */
const ASCII_RAMP = ' .:-=+*#%@'

/**
 * The picture as ASCII art: one character per cell, denser where the cell
 * stands out from the page (brighter on a dark theme, darker on a light
 * one), drawn in the cell's own colour on the theme's ground. The shapes and
 * colours of the wallpaper come through, built from text.
 */
function ascii(ctx: CanvasRenderingContext2D, image: HTMLImageElement, scale: number, light: boolean): void {
  const cellW = Math.max(3, Math.round(ASCII_CELL.width * scale))
  const cellH = Math.max(5, Math.round(ASCII_CELL.height * scale))
  const cols = Math.ceil(ctx.canvas.width / cellW)
  const rows = Math.ceil(ctx.canvas.height / cellH)
  // One pixel per cell: the browser's downscale averages each cell for us.
  const sample = document.createElement('canvas')
  sample.width = cols
  sample.height = rows
  const sctx = sample.getContext('2d', { willReadFrequently: true })
  if (!sctx) return
  sctx.drawImage(image, 0, 0, cols, rows)
  const pixels = sctx.getImageData(0, 0, cols, rows).data

  ctx.fillStyle = light ? '#f4f3f1' : '#050505'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.font = `${Math.round(cellH * 0.92)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // The picture's own range of brightness, ignoring the extreme few cells,
  // is stretched over the whole ramp: a dark or a pale wallpaper still uses
  // every character instead of a handful at one end.
  const levels: number[] = []
  for (let i = 0; i < pixels.length; i += 4) levels.push((0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255)
  const sorted = [...levels].sort((x, y) => x - y)
  const low = sorted[Math.floor(sorted.length * 0.02)] ?? 0
  const high = sorted[Math.floor(sorted.length * 0.98)] ?? 1
  const span = Math.max(0.05, high - low)
  const last = ASCII_RAMP.length - 1
  // A cell's colour, pushed away from the ground so it reads as ink.
  const ink = (v: number): number => Math.round(light ? v * 0.72 : Math.min(255, v * 1.25 + 18))
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 4
      const red = pixels[i]
      const green = pixels[i + 1]
      const blue = pixels[i + 2]
      const level = Math.min(1, Math.max(0, (levels[i / 4] - low) / span))
      const char = ASCII_RAMP[Math.round((light ? 1 - level : level) * last)]
      if (char === ' ') continue
      ctx.fillStyle = `rgb(${ink(red)}, ${ink(green)}, ${ink(blue)})`
      ctx.fillText(char, c * cellW + cellW / 2, r * cellH + cellH / 2)
    }
  }
}
