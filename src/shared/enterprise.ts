import type { ApprovalMode } from './types'

/**
 * Enterprise policy and the audit log: the shapes the main process, the
 * Settings page and the tests share. The contract for administrators is
 * docs/enterprise.md; the policy is read by src/main/enterprise/policy.ts.
 */

/** Surfaces an organization can turn off. Anything not named stays as the user has it. */
export const POLICY_FEATURES = [
  /** Phones on the network controlling Workers (Settings → Remote devices). */
  'remoteAccess',
  /** The Local API Server, which also carries the control API Eaon CLI uses. */
  'localApiServer',
  /** The agent operating the mouse, keyboard and screen. */
  'computerUse',
  /** The Trading desk and its broker connections. */
  'trading',
  /** Agent payments with a saved card. */
  'payments',
  /** WhatsApp, Telegram, Discord and other channels that reach an agent. */
  'channels',
  /** The agent's email access. */
  'email',
  /** Browser Use: the agent in the user's own, signed-in browser. */
  'browserUse',
  /** Plugins and MCP servers from the directory. */
  'plugins',
  /** Scheduled tasks that run without anyone watching. */
  'scheduler',
  /** Showing what Eaon is doing as a Discord status. */
  'discordPresence',
  /** Beta update notifications. */
  'betaUpdates',
  /** The "star Eaon on GitHub" prompt. */
  'starPrompt'
] as const

export type PolicyFeature = (typeof POLICY_FEATURES)[number]

export interface EnterprisePolicy {
  /** Shown to the user beside every managed setting. */
  organization?: string
  /** `false` turns a surface off; leaving it out keeps the user's choice. */
  features?: Partial<Record<PolicyFeature, boolean>>
  agent?: {
    /** The most autonomy the agent may be given: `ask` < `auto` < `full`. */
    maxApprovalMode?: ApprovalMode
    /** `false` keeps file tools inside the work folder (Settings → General → Full access). */
    allowFullDiskAccess?: boolean
    /** `false` forbids pre-approving every plugin (MCP) tool call. */
    allowBlanketMcpApproval?: boolean
  }
  providers?: {
    /** Only these provider ids may be used. */
    allow?: string[]
    /** These provider ids may never be used. Wins over `allow`. */
    deny?: string[]
  }
  localApi?: {
    /** Every request to the Local API Server must carry the key. */
    requireKey?: boolean
  }
  mcp?: {
    /** Only these programs may be started as local (stdio) MCP servers. */
    allowCommands?: string[]
  }
  audit?: {
    /** On unless set to false. */
    enabled?: boolean
    /** Where the log is written, for a log shipper (Splunk, Elastic, Datadog) to collect. */
    directory?: string
    /** Days of logs kept on the device. 365 unless set. */
    retentionDays?: number
    /** Record the commands and arguments agents ran, not only which tool and the decision. */
    includeToolInputs?: boolean
  }
}

export interface PolicyStatus {
  /** True when a policy file was found. */
  managed: boolean
  /** The file it came from. */
  source: string | null
  organization: string | null
  /** Fields that were ignored, or why the file couldn't be read. */
  problems: string[]
  /** The file was there but unreadable, so the high-risk surfaces are off. */
  failedClosed: boolean
  policy?: EnterprisePolicy | null
}

export type AuditOutcome = 'success' | 'failure' | 'denied'

export interface AuditRecord {
  /** ISO 8601, UTC. */
  ts: string
  /** Increases by one per record across the whole log, so a removed line shows. */
  seq: number
  event: string
  outcome: AuditOutcome
  actor: { user: string; host: string; via: string }
  app: { version: string; platform: string }
  details?: Record<string, unknown>
  /** The previous record's hash; `0` × 64 for the first. */
  prev: string
  /** SHA-256 of this record without `hash`, chained to `prev`. */
  hash: string
}

export interface AuditStatus {
  enabled: boolean
  directory: string
  retentionDays: number
  /** Set after a verification: whether every record's hash and sequence hold. */
  verified?: { ok: boolean; records: number; files: number; problem?: string }
}
