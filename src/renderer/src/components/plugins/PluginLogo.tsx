import type { CSSProperties, ReactNode } from 'react'
import './plugins.css'

// Bundled at build time and looked up by the catalog's `logoAssetName`, so the
// data stays a plain list of strings rather than dozens of import statements.
const LOGOS = import.meta.glob('../../assets/plugins/*', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

export function logoFor(name: string | undefined): string | undefined {
  if (!name) return undefined
  const path = Object.keys(LOGOS).find((key) => key.endsWith(`/${name}`))
  return path ? LOGOS[path] : undefined
}

// The apps workers use (DoorDash, Uber…) carry their real icons, in colour.
const APP_LOGOS = import.meta.glob('../../assets/app-logos/*', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

/** An app's own icon (WorkerApp.logo), drawn as it is rather than as a mask. */
export function appLogoFor(name: string | undefined): string | undefined {
  if (!name) return undefined
  const path = Object.keys(APP_LOGOS).find((key) => key.endsWith(`/${name}`))
  return path ? APP_LOGOS[path] : undefined
}

/**
 * A plugin's mark on a neutral tile. The assets are single-colour marks
 * (Simple Icons and vendor press kits), drawn through a CSS mask so they take
 * the theme's text colour — a white file shown as an <img> vanished on the
 * light theme's white tiles. Vendors without an official mark get a monogram
 * rather than an approximation of their logo. An app's own icon (appLogoFor)
 * fills the tile in its real colours instead.
 */
export function PluginLogo({
  logo,
  name,
  size = 34,
  icon
}: {
  logo?: string
  name: string
  size?: number
  /** Drawn when there is no mark, instead of the monogram (a bank's building). */
  icon?: ReactNode
}): JSX.Element {
  const art = appLogoFor(logo)
  if (art) {
    return (
      <span className="plugin-logo plugin-logo--art" style={{ width: size, height: size }} aria-hidden="true">
        <img src={art} alt="" draggable={false} />
      </span>
    )
  }
  const url = logoFor(logo)
  const style = {
    width: size,
    height: size,
    borderRadius: Math.max(4, Math.round(size * 0.26)),
    // Proportional at list size, but never so small a tray monogram is a speck.
    fontSize: Math.max(10, Math.round(size * 0.44)),
    ...(url ? { '--logo': `url("${url}")` } : {})
  } as CSSProperties
  return (
    <span className="plugin-logo" style={style} aria-hidden="true">
      {url ? <span className="plugin-logo__mark" /> : icon ?? <span className="plugin-logo__letter">{name.charAt(0).toUpperCase()}</span>}
    </span>
  )
}
