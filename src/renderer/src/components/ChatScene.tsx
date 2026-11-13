import { useEffect, useRef, type CSSProperties, type JSX } from 'react'
import type { ChatScene } from '@shared/chatScenes'
import { CELL_H, PALETTE, SCENES, SKY, type Frame } from './chatScene/scenes'

/**
 * A scene drawn in characters behind the conversation: a sky of colour with
 * clouds, koi, jellyfish, an aurora and the like built from a grid of
 * `> < ? : "` marks that slowly moves.
 *
 * It stays behind the words. The colour is a wash that lets the theme show
 * through, each mark is faint, and the column where the conversation and the
 * message box sit is quieter still (chat.css .chat-scene__marks), so the
 * scene frames the text without competing with it. It runs at a low frame
 * rate, stops while the window is hidden, and holds still under reduced
 * motion.
 *
 * `zoom` draws the same picture smaller (the picker's thumbnails) and `at`
 * draws one still frame of it, at that many seconds in.
 */

const FONT_PX = 12
const FPS = 12
/** Marks from the thinnest edge to the densest middle. */
const RAMP = ['.', ':', '"', '<', '>', '?', '+', '#']
/** The brightest a mark gets, per theme. */
const PEAK = { dark: 1, light: 0.85 }

export function ChatScene({ scene, className, zoom = 1, at }: { scene: ChatScene; className?: string; zoom?: number; at?: number }): JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx || scene === 'off') return
    const colors = PALETTE[scene]
    const render = SCENES[scene]
    let cols = 0
    let rows = 0
    let cellW = 7
    let w = 0
    let h = 0
    let peak = PEAK.dark
    let light = false
    let strength = new Float32Array(0)
    let color = new Uint8Array(0)
    let glyph: string[] = []
    let raf = 0
    let last = 0

    const put: Frame['put'] = (c, r, s, k, ch) => {
      if (c < 0 || r < 0 || c >= cols || r >= rows || s <= 0) return
      const i = r * cols + c
      if (s > strength[i]) {
        strength[i] = Math.min(1, s)
        color[i] = k
        glyph[i] = ch ?? ''
      }
    }
    const ellipse: Frame['ellipse'] = (cx, cy, rx, ry, k, amp = 1, half) => {
      for (let r = Math.max(0, Math.floor((cy - ry) / CELL_H)); r <= Math.min(rows - 1, Math.ceil((cy + ry) / CELL_H)); r++) {
        for (let c = Math.max(0, Math.floor((cx - rx) / cellW)); c <= Math.min(cols - 1, Math.ceil((cx + rx) / cellW)); c++) {
          const dx = (c * cellW - cx) / rx
          const dy = (r * CELL_H - cy) / ry
          if ((half === 'top' && dy > 0) || (half === 'bottom' && dy < 0)) continue
          const d = dx * dx + dy * dy
          if (d < 1) put(c, r, amp * (0.6 + 0.4 * (1 - d)), k)
        }
      }
    }

    const readTheme = (): void => {
      light = document.documentElement.dataset.theme === 'light'
      peak = light ? PEAK.light : PEAK.dark
    }

    const draw = (now: number): void => {
      strength.fill(0)
      glyph = new Array(cols * rows).fill('')
      render({ cols, rows, cellW, t: at ?? now / 1000, put, ellipse, w, h })
      ctx.clearRect(0, 0, el.width, el.height)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c
          const s = strength[i]
          if (s < 0.06) continue
          const [dark, bright] = colors[color[i]] ?? colors[0]
          const rgb = light ? bright : dark
          ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(0.42 + 0.58 * s) * peak})`
          ctx.fillText(glyph[i] || RAMP[Math.min(RAMP.length - 1, Math.floor(s * RAMP.length))], c * cellW, r * CELL_H)
        }
      }
    }

    const layout = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = el.getBoundingClientRect()
      w = rect.width / zoom
      h = rect.height / zoom
      el.width = Math.max(1, Math.round(rect.width * dpr))
      el.height = Math.max(1, Math.round(rect.height * dpr))
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0)
      ctx.font = `600 ${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.textBaseline = 'top'
      cellW = ctx.measureText('M').width + 1.4
      cols = Math.ceil(w / cellW)
      rows = Math.ceil(h / CELL_H)
      strength = new Float32Array(cols * rows)
      color = new Uint8Array(cols * rows)
      readTheme()
      draw(performance.now())
    }

    const still = (): boolean => at !== undefined || document.body.dataset.reduceMotion === 'on' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (document.hidden || now - last < 1000 / FPS) return
      last = now
      draw(now)
    }

    layout()
    if (!still()) raf = requestAnimationFrame(tick)
    const observer = new ResizeObserver(layout)
    observer.observe(el)
    const themes = new MutationObserver(() => {
      readTheme()
      draw(performance.now())
    })
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      themes.disconnect()
    }
  }, [scene, zoom, at])

  if (scene === 'off') return null
  const [dark, light] = SKY[scene]
  const sky = { '--sky-a': dark[0], '--sky-b': dark[1], '--sky-a-light': light[0], '--sky-b-light': light[1] } as CSSProperties
  return (
    <div className={className ?? 'chat-scene'} style={sky} aria-hidden="true">
      <div className="chat-scene__sky" />
      <canvas ref={canvas} className="chat-scene__marks" />
    </div>
  )
}
