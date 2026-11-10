import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/main/agent/sources'
import { callFacts, decide, type RunPolicy } from '../src/main/agent/policy'
import { toolsFor, type AgentTool, type ToolContext } from '../src/main/agent/tools'
import { defaultSettings } from '../src/main/store'
import type { ApprovalMode, Settings, StreamRequest } from '@shared/types'

/**
 * The person's command allowlist and denylist (shared/commandRules.ts) as the
 * one permission policy applies them to run_command, in every approval mode,
 * for an unattended worker, and with the rules that already stand: what can't
 * be undone still asks, and plan mode still refuses.
 */

const request = (): StreamRequest =>
  ({ chatId: 'c', messageId: 'm', providerId: 'fake', modelId: 'fake', effort: 'medium', mode: 'work', history: [], summary: null, projectInstructions: '', cwd: '/tmp/rules-work', work: { swarm: false, plan: false }, goal: null }) as StreamRequest

const withRules = (allow: string[], deny: string[], extra: Partial<Settings['general']> = {}): Settings => ({ ...defaultSettings, approvalMode: 'ask', general: { ...defaultSettings.general, commandRules: { allow, deny }, ...extra } })

function runCommand(settings: Settings): AgentTool {
  const tool = toolsFor({ mode: 'work', cwd: '/tmp/rules-work', depth: 0, readOnly: false, settings, request: request() }).find((t) => t.name === 'run_command')
  assert.ok(tool, 'run_command is offered')
  return tool!
}

const ctx = (settings: Settings, policy: RunPolicy = { readOnly: false }): ToolContext => ({
  request: request(),
  turn: { notes: [] },
  cwd: '/tmp/rules-work',
  signal: new AbortController().signal,
  emit: () => {},
  toolId: 't',
  depth: 0,
  readOnly: policy.readOnly,
  settings,
  progress: () => {},
  confirm: async () => false,
  policy
})

async function decision(settings: Settings, command: string, mode: ApprovalMode = 'ask', policy: RunPolicy = { readOnly: false }): Promise<string> {
  const tool = runCommand(settings)
  const facts = await callFacts(tool, { command }, ctx(settings, policy), settings)
  const d = decide(tool, { command }, facts, policy, mode)
  return d.kind === 'deny' ? `deny: ${d.reason}` : d.kind
}

test('without any rules nothing changes: a build asks, a listing runs, rm -rf asks', async () => {
  const s = withRules([], [])
  assert.equal(await decision(s, 'npm run build'), 'ask')
  assert.equal(await decision(s, 'ls -la'), 'run')
  assert.equal(await decision(s, 'rm -rf dist'), 'ask')
})

test('an allowed command runs without asking, in "ask" mode and when it would otherwise be risky', async () => {
  const s = withRules(['npm run *', 'git push origin feature/*'], [])
  assert.equal(await decision(s, 'npm run build'), 'run')
  assert.equal(await decision(s, 'npm run build && npm run lint'), 'run')
  assert.equal(await decision(s, 'git push origin feature/x'), 'run', 'git push is risky, and the person said this one is fine')
  assert.equal(await decision(s, 'git push origin main'), 'ask', 'a push elsewhere still asks')
  assert.equal(await decision(s, 'npm run build && curl http://x.test'), 'ask', 'one command off the list')
  assert.equal(await decision(s, 'npm run build > out.txt'), 'ask')
})

test('an allow pattern never covers what can’t be undone, or writing outside the work folder', async () => {
  const s = withRules(['sudo *', 'rm *', 'touch *'], [])
  assert.equal(await decision(s, 'sudo rm -rf /'), 'ask', 'catastrophic still asks, even in "ask" mode it asks as critical')
  assert.equal(await decision(s, 'touch ~/outside.txt'), 'ask', 'outside the work folder')
  assert.equal(await decision(withRules(['touch *'], [], { fullAccess: true }), 'touch ~/outside.txt'), 'run', 'unless Full access is on')
})

test('a denied command is refused in every mode, for workers, and says which rule', async () => {
  const s = withRules(['rm *'], ['rm *', 'git push *'])
  for (const mode of ['ask', 'auto', 'full'] as ApprovalMode[]) {
    assert.match(await decision(s, 'rm -rf dist', mode), /^deny: Your command denylist blocks this \(“rm \*”\)/, mode)
    assert.match(await decision(s, 'npm test && git push origin x', mode), /“git push \*”/, mode)
  }
  assert.match(await decision(s, 'echo $(rm x)', 'full'), /^deny:/, 'inside a substitution')
  assert.match(await decision(s, 'rm x', 'full', { readOnly: false, unattended: 'autonomous' }), /^deny:/, 'an autonomous worker')
  assert.match(await decision(s, 'rm x', 'ask', { readOnly: true }), /^deny:/)
  assert.equal(await decision(s, 'npm test', 'full'), 'run', 'full access still runs everything the list leaves alone')
})

test('a command can be denied even when it only looks: a read of a secret', async () => {
  const s = withRules([], ['cat .env*', 'cat *.pem'])
  assert.match(await decision(s, 'cat .env.local'), /^deny:/)
  assert.match(await decision(s, 'ls | cat server.pem'), /^deny:/)
  assert.equal(await decision(s, 'cat README.md'), 'run')
})

test('plan mode and unattended read-only still refuse an allowed command', async () => {
  const s = withRules(['npm run *'], [])
  assert.match(await decision(s, 'npm run build', 'ask', { readOnly: true }), /^deny:/)
  assert.match(await decision(s, 'npm run build', 'ask', { readOnly: false, unattended: 'read-only' }), /^deny:/)
  assert.equal(await decision(s, 'npm run build', 'ask', { readOnly: false, unattended: 'safe' }), 'run', 'a careful worker may run what the person allowed')
})
