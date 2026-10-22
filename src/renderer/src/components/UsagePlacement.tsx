import type { JSX } from 'react'
import { useApp } from '../state/store'
import { UsageRings } from './UsageRings'
import { UsageMeter } from './code/UsageMeter'

/**
 * The plan usage meter in the ADE's header, as rings or as a bar (Settings →
 * Accounts), unless it is turned off. It is only in the ADE, where the coding
 * agents whose plans it counts run.
 */
export function UsagePlacement(): JSX.Element | null {
  const usage = useApp((s) => s.settings?.cliUsage)
  if (!usage || usage.meter === false) return null
  return (usage.style ?? 'rings') === 'rings' ? <UsageRings /> : <UsageMeter />
}
