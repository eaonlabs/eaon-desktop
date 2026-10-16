import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalMode, Settings } from '@shared/types'
import type { EnterprisePolicy, PolicyFeature, PolicyStatus } from '@shared/enterprise'
import { POLICY_FEATURES } from '@shared/enterprise'

/**
 * Enterprise policy: settings an organization's IT deploys to every Mac, PC
 * or Linux box, which the user can see but not change (docs/enterprise.md).
 *
 * The policy lives where only an administrator can write it, so a managed
 * device's user can't loosen it:
 *
 *   macOS    /Library/Managed Preferences/dev.eaon.desktop.plist   (an MDM configuration profile)
 *            /Library/Application Support/Eaon/policy.json
 *   Windows  %ProgramData%\Eaon\policy.json
 *   Linux    /etc/eaon/policy.json
 *
 * It is read once at launch; changing it takes a restart, as with every other
 * managed-preferences system. With no policy file Eaon behaves exactly as it
 * always has. A file that is there but can't be parsed fails closed: the
 * high-risk surfaces are switched off until IT fixes it, rather than a typo
 * silently lifting every restriction.
 */

/** Where an administrator may put the policy, most specific first. */
export function policyLocations(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') {
    return ['/Library/Managed Preferences/dev.eaon.desktop.plist', '/Library/Application Support/Eaon/policy.json']
  }
  if (platform === 'win32') {
    const programData = process.env['ProgramData'] || 'C:\\ProgramData'
    return [join(programData, 'Eaon', 'policy.json')]
  }
  return ['/etc/eaon/policy.json']
}

/** What applies when a policy file exists but can't be read: the risky surfaces off, approvals on. */
const FAIL_CLOSED: EnterprisePolicy = {
  features: {
    remoteAccess: false,
    localApiServer: false,
    computerUse: false,
    trading: false,
    payments: false,
    channels: false,
    browserUse: false,
    discordPresence: false,
    betaUpdates: false
  },
  agent: { maxApprovalMode: 'ask', allowFullDiskAccess: false, allowBlanketMcpApproval: false }
}

const APPROVAL_ORDER: ApprovalMode[] = ['ask', 'auto', 'full']

let loaded: { policy: EnterprisePolicy | null; status: PolicyStatus } | null = null

function readPlist(path: string): unknown {
  // plutil ships with every macOS and converts a configuration profile's
  // binary or XML plist without a parsing dependency.
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8', timeout: 5000 }))
}

/**
 * True when someone other than an administrator could rewrite the file.
 * It is still enforced (the user could only make it stricter or looser by
 * hand anyway), but the audit log and Settings say so, because a policy a
 * user can edit is not a control.
 */
