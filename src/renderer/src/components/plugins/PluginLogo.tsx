import type { CSSProperties } from 'react'
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

/**
 * A plugin's mark on a neutral tile. The assets are single-colour marks
 * (Simple Icons and vendor press kits), drawn through a CSS mask so they take
 * the theme's text colour — a white file shown as an <img> vanished on the
 * light theme's white tiles. Vendors without an official mark get a monogram
 * rather than an approximation of their logo.
 */
export function PluginLogo({
  logo,
  name,
  size = 34
}: {
  logo?: string
  name: string
  size?: number
}): JSX.Element {
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
      {url ? <span className="plugin-logo__mark" /> : <span className="plugin-logo__letter">{name.charAt(0).toUpperCase()}</span>}
    </span>
  )
}
