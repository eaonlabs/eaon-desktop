import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clampApprovalMode,
  clampUnattended,
  enforceSettings,
  featureAllowed,
  mcpCommandAllowed,
  providerAllowed,
  readPolicyFrom,
  resetPolicyForTests,
  sanitizePolicy
} from '../src/main/enterprise/policy'
import { audit, redact, redactString, resetAuditForTests, verifyAuditLog } from '../src/main/enterprise/audit'
import { defaultSettings, store } from '../src/main/store'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'eaon-enterprise-'))

test('no policy file means an unmanaged install with nothing locked', () => {
  const { policy, status } = readPolicyFrom([join(scratch(), 'missing.json')])
  assert.equal(policy, null)
  assert.equal(status.managed, false)
})

test('a policy keeps known fields and reports the rest', () => {
  const problems: string[] = []
  const policy = sanitizePolicy(
    {
      organization: 'Acme',
      features: { trading: false, remoteAccess: false, teleport: false, payments: 'no' },
      agent: { maxApprovalMode: 'auto', allowFullDiskAccess: false, allowBlanketMcpApproval: 'yes' },
      providers: { allow: ['anthropic', ' openai ', 3] },
      audit: { retentionDays: 0 }
    },
    problems
  )
  assert.deepEqual(policy.features, { trading: false, remoteAccess: false })
  assert.equal(policy.agent?.maxApprovalMode, 'auto')
  assert.equal(policy.agent?.allowFullDiskAccess, false)
  assert.equal(policy.agent?.allowBlanketMcpApproval, undefined)
  assert.deepEqual(policy.providers?.allow, ['anthropic', 'openai'])
  assert.equal(problems.length, 4, problems.join('\n'))
})

test('an unreadable policy file fails closed', () => {
  const dir = scratch()
  const file = join(dir, 'policy.json')
  writeFileSync(file, '{ "features": { "trading": false, }')
  const { policy, status } = readPolicyFrom([file])
  assert.equal(status.failedClosed, true)
  assert.equal(policy?.features?.remoteAccess, false)
  assert.equal(policy?.features?.localApiServer, false)
  assert.equal(policy?.agent?.maxApprovalMode, 'ask')
})

test('locked settings hold whatever the settings file or a patch says', () => {
  resetPolicyForTests({
    organization: 'Acme',
    features: { remoteAccess: false, localApiServer: false, computerUse: false, betaUpdates: false },
    agent: { maxApprovalMode: 'auto', allowFullDiskAccess: false, allowBlanketMcpApproval: false }
  })
  try {
    const loose = structuredClone(defaultSettings)
    loose.remote.enabled = true
    loose.localServer.autoStart = true
    loose.computerUse.enabled = true
    loose.updates.beta = true
    loose.approvalMode = 'full'
    loose.general.fullAccess = true
    loose.mcp.allowAllToolPermissions = true
    const enforced = enforceSettings(loose)
    assert.equal(enforced.remote.enabled, false)
    assert.equal(enforced.localServer.autoStart, false)
    assert.equal(enforced.computerUse.enabled, false)
    assert.equal(enforced.updates.beta, false)
    assert.equal(enforced.approvalMode, 'auto')
    assert.equal(enforced.general.fullAccess, false)
    assert.equal(enforced.mcp.allowAllToolPermissions, false)

    // Through the store, as every caller reads settings.
    const patched = store.patchSettings({ approvalMode: 'full', remote: { ...defaultSettings.remote, enabled: true } })
    assert.equal(patched.approvalMode, 'auto')
    assert.equal(patched.remote.enabled, false)
    assert.equal(store.getSettings().remote.enabled, false)
  } finally {
    resetPolicyForTests(null)
  }
})

