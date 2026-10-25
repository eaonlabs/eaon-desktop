/**
 * Provider logos that aren't built into Eaon: one the person picks for any
 * provider (Settings → Model providers), and one found from a custom
 * provider's base URL (main/providers/logos.ts). docs/provider-logos.md is
 * the guide for API providers who want theirs to show up on its own.
 */

import { REPO_URL } from './links'

/** The guide for API providers (and for anyone whose logo didn't show up). */
export const PROVIDER_LOGO_DOCS_URL = `${REPO_URL}/blob/main/docs/provider-logos.md`

/** Where an API provider publishes its logo for Eaon, on its API host or its website (RFC 8615). */
export const PROVIDER_MANIFEST_PATH = '/.well-known/eaon-provider.json'

/** Largest logo file Eaon takes, found or picked. */
export const MAX_LOGO_BYTES = 1024 * 1024

/** Smallest raster logo, in pixels on its shorter side. Vector logos (SVG) have no minimum. */
export const MIN_LOGO_PIXELS = 16

/** A logo as stored: the image itself, as a data: URL (the window only shows images it holds). */
export interface LogoImage {
  src: string
  /** A version for dark mode, when the provider published one. */
  dark?: string
}

/** One thing tried while looking for a logo, and what came of it. */
export interface LogoLookupStep {
  url: string
  result: string
}

export interface ProviderLogo {
  /** Picked by the person. Shown over everything else, built-in logos included. */
  user?: LogoImage & { setAt: number }
  /** Found from the provider's base URL. */
  site?: LogoImage & {
    /** The file it came from. */
    from: string
    /** The name the provider's manifest gave, if it had one. */
    name?: string
    baseUrl: string
    foundAt: number
  }
  /** The last look-up from the base URL, found or not: Settings shows it. */
  lookup?: {
    baseUrl: string
    at: number
    found: boolean
    steps: LogoLookupStep[]
  }
}

/** Every provider's logo record, by provider id. */
export type ProviderLogos = Record<string, ProviderLogo>

/** The logo to show for a provider, if any: the person's own, else the one found. */
export function chosenLogo(record: ProviderLogo | undefined): LogoImage | null {
  if (record?.user) return { src: record.user.src }
  if (record?.site) return { src: record.site.src, dark: record.site.dark }
  return null
}
