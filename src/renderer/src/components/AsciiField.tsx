import { useEffect, useRef, type JSX } from 'react'

/**
 * The home screen's backdrop: a field of faint monospace characters, lit in
 * slow-drifting patches, the way a terminal's scrollback glows behind a
 * prompt. A cell's brightness comes from smooth value noise moving with time,
 * and a few cells change character each frame so the field shimmers without
 * ever flickering.
 *
 * Cheap on purpose: it runs at a low frame rate, skips cells too dim to see,
 * stops while the window is hidden, and holds still under reduced motion.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const FONT_PX = 11
const CELL_H = 15
const FPS = 8
/** How much brighter than nothing the brightest patch is; tuned per theme. */
const PEAK = { dark: 0.16, light: 0.12 }

/** Lattice values for the noise, fixed per mount. */
function lattice(size: number): Float32Array {
  const values = new Float32Array(size * size)
  for (let i = 0; i < values.length; i++) values[i] = Math.random()
  return values
}

const smooth = (t: number): number => t * t * (3 - 2 * t)

/** Value noise on a wrapping lattice: smooth, 0 to 1. */
function noise(values: Float32Array, size: number, x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const tx = smooth(x - xi)
  const ty = smooth(y - yi)
  const at = (cx: number, cy: number): number => values[(((cy % size) + size) % size) * size + (((cx % size) + size) % size)]
  const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * tx
  const bottom = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * tx
  return top + (bottom - top) * ty
}

export function AsciiField({ className }: { className?: string }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return

    const size = 64
    const coarse = lattice(size)
    const fine = lattice(size)
    let cols = 0
    let rows = 0
    let cellW = 7
    let glyphs = new Uint8Array(0)
    let last = 0
    let raf = 0
    let ink = '255, 255, 255'
    let peak = PEAK.dark

    const readTheme = (): void => {
      const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#ffffff'
      // Any CSS colour to "r, g, b" via the canvas itself.
      ctx.fillStyle = fg
      const hex = ctx.fillStyle
      const m = /^#([0-9a-f]{6})$/i.exec(hex)
      ink = m ? `${parseInt(m[1].slice(0, 2), 16)}, ${parseInt(m[1].slice(2, 4), 16)}, ${parseInt(m[1].slice(4, 6), 16)}` : '255, 255, 255'
      peak = document.documentElement.dataset.theme === 'light' ? PEAK.light : PEAK.dark
    }

    const layout = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const { width, height } = el.getBoundingClientRect()
      el.width = Math.max(1, Math.round(width * dpr))
      el.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = `${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.textBaseline = 'top'
      cellW = ctx.measureText('M').width + 0.6
      cols = Math.ceil(width / cellW)
      rows = Math.ceil(height / CELL_H)
      glyphs = new Uint8Array(cols * rows)
      for (let i = 0; i < glyphs.length; i++) glyphs[i] = Math.floor(Math.random() * CHARS.length)
      readTheme()
      draw(performance.now())
    }

    const draw = (now: number): void => {
      const t = now / 1000
      ctx.clearRect(0, 0, el.width, el.height)
      // A few cells take a new character each frame.
      const changes = Math.ceil(glyphs.length * 0.012)
      for (let i = 0; i < changes; i++) glyphs[Math.floor(Math.random() * glyphs.length)] = Math.floor(Math.random() * CHARS.length)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // Broad patches drifting one way, finer grain the other.
          const broad = noise(coarse, size, c / 22 + t * 0.05, r / 9 - t * 0.02)
          const grain = noise(fine, size, c / 6 - t * 0.12, r / 3 + t * 0.04)
          const v = broad * 0.75 + grain * 0.25
          const a = (v - 0.48) * 2.6
          if (a <= 0.02) continue
          ctx.fillStyle = `rgba(${ink}, ${Math.min(1, a) * peak})`
          ctx.fillText(CHARS[glyphs[r * cols + c]], c * cellW, r * CELL_H)
        }
      }
    }

    const still = (): boolean =>
      document.body.dataset.reduceMotion === 'on' || window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
    // The theme switching repaints in the new ink.
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
  }, [])

  return <canvas ref={canvas} className={className} aria-hidden="true" />
}
