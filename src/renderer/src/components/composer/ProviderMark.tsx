import type { JSX } from 'react'
import { LogoMark } from '../../icons/customLogo'
import { providerLogoNow, useProviderLogo } from '../../state/providerLogos'
import { MARK, MONO } from './markFiles'
import type { CliEngineId, EngineId } from '@shared/engines'

/** Each agent CLI's logo key for ProviderMark: plain `gemini` is the Gemini API provider's. */
// Claude's is Anthropic's mark: the Agent SDK's branding rules keep apps built on it from looking like Claude Code.
export const ENGINE_MARK: Record<CliEngineId, string> = { codex: 'codex', claude: 'anthropic', copilot: 'github-copilot', gemini: 'gemini-cli' }

/** The logo key for a model picker row: its engine's own for an agent CLI's model, else its provider's. */
export const optionMark = (option: { engine: EngineId; groupId: string }): string => (option.engine === 'native' ? option.groupId : ENGINE_MARK[option.engine])

/**
 * A provider's bare mark, without the tile its logo is drawn on elsewhere:
 * the model picker's tab row shows marks on the panel itself. The files in
 * assets/providers/marks are the logos with their tile keyed out. A
 * single-colour mark is stored white and darkened in light mode by CSS
 * (`.pmark[data-mono]`); a coloured one is shown as it is.
 */

const files = import.meta.glob('../../assets/providers/marks/*.{png,svg}', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>

const URLS: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.split('/').pop()!.replace(/\.(png|svg)$/, ''), url])
)

/** Which mark file a provider uses, so two providers sharing one can be told apart. */
export function markKey(providerId: string): string {
  if (providerLogoNow(providerId)) return `logo:${providerId}`
  return MARK[providerId] ?? `monogram:${providerId}`
}

export function ProviderMark({ providerId, name, size = 16 }: { providerId: string; name?: string; size?: number }): JSX.Element {
  // The person's own logo, or one found from a custom provider's base URL, comes first.
  const custom = useProviderLogo(providerId)
  if (custom) return <LogoMark logo={custom} size={size} />
  const file = MARK[providerId]
  const url = file ? URLS[file] : undefined
  if (url) {
    return <img className="pmark" data-mono={MONO.has(file) || undefined} src={url} width={size} height={size} alt="" draggable={false} />
  }
  // No logo shipped: the provider's first letter in a ring, sized like a mark.
  return (
    <span className="pmark pmark--letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }} aria-hidden="true">
      {(name ?? providerId).trim().charAt(0).toUpperCase()}
    </span>
  )
}
