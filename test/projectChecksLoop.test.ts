import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import type { StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * Type and lint errors fed back to the agent, end to end through the loop: the
 * model edits a file, the project's check fails, and the model's next request
 * carries what the check printed; once it is fixed, the loop says the checks pass.
 */

const request = (cwd: string): StreamRequest =>
  ({ chatId: 'checks-e2e', messageId: `m${Math.random()}`, providerId: 'fake', modelId: 'fake-model', effort: 'medium', mode: 'work', history: [], summary: null, projectInstructions: '', cwd, work: { swarm: false, plan: false }, goal: null }) as StreamRequest

const call = (name: string, args: Record<string, unknown>, id: string): string[] => [chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')]
const say = (text: string): string[] => [chunk({ content: text }, 'stop')]

type Body = { messages: { role: string; content?: unknown }[] }
const lastToolText = (body: Body): string => {
  const tools = body.messages.filter((m) => m.role === 'tool')
  return String(tools[tools.length - 1]?.content ?? '')
}

test('a failing check after an edit is in the model’s next request; once fixed, it is told the checks pass', { timeout: 30_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-checks-'))
  writeFileSync(join(cwd, 'state.txt'), 'broken')
  const command = `node -e "if(require('fs').readFileSync('state.txt','utf8')==='broken'){console.error('src/a.ts(2,5): error TS2304: Cannot find name foo');process.exit(2)}"`
  store.patchSettings({ approvalMode: 'full', general: { checks: { enabled: true, command } } } as never)
  let round = 0
  const { url, server, requests } = await sseServer((raw) => {
    const body = raw as unknown as Body
    round++
    if (round === 1) return call('write_file', { path: 'a.ts', content: 'foo()' }, 'c1')
    if (round === 2) return call('write_file', { path: 'state.txt', content: 'fixed' }, 'c2')
    if (round === 3) return say('done')
    void body
    return say('done')
  })
  store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
  const events: StreamEvent[] = []
  try {
    await runAgent(request(cwd), (e) => events.push(e), { approver: async () => true })
  } finally {
    server.close()
    store.patchSettings({ approvalMode: 'ask', general: { checks: { enabled: false, command: '' } } } as never)
  }
  const second = requests[1] as unknown as Body
  assert.match(lastToolText(second), /\[Checks: after your edits, `node -e [^`]*` failed \(exit code 2\)\. Fix these before going on\.\]/)
  assert.match(lastToolText(second), /error TS2304: Cannot find name foo/)
  const third = requests[2] as unknown as Body
  assert.match(lastToolText(third), /passes now/)
  assert.ok(events.some((e) => e.type === 'notice' && /checks found problems/i.test(e.text)), 'the person sees it too')
})

test('with checks off, an edit is not followed by a check', { timeout: 30_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-checks-off-'))
  store.patchSettings({ approvalMode: 'full', general: { checks: { enabled: false, command: 'exit 9' } } } as never)
  let round = 0
  const { url, server, requests } = await sseServer(() => (++round === 1 ? call('write_file', { path: 'a.ts', content: 'x' }, 'c1') : say('done')))
  store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
  try {
    await runAgent(request(cwd), () => {}, { approver: async () => true })
  } finally {
    server.close()
    store.patchSettings({ approvalMode: 'ask' } as never)
  }
  assert.doesNotMatch(lastToolText(requests[1] as unknown as Body), /Checks:/)
})
