import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { isVideoWallpaper, type SeeThroughStyle, type WallpaperFrame } from '@shared/types'
import { useApp } from '../state/store'
import { wallpaperVideoUrl } from '@shared/wallpaper'
import { renderStyle, styleInfo, type Paint } from './seeThrough/styles'
import '../styles/seeThrough.css'

/**
 * See-through (Settings → Appearance): the desktop's picture drawn behind the
 * whole app, lined up with the screen as the window moves, so the window
 * reads as glass over the desktop. Over it lies the theme's own colour, as
 * strongly as the tint setting says. The picture can be drawn as it is or in
 * one of the styles (seeThrough/styles.ts): halftone, characters, dither,
 * mosaic and the rest. The app's panels frost over all of it (seeThrough.css).
 *
 * A wallpaper of the user's own can be a video. It plays muted and looping,
 * as it is or redrawn in the style a few times a second, and holds still
 * while the window is hidden, with Reduce motion on, or when its Play switch
 * is off.
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

/** A video's styles are drawn at one device pixel a point: a frame is redrawn many times a second. */
const VIDEO_SCALE = 1

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
  const video = custom && isVideoWallpaper(options?.custom) ? (options?.custom ?? null) : null
  const style: SeeThroughStyle = options?.style ?? (options?.texture === false ? 'photo' : 'halftone')
  const tint = Math.min(100, Math.max(0, options?.tint ?? 55))
  const light = useLightTheme()
  const stillness = useReducedMotion()
  const plays = options?.videoPlays !== false && !stillness

  /** The display the window is on: only a change of display reloads the picture. */
  const [display, setDisplay] = useState<WallpaperFrame['display'] | null>(null)
  const [picture, setPicture] = useState<string | null>(null)
  /** The video wallpaper, once it has a frame to show. */
  const [clip, setClip] = useState<HTMLVideoElement | null>(null)
  /** What the layer shows: the picture in its style, or the video (as it is, or a canvas it is redrawn into). */
  const [plate, setPlate] = useState<HTMLCanvasElement | HTMLVideoElement | null>(null)
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
  // coming back to the app, in case the wallpaper changed meanwhile. A video
  // has no picture to ask main for.
  const displayId = display?.id
  useEffect(() => {
    if (!on || video || displayId === undefined) return
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
  }, [on, video, displayId, source])

  // A picture's plate: drawn once, in its style.
  useEffect(() => {
    if (!on || video || !picture || !display) return
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
      renderStyle(style, ctx, (c, w, h) => c.drawImage(image, 0, 0, w, h), next.width / display.width, light)
      setPlate(next)
    }
    image.src = picture
    return () => {
      live = false
    }
  }, [on, video, picture, style, light, display])

  // A video wallpaper: one element per file, ready once its first frame is in.
  useEffect(() => {
    if (!on || !video) return
    const el = document.createElement('video')
    el.muted = true
    el.loop = true
    el.playsInline = true
    el.preload = 'auto'
    // Its frames are drawn into the styles' canvas and read back, so it comes with CORS.
    el.crossOrigin = 'anonymous'
    el.className = 'see-through__picture see-through__video'
    const ready = (): void => setClip(el)
    el.addEventListener('loadeddata', ready, { once: true })
    el.src = wallpaperVideoUrl(video)
    return () => {
      el.removeEventListener('loadeddata', ready)
      el.pause()
      el.removeAttribute('src')
      el.load()
      setClip(null)
      setPlate(null)
    }
  }, [on, video])

  // The video as it is, or redrawn in its style as it plays: a few times a
  // second, at most each new frame, and once more whenever it stops on one.
  useEffect(() => {
    if (!clip || !display) return
    if (style === 'photo') {
      setPlate(clip)
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(display.width * VIDEO_SCALE)
    canvas.height = Math.round(display.height * VIDEO_SCALE)
    canvas.className = 'see-through__picture'
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const paint = coverOf(clip)
    const every = 1000 / styleInfo(style).fps
    let last = -Infinity
    let stopped = false
    let handle = 0
    const draw = (): void => renderStyle(style, ctx, paint, VIDEO_SCALE, light)
    const tick = (now: number): void => {
      if (stopped) return
      if (now - last >= every - 4) {
        last = now
        draw()
      }
      schedule()
    }
    const schedule = (): void => {
      handle = 'requestVideoFrameCallback' in clip ? clip.requestVideoFrameCallback(tick) : requestAnimationFrame(tick)
    }
    draw()
    setPlate(canvas)
    schedule()
    // Paused on a frame (or moved to one): that frame, in the style.
    clip.addEventListener('seeked', draw)
    clip.addEventListener('pause', draw)
    return () => {
      stopped = true
      if ('cancelVideoFrameCallback' in clip) clip.cancelVideoFrameCallback(handle)
      else cancelAnimationFrame(handle)
      clip.removeEventListener('seeked', draw)
      clip.removeEventListener('pause', draw)
    }
  }, [clip, style, light, display])

  // It plays while the window is on screen, unless it's meant to hold still.
  useEffect(() => {
    if (!clip) return
    const sync = (): void => {
      if (plays && document.visibilityState === 'visible') void clip.play().catch(() => undefined)
      else clip.pause()
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [clip, plays])

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
export function washOf(tint: number, light: boolean): number {
  const t = tint / 100
  return light ? 0.3 + 0.7 * t : t
}

/** Whether the app is painted light right now, following theme changes. */
export function useLightTheme(): boolean {
  const [light, setLight] = useState(() => document.documentElement.dataset.theme === 'light')
  useEffect(() => {
    const observer = new MutationObserver(() => setLight(document.documentElement.dataset.theme === 'light'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return light
}

/** Draws a video's current frame to fill a display-shaped area, cropped like a cover, centred. */
function coverOf(clip: HTMLVideoElement): Paint {
  return (ctx, width, height) => {
    const vw = clip.videoWidth
    const vh = clip.videoHeight
    if (!vw || !vh) return
    const want = width / height
    let sw = vw
    let sh = vh
    if (vw / vh > want) sw = vh * want
    else sh = vw / want
    ctx.drawImage(clip, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, width, height)
  }
}

/** Whether motion is turned down: Settings → Appearance → Reduce motion, or the system's when it follows that. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => document.body.dataset.reduceMotion === 'on')
  useEffect(() => {
    const observer = new MutationObserver(() => setReduced(document.body.dataset.reduceMotion === 'on'))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-reduce-motion'] })
    return () => observer.disconnect()
  }, [])
  return reduced
}
