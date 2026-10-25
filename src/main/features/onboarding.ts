import { existsSync, readFileSync } from 'node:fs'
import { WHATS_NEW_RELEASE } from '@shared/whatsNew'
import type { Settings } from '@shared/types'
import { store } from '../store'
import { docPath } from '../storeFiles'

/**
 * The first-run setup and the tours (components/onboarding). This runs at
 * startup before anything writes the store, so it can still tell installs
 * apart by what's on disk:
 *
 * - A fresh install has no settings or chats. It gets the setup and the tour
 *   of the app, and nothing is "new" to it.
 * - An install updated from before 2026.7 never went through the setup (it
 *   didn't exist, or an earlier 2026.7 marked it done without showing it).
 *   It gets the setup now, to sign in with Tokn, connect models and pick a
 *   look, and then the tour of what's new.
 * - One that went through the setup in a 2026.7 beta gets only the tour of
 *   what's new.
 *
 * `EAON_ONBOARDING=off` skips all of it: the end-to-end suite sets it, since
 * every scenario starts from a fresh profile, and a scenario about the setup
 * sets it back to `on`.
 */
export function noteFirstRun(): void {
  const current = store.getSettings().onboarding
  if (process.env.EAON_ONBOARDING === 'off') {
    if (current.setup === 'pending') store.patchSettings({ onboarding: { setup: 'done', tour: 'done', finishedAt: null, whatsNew: WHATS_NEW_RELEASE } })
    else if (current.whatsNew !== WHATS_NEW_RELEASE) store.patchSettings({ onboarding: { ...current, whatsNew: WHATS_NEW_RELEASE } })
    return
  }
  if (!existsSync(docPath('settings.json')) && !existsSync(docPath('chats.json'))) {
    store.patchSettings({ onboarding: { ...current, whatsNew: WHATS_NEW_RELEASE } })
    return
  }
  const saved = savedOnboarding()
  if (saved && 'whatsNew' in saved) {
    // Seen by a build that knows about the what's-new tour: due again only for a later release's.
    if (saved.whatsNew !== null && saved.whatsNew !== WHATS_NEW_RELEASE) store.patchSettings({ onboarding: { ...current, whatsNew: null } })
    return
  }
  const setUp = typeof saved?.finishedAt === 'number'
  store.patchSettings({ onboarding: setUp ? { ...current, whatsNew: null } : { setup: 'pending', tour: 'done', finishedAt: null, whatsNew: null } })
}

/** The setup's state as settings.json has it, or null if it says nothing about it. A file that can't be read counts as an older install's. */
function savedOnboarding(): Partial<Settings['onboarding']> | null {
  try {
    const saved = JSON.parse(readFileSync(docPath('settings.json'), 'utf8')) as Record<string, unknown>
    const onboarding = typeof saved === 'object' && saved !== null ? saved.onboarding : null
    return typeof onboarding === 'object' && onboarding !== null ? (onboarding as Partial<Settings['onboarding']>) : null
  } catch {
    return null
  }
}
