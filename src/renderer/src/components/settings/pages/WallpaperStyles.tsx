import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { SeeThroughStyle } from '@shared/types'
import { wallpaperVideoUrl } from '@shared/wallpaper'
import { renderStyle, STYLES, type Paint } from '../../seeThrough/styles'
import { useLightTheme, washOf } from '../../SeeThrough'

/**
 * Settings → Appearance → Style: every style as a small preview of the
 * wallpaper itself (or a frame of the video), under the tint as it is now,
 * so the choice is made by looking rather than by name.
 */

/** A preview's canvas, in device pixels: drawn at twice the size it shows. */
const W = 232
const H = 145

/** What the previews are drawn from: the picture behind the window, or the chosen video's frame. */
function usePreviewSource(video: string | null): Paint | null {
  const [paint, setPaint] = useState<Paint | null>(null)
  useEffect(() => {
    let live = true
    setPaint(null)
    if (video) {
      const el = document.createElement('video')
      el.muted = true
      el.preload = 'auto'
      el.crossOrigin = 'anonymous'
      // A moment in, past a fade from black at the start.
      el.addEventListener('loadeddata', () => (el.currentTime = Math.min(1, (el.duration || 2) / 4)), { once: true })
      el.addEventListener(
        'seeked',
        () => {
          if (!live) return
          // A still of that frame, so the previews don't hold the video open.
          const still = document.createElement('canvas')
          still.width = el.videoWidth
          still.height = el.videoHeight
          still.getContext('2d')?.drawImage(el, 0, 0)
          setPaint(() => cover(still, still.width, still.height))
          el.removeAttribute('src')
          el.load()
        },
        { once: true }
      )
      el.src = wallpaperVideoUrl(video)
      return () => {
        live = false
        el.removeAttribute('src')
        el.load()
      }
    }
    void window.api.wallpaper.thumbnail().then((url) => {
      if (!live || !url) return
      const image = new Image()
      image.onload = () => live && setPaint(() => cover(image, image.naturalWidth, image.naturalHeight))
      image.src = url
    })
    return () => {
      live = false
    }
  }, [video])
  return paint
}

/** Draws a source to fill an area of any shape, cropped like a cover. */
function cover(source: CanvasImageSource, sw: number, sh: number): Paint {
  return (ctx, width, height) => {
    const want = width / height
    let w = sw
    let h = sh
    if (sw / sh > want) w = sh * want
    else h = sw / want
    ctx.drawImage(source, (sw - w) / 2, (sh - h) / 2, w, h, 0, 0, width, height)
  }
}

export function WallpaperStyles({
  value,
  tint,
  video,
  onChange
}: {
  value: SeeThroughStyle
  tint: number
  video: string | null
  onChange: (style: SeeThroughStyle) => void
}): JSX.Element {
  const paint = usePreviewSource(video)
  const light = useLightTheme()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const wash = washOf(tint, light)

  // Arrow keys move the choice, as in any group of radio buttons.
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = STYLES.findIndex((s) => s.id === value)
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (at + step + STYLES.length) % STYLES.length
    onChange(STYLES[next].id)
    buttons.current[next]?.focus()
  }

  return (
    <div className="wallpaper-styles" role="radiogroup" aria-label="Style" onKeyDown={onKey}>
      {STYLES.map((style, index) => {
        const chosen = style.id === value
        return (
          <button
            key={style.id}
            ref={(el) => {
              buttons.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            className="wallpaper-styles__item"
            title={style.hint}
            onClick={() => onChange(style.id)}
          >
            <span className="wallpaper-styles__frame">
              <Preview style={style.id} paint={paint} light={light} />
              <span className="wallpaper-styles__tint" style={{ opacity: wash }} />
            </span>
            <span className="wallpaper-styles__label">{style.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function Preview({ style, paint, light }: { style: SeeThroughStyle; paint: Paint | null; light: boolean }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !paint) return
    renderStyle(style, ctx, paint, 1, light)
  }, [style, paint, light])
  return <canvas ref={canvas} className="wallpaper-styles__canvas" width={W} height={H} aria-hidden="true" data-empty={!paint || undefined} />
}
