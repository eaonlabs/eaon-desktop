import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import type { LogoImage } from '@shared/providerLogos'
import './custom-logo.css'

/**
 * Draws a logo Eaon didn't ship (picked by the person or found from a custom
 * provider's base URL) so it sits with the built-in ones whatever shape it
 * came in. Each image is looked at once, on a canvas:
 *
 * - one that fills its own square (an app icon, a logo on a coloured square)
 *   becomes the whole tile, its corners rounded like the rest;
 * - otherwise the empty or plain background around it is cut away, and what's
 *   left is centred and sized like the built-in marks, a wide wordmark given
 *   more width than a square mark;
 * - a one-colour logo is flipped where it would vanish: a white one gets a
 *   dark tile, and as a bare mark a black one turns white in dark mode (or
 *   the provider's own dark-mode logo is used).
 *
 * Shown as <img> only, so an SVG can't run anything.
 */

export interface LogoFit {
  /** Fills its own square edge to edge: shown as the whole tile. */
  fullBleed: boolean
  /** What's drawn, with the space and plain background around it cut away (PNG data: URL). */
  trimmed: string
  /** Width over height of what's drawn. */
  aspect: number
  /** One colour, dark or light; null for a logo in colour. */
  tone: 'dark' | 'light' | null
}

const SIDE = 256
const fits = new Map<string, Promise<LogoFit | null>>()
const known = new Map<string, LogoFit | null>()

const luminance = (r: number, g: number, b: number): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
const saturation = (r: number, g: number, b: number): number => {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}
const distance = (data: Uint8ClampedArray, i: number, bg: number[]): number =>
  Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])

async function analyze(src: string): Promise<LogoFit | null> {
  const image = new Image()
  image.src = src
  await image.decode()
  // An SVG with no size of its own is drawn as a square.
  const naturalW = image.naturalWidth || SIDE
  const naturalH = image.naturalHeight || SIDE
  const scale = SIDE / Math.max(naturalW, naturalH)
  const w = Math.max(1, Math.round(naturalW * scale))
  const h = Math.max(1, Math.round(naturalH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(image, 0, 0, w, h)
  const pixels = context.getImageData(0, 0, w, h)
  const { data } = pixels
  const at = (x: number, y: number): number => (y * w + x) * 4

  // Square and solid along the middle of every edge (rounded corners allowed): it's its own tile.
  const square = Math.abs(w - h) <= Math.max(w, h) * 0.08
  const edges = [at(w >> 1, 1), at(w >> 1, h - 2), at(1, h >> 1), at(w - 2, h >> 1)]
  if (square && edges.every((i) => data[i + 3] > 230)) return { fullBleed: true, trimmed: src, aspect: 1, tone: null }

  // A plain background (the four corners solid and alike) is keyed out, like transparency.
  const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)]
  const bg =
    corners.every((i) => data[i + 3] > 240) && corners.every((i) => distance(data, i, [data[corners[0]], data[corners[0] + 1], data[corners[0] + 2]]) <= 30)
      ? [data[corners[0]], data[corners[0] + 1], data[corners[0] + 2]]
      : null
  let left = w
  let top = h
  let right = -1
  let bottom = -1
  let inked = 0
  let flat = 0
  let lightSum = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = at(x, y)
      if (bg) data[i + 3] = Math.round(data[i + 3] * Math.min(1, Math.max(0, (distance(data, i, bg) - 24) / 72)))
      if (data[i + 3] <= 24) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      if (data[i + 3] > 128) {
        inked++
        lightSum += luminance(data[i], data[i + 1], data[i + 2])
        if (saturation(data[i], data[i + 1], data[i + 2]) < 0.18) flat++
      }
    }
  }
  if (right < 0) return null
  if (bg) context.putImageData(pixels, 0, 0)
  const cropW = right - left + 1
  const cropH = bottom - top + 1
  const out = document.createElement('canvas')
  out.width = cropW
  out.height = cropH
  out.getContext('2d')?.drawImage(canvas, left, top, cropW, cropH, 0, 0, cropW, cropH)
  const mean = inked ? lightSum / inked : 0.5
  const mono = inked > 0 && flat / inked >= 0.92
  return {
    fullBleed: false,
    trimmed: out.toDataURL('image/png'),
    aspect: cropW / cropH,
    tone: mono && mean < 0.4 ? 'dark' : mono && mean > 0.72 ? 'light' : null
  }
}

