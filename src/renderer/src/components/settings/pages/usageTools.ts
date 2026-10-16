import type { UsageDay, UsageTool } from '@shared/usage'

/** Eaon, Claude Code and Codex as Settings → Usage names and orders them. */

export const TOOL_LABEL: Record<UsageTool, string> = { eaon: 'Eaon', 'claude-code': 'Claude Code', codex: 'Codex' }
/** Bottom to top in a bar, and the legend's order. */
export const TOOL_ORDER: UsageTool[] = ['eaon', 'claude-code', 'codex']

export const listOf = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** A day's split by tool, as the readouts show it: "Eaon $1.20 · Claude Code ≈ $40". */
export function toolSplit(day: UsageDay, money: (usd: number) => string, tokens: (n: number) => string): string | null {
  const parts = TOOL_ORDER.flatMap((tool) => {
    const share = day.tools?.[tool]
    if (!share || share.requests === 0) return []
    const figure = share.usd > 0 ? `${tool === 'eaon' ? '' : '≈ '}${money(share.usd)}` : `${tokens(share.tokens)} tokens`
    return [`${TOOL_LABEL[tool]} ${figure}`]
  })
  return parts.length > 1 || (parts.length === 1 && !day.tools?.eaon) ? parts.join(' · ') : null
}