function writableByNonAdmins(path: string): boolean {
  if (process.platform === 'win32') return false
  try {
    const stat = statSync(path)
    return stat.uid !== 0 || (stat.mode & 0o022) !== 0
  } catch {
    return false
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : undefined

/**
 * Keeps only the fields Eaon understands, with the types it expects. An
 * unknown or mistyped field is dropped and reported, never guessed at.
 */
export function sanitizePolicy(raw: unknown, problems: string[] = []): EnterprisePolicy {
  if (!isRecord(raw)) throw new Error('the policy must be a JSON object')
  const policy: EnterprisePolicy = {}
  if (typeof raw['organization'] === 'string') policy.organization = raw['organization'].slice(0, 200)

  if (isRecord(raw['features'])) {
    policy.features = {}
    for (const [key, value] of Object.entries(raw['features'])) {
      if (!(POLICY_FEATURES as readonly string[]).includes(key)) problems.push(`features.${key} is not a known feature`)
      else if (typeof value !== 'boolean') problems.push(`features.${key} must be true or false`)
      else policy.features[key as PolicyFeature] = value
    }
  }

  if (isRecord(raw['agent'])) {
    const agent = raw['agent']
    policy.agent = {}
    if (agent['maxApprovalMode'] !== undefined) {
      if (APPROVAL_ORDER.includes(agent['maxApprovalMode'] as ApprovalMode)) policy.agent.maxApprovalMode = agent['maxApprovalMode'] as ApprovalMode
      else problems.push('agent.maxApprovalMode must be "ask", "auto" or "full"')
    }
    for (const key of ['allowFullDiskAccess', 'allowBlanketMcpApproval'] as const) {
      if (agent[key] === undefined) continue
      if (typeof agent[key] === 'boolean') policy.agent[key] = agent[key] as boolean
      else problems.push(`agent.${key} must be true or false`)
    }
  }

  if (isRecord(raw['providers'])) {
    policy.providers = {}
    const allow = stringList(raw['providers']['allow'])
    const deny = stringList(raw['providers']['deny'])
    if (allow) policy.providers.allow = allow
    if (deny) policy.providers.deny = deny
  }

  if (isRecord(raw['localApi'])) {
    policy.localApi = {}
    if (typeof raw['localApi']['requireKey'] === 'boolean') policy.localApi.requireKey = raw['localApi']['requireKey']
  }

  if (isRecord(raw['mcp'])) {
    policy.mcp = {}
    const allow = stringList(raw['mcp']['allowCommands'])
    if (allow) policy.mcp.allowCommands = allow
  }

  if (isRecord(raw['audit'])) {
    const audit = raw['audit']
    policy.audit = {}
    if (typeof audit['enabled'] === 'boolean') policy.audit.enabled = audit['enabled']
    if (typeof audit['directory'] === 'string' && audit['directory'].trim()) policy.audit.directory = audit['directory'].trim()
    if (typeof audit['includeToolInputs'] === 'boolean') policy.audit.includeToolInputs = audit['includeToolInputs']
    if (audit['retentionDays'] !== undefined) {
      const days = Number(audit['retentionDays'])
      if (Number.isInteger(days) && days >= 1 && days <= 3650) policy.audit.retentionDays = days
      else problems.push('audit.retentionDays must be a whole number of days from 1 to 3650')
    }
  }
  return policy
}

/** Reads the policy from the first location that has one. Only for tests and `load`. */
export function readPolicyFrom(locations: string[]): { policy: EnterprisePolicy | null; status: PolicyStatus } {
  for (const path of locations) {
    try {
      statSync(path)
    } catch {
      continue
    }
    const problems: string[] = []
    try {
      const raw = path.endsWith('.plist') ? readPlist(path) : JSON.parse(readFileSync(path, 'utf8'))
      const policy = sanitizePolicy(raw, problems)
      if (writableByNonAdmins(path)) problems.push(`${path} can be changed by users who are not administrators`)
      return { policy, status: { managed: true, source: path, organization: policy.organization ?? null, problems, failedClosed: false } }
    } catch (error) {
      problems.push(`${path} could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return {
        policy: FAIL_CLOSED,
        status: { managed: true, source: path, organization: null, problems, failedClosed: true }
      }
    }
  }
  return { policy: null, status: { managed: false, source: null, organization: null, problems: [], failedClosed: false } }
}

function load(): { policy: EnterprisePolicy | null; status: PolicyStatus } {
  if (loaded) return loaded
  // A development build may point at a test policy; a packaged one never
  // takes its policy from something the user controls.
  const override = !app.isPackaged ? process.env['EAON_POLICY_FILE'] : undefined
  loaded = readPolicyFrom(override ? [override] : policyLocations())
  for (const problem of loaded.status.problems) console.warn(`[policy] ${problem}`)
  return loaded
}

/** The policy in force, or null on an unmanaged install. */
export function getPolicy(): EnterprisePolicy | null {
  return load().policy
}

export function getPolicyStatus(): PolicyStatus {
  return { ...load().status, policy: load().policy }
}

/** Forgets the policy read at launch. Tests only. */
export function resetPolicyForTests(next?: EnterprisePolicy | null): void {
  loaded =
    next === undefined
      ? null
      : { policy: next, status: { managed: next !== null, source: next ? 'test' : null, organization: next?.organization ?? null, problems: [], failedClosed: false } }
}

/** False only when the policy turns the feature off. */
export function featureAllowed(feature: PolicyFeature): boolean {
  return getPolicy()?.features?.[feature] !== false
}

/** The error a caller gets for something the policy forbids. */
export class PolicyError extends Error {
  constructor(what: string) {
    const org = getPolicy()?.organization
    super(`${what} is turned off by ${org ? `${org}’s` : 'your organization’s'} policy.`)
    this.name = 'PolicyError'
  }
}

export function assertFeature(feature: PolicyFeature, what: string): void {
  if (!featureAllowed(feature)) throw new PolicyError(what)
}

/** The most autonomy the policy permits, applied to what the user chose. */
export function clampApprovalMode(mode: ApprovalMode): ApprovalMode {
  const max = getPolicy()?.agent?.maxApprovalMode
  if (!max) return mode
  return APPROVAL_ORDER.indexOf(mode) > APPROVAL_ORDER.indexOf(max) ? max : mode
}

/**
 * The same limit for agents nobody is watching (Workers, trading sessions):
 * below `full`, an autonomous run is held to `safe`, where anything risky
 * needs a person's explicit approval.
 */
export function clampUnattended<T extends string>(policy: T): T | 'safe' {
  const max = getPolicy()?.agent?.maxApprovalMode
  return policy === 'autonomous' && max && max !== 'full' ? 'safe' : policy
}

/** Whether the policy lets a provider be used. Deny wins over allow. */
export function providerAllowed(providerId: string): boolean {
  const providers = getPolicy()?.providers
  if (!providers) return true
  if (providers.deny?.includes(providerId)) return false
  return !providers.allow || providers.allow.includes(providerId)
}

/**
 * Whether a stdio MCP server's command may be started. With an allow-list,
 * only the named programs (by base name, `npx`, or by full path) run.
 */
export function mcpCommandAllowed(command: string): boolean {
  const allow = getPolicy()?.mcp?.allowCommands
  if (!allow) return true
  const trimmed = command.trim()
  const base = trimmed.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/i, '') ?? trimmed
  return allow.includes(trimmed) || allow.includes(base)
}

/**
 * Settings as the policy allows them. Every reader of settings goes through
 * `store.getSettings`, which calls this, so a locked setting holds everywhere
 * at once rather than at each place that happens to check.
 */
export function enforceSettings(settings: Settings): Settings {
  const policy = getPolicy()
  if (!policy) return settings
  const out: Settings = { ...settings }
  const off = (feature: PolicyFeature): boolean => policy.features?.[feature] === false

  if (off('remoteAccess') && out.remote.enabled) out.remote = { ...out.remote, enabled: false }
  if (off('localApiServer') && out.localServer.autoStart) out.localServer = { ...out.localServer, autoStart: false }
  if (policy.localApi?.requireKey && !out.localServer.requireKey) out.localServer = { ...out.localServer, requireKey: true }
  if (off('computerUse') && out.computerUse.enabled) out.computerUse = { ...out.computerUse, enabled: false }
  if (off('browserUse') && out.browserUse.enabled) out.browserUse = { ...out.browserUse, enabled: false }
  if (off('discordPresence') && out.discord.enabled) out.discord = { ...out.discord, enabled: false }
  if (off('betaUpdates') && out.updates.beta) out.updates = { ...out.updates, beta: false }
  if (off('starPrompt') && out.starPrompt.status === 'pending') out.starPrompt = { ...out.starPrompt, status: 'declined' }

  out.approvalMode = clampApprovalMode(out.approvalMode)
  if (policy.agent?.maxApprovalMode && policy.agent.maxApprovalMode !== 'full' && out.remote.allowAutonomous) {
    out.remote = { ...out.remote, allowAutonomous: false }
  }
  if (policy.agent?.allowFullDiskAccess === false && out.general.fullAccess) out.general = { ...out.general, fullAccess: false }
  if (policy.agent?.allowBlanketMcpApproval === false && out.mcp.allowAllToolPermissions) {
    out.mcp = { ...out.mcp, allowAllToolPermissions: false }
  }
  // The policy's computer-use confirmation can't be turned off by the user either.
  if (policy.agent?.maxApprovalMode === 'ask' && !out.computerUse.confirmEachAction) {
    out.computerUse = { ...out.computerUse, confirmEachAction: true }
  }
  return out
}
