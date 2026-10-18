import type { JSX } from 'react'
import { useApp } from '../state/store'
import { UsageRings } from './UsageRings'
import { UsageMeter } from './code/UsageMeter'

/**
 * The plan usage meter where Settings → Accounts puts it: the sidebar's foot,
 * the ADE's header, or both, as rings or as a bar. Each place renders this;
 * it shows the meter only if the setting puts it there.
 */
export function UsagePlacement({ where }: { where: 'sidebar' | 'header' }): JSX.Element | null {
  const usage = useApp((s) => s.settings?.cliUsage)
  if (!usage || usage.meter === false) return null
  const placement = usage.placement ?? 'sidebar'
  if (placement !== 'both' && placement !== where) return null
  return (usage.style ?? 'rings') === 'rings' ? <UsageRings where={where} /> : <UsageMeter where={where} />
}
