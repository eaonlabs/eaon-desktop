import type { UsageDay, UsageTool } from '@shared/usage'

/** Eaon and the coding CLIs as Settings → Usage names and orders them. */

export const TOOL_LABEL: Record<UsageTool, string> = {
  eaon: 'Eaon',
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  grok: 'Grok Build',
  'qwen-code': 'Qwen Code',
  'copilot-cli': 'GitHub Copilot CLI',
  opencode: 'opencode',
  amp: 'Amp',
  droid: 'Droid',
  'kimi-cli': 'Kimi CLI'
}
/** Bottom to top in a bar, and the legend's order. */
export const TOOL_ORDER: UsageTool[] = [
  'eaon',
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'gemini-cli',
  'grok',
  'qwen-code',
  'copilot-cli',
  'opencode',
  'amp',
  'droid',
  'kimi-cli'
]

/** The logo a tool goes by (ProviderMark's ids). */
export const toolMark = (tool: UsageTool): string => (tool === 'eaon' ? 'eaon' : `cli:${tool}`)

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
