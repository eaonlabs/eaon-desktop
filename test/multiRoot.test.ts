import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import '../src/main/agent/sources'
import { resolveWorkPath, setWorkspaceRoots, workspaceRoots } from '../src/main/localTools'
import { callFacts, decide } from '../src/main/agent/policy'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { workSystemPrompt } from '../src/main/agent/prompts'
import { defaultSettings } from '../src/main/store'
import type { Settings, StreamRequest } from '../src/shared/types'

/**
 * Multi-root workspaces: a project's other folders count as part of the work
 * folder, so the agent reads and changes them without asking, while a folder
 * that isn't one of them still asks, and the credential folders stay shut.
 */

let main = ''
let api = ''
let other = ''
before(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roots-')))
  main = path.join(base, 'web')
  api = path.join(base, 'api')
  other = path.join(base, 'elsewhere')
  for (const d of [main, api, other]) fs.mkdirSync(d)
  fs.writeFileSync(path.join(api, 'server.ts'), 'export {}\n')
})
after(() => {
  setWorkspaceRoots(main, [])
  fs.rmSync(path.dirname(main), { recursive: true, force: true })
})

const request = (extraRoots?: string[]): StreamRequest =>
  ({ chatId: 'mr', messageId: 'm', providerId: 'x', modelId: 'x', effort: 'medium', mode: 'work', history: [], summary: null, projectInstructions: '', cwd: main, work: { swarm: false, plan: false }, goal: null, extraRoots }) as unknown as StreamRequest

const settings: Settings = { ...defaultSettings, approvalMode: 'ask' }
const ctx = (req: StreamRequest): ToolContext => ({ request: req, turn: { notes: [] }, cwd: main, signal: new AbortController().signal, emit: () => {}, toolId: 't', depth: 0, readOnly: false, settings, progress: () => {}, confirm: async () => false, policy: { readOnly: false } }) as unknown as ToolContext

test('the other folders are kept as given: absolute, existing, not the main one, no repeats', () => {
  setWorkspaceRoots(main, [api, api, main, '/definitely/not/here', 'relative/dir', 7 as never])
  assert.deepEqual(workspaceRoots(main), [api])
  setWorkspaceRoots(main, undefined)
  assert.deepEqual(workspaceRoots(main), [])
})

test('a path in another folder is inside the workspace only once the project has that folder', () => {
  setWorkspaceRoots(main, [])
  assert.equal(resolveWorkPath(main, path.join(api, 'server.ts')).inside, false)
  setWorkspaceRoots(main, [api])
  assert.equal(resolveWorkPath(main, path.join(api, 'server.ts')).inside, true)
  assert.equal(resolveWorkPath(main, path.join(other, 'x.ts')).inside, false, 'a folder that is not in the list is still outside')
  assert.equal(resolveWorkPath(main, 'src/a.ts').inside, true)
  setWorkspaceRoots(main, [])
})

test('a folder outside the home folder can be one of the workspace’s, and without that it is refused', () => {
  setWorkspaceRoots(main, [])
  assert.throws(() => resolveWorkPath(main, '/etc/hosts'), /outside your home folder/)
  setWorkspaceRoots(main, ['/etc'])
  assert.equal(resolveWorkPath(main, '/etc/hosts').inside, true)
  setWorkspaceRoots(main, [])
})

test('the credential folders stay shut even if a workspace folder is the home folder', () => {
  setWorkspaceRoots(main, [os.homedir()])
  try {
    assert.throws(() => resolveWorkPath(main, path.join(os.homedir(), '.ssh', 'id_rsa')), /holds credentials/)
  } finally {
    setWorkspaceRoots(main, [])
  }
})

test('writing in another of the project’s folders runs without asking; writing in one that isn’t asks', async () => {
  const req = request([api])
  const tool = toolsFor({ mode: 'work', cwd: main, depth: 0, readOnly: false, settings, request: req }).find((t) => t.name === 'write_file')!
  assert.deepEqual(workspaceRoots(main), [api], 'building the turn’s tools sets the folders')
  const verdict = async (file: string): Promise<string> => {
    const input = { path: file, content: 'x' }
    const facts = await callFacts(tool, input, ctx(req), settings)
    return decide(tool, input, { ...facts, risky: facts.risky }, { readOnly: false }, 'auto').kind
  }
  assert.equal(await verdict(path.join(api, 'new.ts')), 'run')
  assert.equal(await verdict(path.join(main, 'new.ts')), 'run')
  assert.equal(await verdict(path.join(other, 'new.ts')), 'ask')
  // The next turn of a project without the folder forgets it.
  toolsFor({ mode: 'work', cwd: main, depth: 0, readOnly: false, settings, request: request() })
  assert.deepEqual(workspaceRoots(main), [])
  const tool2 = toolsFor({ mode: 'work', cwd: main, depth: 0, readOnly: false, settings, request: request() }).find((t) => t.name === 'write_file')!
  const facts = await callFacts(tool2, { path: path.join(api, 'new.ts'), content: 'x' }, ctx(request()), settings)
  assert.equal(decide(tool2, { path: path.join(api, 'new.ts'), content: 'x' }, facts, { readOnly: false }, 'auto').kind, 'ask')
})

test('the agent is told about the other folders', () => {
  const prompt = workSystemPrompt({ cwd: main, projectInstructions: '', guidance: [], swarm: false, plan: false, goal: null, extraRoots: [api, other] })
  assert.match(prompt, new RegExp(`more folders you work in just as freely \\(use their full paths\\): ${api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, `))
  assert.doesNotMatch(workSystemPrompt({ cwd: main, projectInstructions: '', guidance: [], swarm: false, plan: false, goal: null }), /more folders/)
})
