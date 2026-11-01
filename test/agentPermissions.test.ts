import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { effectivePermission, permissionChoice, permissionEnv, permissionsFor, type PermissionPrefs } from '@shared/agentPermissions'
import { agentCommand, createTerminals, resumeLine } from '../src/main/features/terminals'
import { AGENT_KINDS } from '../src/main/features/terminals/agentSessions'
import { store } from '../src/main/store'

/**
 * Settings → Agent providers' permissions: what each ADE agent may do
 * without asking, as the flags its command starts with.
 */

const prefs = (permissions: PermissionPrefs['permissions'], agentPermissions: PermissionPrefs['agentPermissions'] = {}): PermissionPrefs => ({ permissions, agentPermissions })

test('out of the box: Claude Code on full access, as the ADE always ran it, and the rest on their own settings', () => {
  const defaults = store.getSettings().agentProviders
  assert.equal(agentCommand('claude', 'claude', defaults), 'claude --dangerously-skip-permissions')
  for (const id of ['codex', 'gemini', 'copilot', 'opencode'] as const) assert.equal(agentCommand(id, id, defaults), id, id)
  assert.deepEqual(permissionEnv('goose', effectivePermission('goose', defaults)), {})
})

test('"All agents" reaches every agent on "Same as all agents", with each CLI’s own switch', () => {
  const full = prefs('full')
  assert.equal(agentCommand('claude', 'claude', full), 'claude --dangerously-skip-permissions')
  assert.equal(agentCommand('codex', 'codex', full), 'codex --dangerously-bypass-approvals-and-sandbox')
  assert.equal(agentCommand('gemini', 'gemini', full), 'gemini --approval-mode yolo')
  assert.equal(agentCommand('copilot', '/opt/bin/copilot', full), '/opt/bin/copilot --yolo')
  assert.equal(agentCommand('opencode', 'opencode', full), 'opencode', 'no switch for it: its own settings')
  assert.deepEqual(permissionEnv('goose', 'full'), { GOOSE_MODE: 'auto' })

  const edits = prefs('edits')
  assert.equal(agentCommand('claude', 'claude', edits), 'claude --permission-mode acceptEdits')
  assert.equal(agentCommand('codex', 'codex', edits), 'codex --sandbox workspace-write --ask-for-approval on-request')
  assert.equal(agentCommand('qwen', 'qwen', edits), 'qwen --approval-mode auto-edit')
  assert.equal(agentCommand('copilot', 'copilot', edits), 'copilot', 'Copilot has nothing between asking and full access')

  const auto = prefs('auto')
  assert.equal(agentCommand('claude', 'claude', auto), 'claude --permission-mode auto')
  assert.equal(agentCommand('codex', 'codex', auto), 'codex --approve-for-me')
  assert.equal(agentCommand('cursor', 'cursor-agent', auto), 'cursor-agent --auto-review')
  assert.equal(agentCommand('gemini', 'gemini', auto), 'gemini', 'Gemini CLI has no reviewer')
  assert.equal(agentCommand('claude', 'claude', prefs('ask')), 'claude --permission-mode default')
})

test('a row’s own choice wins over "All agents", and anything unknown falls back rather than starting a broken command', () => {
  const mixed = prefs('full', { codex: 'ask', claude: 'own', gemini: 'all' })
  assert.equal(agentCommand('codex', 'codex', mixed), 'codex --sandbox read-only --ask-for-approval on-request')
  assert.equal(agentCommand('claude', 'claude', mixed), 'claude', 'its own settings: no flag at all')
  assert.equal(agentCommand('gemini', 'gemini', mixed), 'gemini --approval-mode yolo')
  assert.equal(permissionChoice('codex', prefs('own', { codex: 'everything' as never })), 'all')
  assert.equal(effectivePermission('codex', { permissions: 'reckless' as never }), 'own')
  assert.equal(effectivePermission('claude', undefined), 'own')
  assert.equal(agentCommand('copilot', 'copilot', prefs('own', { copilot: 'edits' })), 'copilot', 'a choice its CLI has no switch for')
  assert.deepEqual(permissionsFor('claude'), ['own', 'ask', 'edits', 'auto', 'full'])
  assert.deepEqual(permissionsFor('copilot'), ['own', 'full'])
  assert.deepEqual(permissionsFor('opencode'), ['own'], 'no picker for it')
  assert.deepEqual(permissionsFor('shell'), ['own'])
})

test('a resume or a continue keeps the flags, and the flags go before a subcommand', () => {
  const id = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b'
  const codex = agentCommand('codex', 'codex', prefs('ask'))
  assert.equal(AGENT_KINDS.codex.resume(codex, id), `codex --sandbox read-only --ask-for-approval on-request resume ${id}`)
  assert.equal(AGENT_KINDS.codex.continueLatest(codex), 'codex --sandbox read-only --ask-for-approval on-request resume --last')
  const claude = agentCommand('claude', 'claude', prefs('own', { claude: 'edits' }))
  const req = { paneId: 'p', cwd: '/p', cols: 80, rows: 24, agent: 'claude' as const, command: claude }
  assert.equal(resumeLine({ ...req, resume: id }).command, `claude --permission-mode acceptEdits --resume ${id}`)
})

test('saved in settings, a choice reaches the agent list panes start from; a bad one is put back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-permissions-'))
  try {
    const terminals = createTerminals({ dir })
    const commandOf = async (id: string): Promise<string | null | undefined> => (await terminals.control.agents()).find((a) => a.id === id)?.command
    assert.equal(await commandOf('claude'), 'claude --dangerously-skip-permissions')

    store.patchSettings({ agentProviders: { permissions: 'edits', agentPermissions: { claude: 'all' } } } as never)
    assert.equal(await commandOf('claude'), 'claude --permission-mode acceptEdits')
    assert.equal(await commandOf('codex'), 'codex --sandbox workspace-write --ask-for-approval on-request')

    const repaired = store.patchSettings({ agentProviders: { permissions: 'yolo' } } as never)
    assert.equal(repaired.agentProviders.permissions, 'own', 'an unknown choice is put back to the default')
    assert.equal(await commandOf('codex'), 'codex')
    assert.equal(repaired.agentProviders.hidden.length, 0, 'the rest of the section is left alone')
  } finally {
    store.patchSettings({ agentProviders: { permissions: 'own', agentPermissions: { claude: 'full' } } } as never)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