/** How to draw a logo, worked out once per image. Null: it couldn't be read (drawn as it is). */
export function fitLogo(src: string): Promise<LogoFit | null> {
  let pending = fits.get(src)
  if (!pending) {
    pending = analyze(src).catch(() => null)
    fits.set(src, pending)
    void pending.then((fit) => known.set(src, fit))
  }
  return pending
}

/** The fit, or undefined while it's worked out. */
function useFit(src: string | undefined): LogoFit | null | undefined {
  const [fit, setFit] = useState<LogoFit | null | undefined>(() => (src ? known.get(src) : null))
  useEffect(() => {
    if (!src) {
      setFit(null)
      return
    }
    if (known.has(src)) {
      setFit(known.get(src))
      return
    }
    let live = true
    setFit(undefined)
    void fitLogo(src).then((result) => live && setFit(result))
    return () => {
      live = false
    }
  }, [src])
  return fit
}

/** Width and height for what's drawn, inside a box of `boxW` × `boxH`. */
const contain = (aspect: number, boxW: number, boxH: number): { width: number; height: number } => {
  const height = Math.min(boxH, boxW / aspect)
  return { width: Math.round(height * aspect * 10) / 10, height: Math.round(height * 10) / 10 }
}

/** As a tile, like the built-in logos in Settings and Link accounts: white, or dark under a white logo. */
export function LogoTile({ logo, size }: { logo: LogoImage; size: number }): JSX.Element {
  const fit = useFit(logo.src)
  const radius = Math.round(size * 0.235)
  const style: CSSProperties = { width: size, height: size, borderRadius: radius }
  if (fit?.fullBleed) {
    return (
      <span className="icon-tile plogo plogo--tile" data-full style={style} aria-hidden="true">
        <img src={logo.src} alt="" draggable={false} />
      </span>
    )
  }
  // A wordmark gets more width than a square mark, and the same visual weight.
  const wide = (fit?.aspect ?? 1) > 1.3
  const box = fit ? contain(fit.aspect, size * (wide ? 0.8 : 0.64), size * (wide ? 0.5 : 0.64)) : { width: size * 0.64, height: size * 0.64 }
  return (
    <span className="icon-tile plogo plogo--tile" data-tone={fit?.tone ?? undefined} style={style} aria-hidden="true">
      <img src={fit?.trimmed ?? logo.src} alt="" draggable={false} style={{ width: box.width, height: box.height, objectFit: 'contain' }} />
    </span>
  )
}

/** As a bare mark, on the panel itself (the model picker, the composer's chip, usage). */
export function LogoMark({ logo, size }: { logo: LogoImage; size: number }): JSX.Element {
  const fit = useFit(logo.src)
  const darkFit = useFit(logo.dark)
  const style: CSSProperties = { width: size, height: size }
  if (fit?.fullBleed) {
    return (
      <span className="plogo plogo--mark" data-full style={{ ...style, borderRadius: Math.round(size * 0.25) }} aria-hidden="true">
        <img src={logo.src} alt="" draggable={false} />
      </span>
    )
  }
  const box = fit ? contain(fit.aspect, size, size) : { width: size, height: size }
  const darkBox = darkFit && !darkFit.fullBleed ? contain(darkFit.aspect, size, size) : box
  return (
    <span className="plogo plogo--mark" data-tone={logo.dark ? undefined : (fit?.tone ?? undefined)} data-has-dark={logo.dark ? true : undefined} style={style} aria-hidden="true">
      <img className="plogo__light" src={fit?.trimmed ?? logo.src} alt="" draggable={false} style={{ width: box.width, height: box.height, objectFit: 'contain' }} />
      {logo.dark && (
        <img
          className="plogo__dark"
          src={darkFit && !darkFit.fullBleed ? darkFit.trimmed : logo.dark}
          alt=""
          draggable={false}
          style={{ width: darkBox.width, height: darkBox.height, objectFit: 'contain' }}
        />
      )}
    </span>
  )
}
