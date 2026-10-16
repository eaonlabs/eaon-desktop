import { existsSync, readFileSync } from 'node:fs'
import { store } from '../store'
import { docPath } from '../storeFiles'

/**
 * The first-run setup and the tour (components/onboarding) are for a fresh
 * install. This runs at startup before anything writes the store, so it can
 * still tell one apart: an install from before the setup existed already has
 * settings or chats on disk, and starts with both marked done. Its tour stays
 * a click away under the sidebar’s ? (help) button.
 *
 * `EAON_ONBOARDING=off` skips both: the end-to-end suite sets it, since
 * every scenario starts from a fresh profile, and a scenario about the setup
 * sets it back to `on`.
 */
export function noteFirstRun(): void {
  if (process.env.EAON_ONBOARDING === 'off') {
    if (store.getSettings().onboarding.setup === 'pending') store.patchSettings({ onboarding: { setup: 'done', tour: 'done', finishedAt: null } })
    return
  }
  if (!existsSync(docPath('settings.json')) && !existsSync(docPath('chats.json'))) return
  if (savedHasOnboarding()) return
  store.patchSettings({ onboarding: { setup: 'done', tour: 'done', finishedAt: null } })
}

/** Whether settings.json already says anything about the setup. A file that can't be read counts as an older install's. */
function savedHasOnboarding(): boolean {
  try {
    const saved = JSON.parse(readFileSync(docPath('settings.json'), 'utf8')) as Record<string, unknown>
    return typeof saved === 'object' && saved !== null && 'onboarding' in saved
  } catch {
    return false
  }
}
