import { app } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type { AuditOutcome, AuditRecord, AuditStatus } from '@shared/enterprise'
import { getPolicy } from './policy'

/**
 * The audit log: who did what security-relevant thing, when, and whether it
 * was allowed (docs/enterprise.md lists the events).
 *
 * One JSON object per line, a file per day, in `<userData>/audit` unless the
 * policy names a directory for a log shipper to collect. Only the user can
 * read it (0600). Each record carries the SHA-256 of the one before it and a
 * sequence number, so deleting, reordering or editing a line breaks the chain
 * and `verifyAuditLog` says where.
 *
 * What it never holds: keys, tokens, passwords, message text. Details are
 * redacted by field name and by shape before they are written, and agent tool
 * inputs are left out unless the policy asks for them.
 */

const GENESIS = '0'.repeat(64)
const DEFAULT_RETENTION_DAYS = 365
const MAX_STRING = 500
const FILE_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/

let head: { seq: number; hash: string } | null = null
let pruned = false
/** Disabled after a write fails, so a read-only disk can't fill the console. Reset on the next day's file. */
let failedFile: string | null = null

export function auditDirectory(): string {
  return getPolicy()?.audit?.directory ?? join(app.getPath('userData'), 'audit')
}

export function auditEnabled(): boolean {
  return getPolicy()?.audit?.enabled !== false
}

export function auditIncludesToolInputs(): boolean {
  return getPolicy()?.audit?.includeToolInputs === true
}

function retentionDays(): number {
  return getPolicy()?.audit?.retentionDays ?? DEFAULT_RETENTION_DAYS
}

export function auditStatus(): AuditStatus {
  return { enabled: auditEnabled(), directory: auditDirectory(), retentionDays: retentionDays() }
}

const SECRET_FIELD = /(key|token|secret|password|passwd|passphrase|authorization|cookie|credential|card|cvv|cvc|iban|ssn|otp|pin)$/i
/** Shapes of credentials, wherever they turn up in a string. */
const SECRET_SHAPES: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
  /\beaonr?-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // A long run of digits that could be a card number.
  /\b\d(?:[ -]?\d){12,18}\b/g
]

/** A string with every credential-shaped run replaced; for logs that keep whole stack traces. */
export function scrubSecrets(text: string): string {
  let out = text
  for (const shape of SECRET_SHAPES) out = out.replace(shape, '[redacted]')
  // OAuth codes and tokens ride in query strings.
  return out.replace(/([?&#](code|token|access_token|refresh_token|id_token|key|api_key|apikey|secret|password|state)=)[^&#\s"']+/gi, '$1[redacted]')
}

/** A string with every credential-shaped run replaced, and capped. */
export function redactString(text: string): string {
  const out = scrubSecrets(text)
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out
}

/** A copy of `value` safe to write to the log. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactString(value)
  if (depth > 4) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[key] = SECRET_FIELD.test(key) && item !== null && item !== undefined && typeof item !== 'boolean' ? '[redacted]' : redact(item, depth + 1)
    }
    return out
  }
  return String(value)
}

export function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

function logFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => FILE_PATTERN.test(name))
      .sort()
  } catch {
    return []
  }
}

/** The chain's last link, read back from the newest file once per run. */
function chainHead(dir: string): { seq: number; hash: string } {
  if (head) return head
  head = { seq: 0, hash: GENESIS }
  const files = logFiles(dir)
  for (let i = files.length - 1; i >= 0; i--) {
    const lines = readFileSync(join(dir, files[i]), 'utf8').split('\n').filter(Boolean)
    for (let j = lines.length - 1; j >= 0; j--) {
      try {
        const last = JSON.parse(lines[j]) as AuditRecord
        if (typeof last.seq === 'number' && typeof last.hash === 'string') {
          head = { seq: last.seq, hash: last.hash }
          return head
        }
      } catch {
        // A torn last line (power loss mid-write); the one before it is the head.
      }
    }
  }
  return head
}

function prune(dir: string): void {
  if (pruned) return
  pruned = true
  const cutoff = Date.now() - retentionDays() * 86_400_000
  for (const name of logFiles(dir)) {
    const day = Date.parse(`${FILE_PATTERN.exec(name)![1]}T00:00:00Z`)
    if (Number.isFinite(day) && day < cutoff) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        // Kept until the next launch.
      }
    }
  }
}

function actor(via: string): AuditRecord['actor'] {
  let user = ''
  try {
    user = userInfo().username
  } catch {
    user = process.env['USER'] ?? process.env['USERNAME'] ?? ''
  }
  return { user, host: hostname(), via }
}

export interface AuditOptions {
  outcome?: AuditOutcome
  /** What made the request: `ui` (the default), `agent`, `control-api`, `remote`, `scheduler`, `system`. */
  via?: string
}

/**
 * Appends one record. Never throws: an audit failure is reported on the
 * console and in the crash log, and never stops what was being audited.
 */
export function audit(event: string, details?: Record<string, unknown>, options: AuditOptions = {}): void {
  if (!auditEnabled()) return
  const dir = auditDirectory()
  const file = join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`)
  if (failedFile === file) return
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    prune(dir)
    const previous = chainHead(dir)
    const record: Omit<AuditRecord, 'hash'> = {
      ts: new Date().toISOString(),
      seq: previous.seq + 1,
      event,
      outcome: options.outcome ?? 'success',
      actor: actor(options.via ?? 'ui'),
      app: { version: app.getVersion(), platform: process.platform },
      ...(details ? { details: redact(details) as Record<string, unknown> } : {}),
      prev: previous.hash
    }
    const hash = hashRecord(record)
    const isNew = !existsSync(file)
    appendFileSync(file, `${JSON.stringify({ ...record, hash })}\n`, { mode: 0o600 })
    if (isNew && process.platform !== 'win32') chmodSync(file, 0o600)
    head = { seq: record.seq, hash }
  } catch (error) {
    failedFile = file
    console.error(`[audit] could not write to ${file}:`, error instanceof Error ? error.message : error)
  }
}

/**
 * Checks every record in `dir`: each hash matches its contents, each `prev`
 * is the hash before it and sequence numbers have no gaps. Files removed by
 * retention are expected; the chain is checked from the oldest file kept.
 */
export function verifyAuditLog(dir = auditDirectory()): NonNullable<AuditStatus['verified']> {
  const files = logFiles(dir)
  let records = 0
  let previous: { seq: number; hash: string } | null = null
  for (const name of files) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue
      const where = `${name} line ${i + 1}`
      let record: AuditRecord
      try {
        record = JSON.parse(lines[i]) as AuditRecord
      } catch {
        return { ok: false, records, files: files.length, problem: `${where} is not valid JSON` }
      }
      const { hash, ...rest } = record
      if (hashRecord(rest) !== hash) return { ok: false, records, files: files.length, problem: `${where} was changed after it was written` }
      if (previous && (record.prev !== previous.hash || record.seq !== previous.seq + 1)) {
        return { ok: false, records, files: files.length, problem: `a record is missing or out of order before ${where}` }
      }
      if (!previous && files.indexOf(name) === 0 && record.seq === 1 && record.prev !== GENESIS) {
        return { ok: false, records, files: files.length, problem: `${where} does not start the chain` }
      }
      previous = { seq: record.seq, hash }
      records++
    }
  }
  return { ok: true, records, files: files.length }
}

/** Forgets the chain head and retention pass. Tests only. */
export function resetAuditForTests(): void {
  head = null
  pruned = false
  failedFile = null
}
