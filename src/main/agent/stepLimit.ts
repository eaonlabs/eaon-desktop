import { store } from '../store'

/** The step limit every install had by default before there was none. */
export const OLD_DEFAULT_STEPS = 40

/**
 * Settings are saved whole, so an install from before keeps the old default
 * of 40 as if it had been chosen, and Work replies kept stopping mid-change.
 * It becomes no limit; any other number was picked by hand and stays.
 */
export function noStepLimitByDefault(): void {
  const config = store.getSettings().codeIndex
  if (config.maxToolRounds === OLD_DEFAULT_STEPS) store.patchSettings({ codeIndex: { ...config, maxToolRounds: 0 } })
}