test('approval limits, unattended runs, providers and MCP commands', () => {
  resetPolicyForTests({
    features: { trading: false },
    agent: { maxApprovalMode: 'ask' },
    providers: { allow: ['anthropic', 'openai'], deny: ['openai'] },
    mcp: { allowCommands: ['npx', '/opt/tools/server'] }
  })
  try {
    assert.equal(clampApprovalMode('full'), 'ask')
    assert.equal(clampApprovalMode('ask'), 'ask')
    assert.equal(clampUnattended('autonomous'), 'safe')
    assert.equal(clampUnattended('read-only'), 'read-only')
    assert.equal(featureAllowed('trading'), false)
    assert.equal(featureAllowed('payments'), true)
    assert.equal(providerAllowed('anthropic'), true)
    assert.equal(providerAllowed('openai'), false, 'deny wins over allow')
    assert.equal(providerAllowed('groq'), false)
    assert.equal(mcpCommandAllowed('npx'), true)
    assert.equal(mcpCommandAllowed('/usr/local/bin/npx'), true)
    assert.equal(mcpCommandAllowed('C:\\Program Files\\nodejs\\npx.cmd'), true)
    assert.equal(mcpCommandAllowed('/opt/tools/server'), true)
    assert.equal(mcpCommandAllowed('bash'), false)
  } finally {
    resetPolicyForTests(null)
  }
  assert.equal(clampApprovalMode('full'), 'full', 'unmanaged installs are unrestricted')
  assert.equal(providerAllowed('groq'), true)
})

test('credentials are redacted by field name and by shape', () => {
  const clean = redact({
    provider: 'openai',
    apiKey: 'sk-abcdefghijklmnopqrstuvwx',
    nested: { password: 'hunter2', note: 'Bearer abcdefghijklmnop and sk-ant-api03-abcdefghijklmnopqrst' },
    hasKey: true
  }) as Record<string, unknown>
  assert.equal(clean.provider, 'openai')
  assert.equal(clean.apiKey, '[redacted]')
  assert.equal(clean.hasKey, true)
  const nested = clean.nested as Record<string, string>
  assert.equal(nested.password, '[redacted]')
  assert.ok(!nested.note.includes('abcdefghijklmnop'), nested.note)
  assert.equal(redactString('card 4242 4242 4242 4242 ok'), 'card [redacted] ok')
  assert.ok(redactString('x'.repeat(2000)).length < 600)
})

test('the audit log is private, chained and detects tampering', () => {
  const dir = scratch()
  resetPolicyForTests({ audit: { directory: dir } })
  resetAuditForTests()
  try {
    audit('credential.set', { provider: 'anthropic', key: 'sk-secretsecretsecret' })
    audit('settings.changed', { settings: ['remote'] })
    audit('agent.tool', { tool: 'run_command', status: 'denied' }, { via: 'agent', outcome: 'denied' })

    const [file] = readdirSync(dir)
    assert.match(file, /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/)
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600)
    const text = readFileSync(join(dir, file), 'utf8')
    assert.ok(!text.includes('secretsecret'), 'no credential reaches the log')
    const lines = text.trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3])
    assert.equal(lines[1].prev, lines[0].hash)
    assert.equal(lines[2].outcome, 'denied')
    assert.deepEqual(verifyAuditLog(dir), { ok: true, records: 3, files: 1 })

    // The chain continues across a restart.
    resetAuditForTests()
    audit('app.started')
    assert.equal(verifyAuditLog(dir).records, 4)

    const path = join(dir, file)
    const original = readFileSync(path, 'utf8').trim().split('\n')
    const write = (rows: string[]): void => writeFileSync(path, rows.join('\n') + '\n')

    // An edited record.
    const edited = JSON.parse(original[2])
    edited.outcome = 'success'
    write([original[0], original[1], JSON.stringify(edited), original[3]])
    assert.match(verifyAuditLog(dir).problem ?? '', /line 3 was changed/)

    // A deleted record.
    write([original[0], original[2], original[3]])
    assert.match(verifyAuditLog(dir).problem ?? '', /missing or out of order/)

    // A forged record appended by hand, without the chain.
    write([...original, JSON.stringify({ ...JSON.parse(original[3]), seq: 5, event: 'forged' })])
    assert.equal(verifyAuditLog(dir).ok, false)

    // Put back, it verifies again.
    write(original)
    assert.equal(verifyAuditLog(dir).ok, true)
  } finally {
    resetPolicyForTests(null)
    resetAuditForTests()
  }
})

test('the audit log can be turned off by policy', () => {
  const dir = scratch()
  resetPolicyForTests({ audit: { enabled: false, directory: dir } })
  resetAuditForTests()
  try {
    audit('app.started')
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    resetPolicyForTests(null)
    resetAuditForTests()
  }
})
