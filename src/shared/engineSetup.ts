import type { EngineStatus } from './engines'
import { engineReadiness, type ProviderState } from './modelSelection'

/**
 * What Settings → Model providers says about an agent engine (Codex): the
 * row's status, the headline in its page, and the one button, decided from
 * the engine's status alone so it can be tested without a window.
 *
 * Rules: an engine that isn't installed is never shown as ready, and offers
 * the install hint rather than a sign-in; installed and signed in reads
 * "Codex · Signed in"; installed but signed out or expired offers sign-in.
 */
export interface EngineEntry {
  installed: boolean
  state: ProviderState
  /** The short status next to the name: "Signed in · Plus", "Not signed in", "Not installed". */
  label: string
  /** The line at the top of its status section. */
  headline: string
  /** Method, plan, version and where it was found. */
  facts: string
  /** One sentence on what to do, when something needs doing. */
  note: string | null
  action: { kind: 'sign-in' | 'reconnect'; label: string } | null
  /** The command that installs it, when it isn't installed. */
  installHint: string | null
}

export function engineEntry(status: EngineStatus): EngineEntry {
  const readiness = engineReadiness(status.id, status)
  const name = status.name
  const facts = [status.auth.method, status.auth.plan, status.version ? `version ${status.version}` : null, status.foundIn].filter(Boolean).join(' · ')
  if (!status.installed) {
    return { installed: false, state: 'unavailable', label: 'Not installed', headline: `${name} isn’t installed`, facts: '', note: `${name} isn’t installed on this computer, so Eaon can’t run on it.`, action: null, installHint: status.updateHint }
  }
  if (status.outdated) {
    return { installed: true, state: 'unavailable', label: 'Update needed', headline: `${name} needs an update`, facts, note: readiness.reason, action: null, installHint: status.updateHint }
  }
  const signedIn = readiness.state === 'ready'
  return {
    installed: true,
    state: readiness.state,
    label: readiness.label,
    headline: signedIn ? `${name} · Signed in` : `${name} · ${readiness.label}`,
    facts,
    note: signedIn ? null : readiness.reason,
    action:
      status.auth.state === 'expired'
        ? { kind: 'reconnect', label: 'Sign in again' }
        : status.auth.state === 'signed-out'
          ? { kind: 'sign-in', label: `Sign in to ${name}` }
          : null,
    installHint: null
  }
}
