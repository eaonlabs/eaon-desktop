import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRcHandler, type RcBrowsers } from '../src/main/features/rc/handler'
import type { AgentBrowserFrame, AgentBrowserStatus, AgentBrowserStep } from '../src/shared/agentBrowser'
import type { TerminalsControl } from '../src/main/features/terminals'

/**
 * Eaon Remote's view of the agents' browsers (rc/handler.ts): the list, a
 * snapshot with the steps so far, pictures sent no faster than the relay
 * should carry them (the newest winning), steps as they happen, and nothing
 * more once the tab stops watching or goes away.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fakeBrowsers() {
  const frameListeners = new Map<string, Set<(f: AgentBrowserFrame) => void>>()
  const stepListeners = new Set<(s: AgentBrowserStep) => void>()
  const steps: AgentBrowserStep[] = [{ target: 'agent', chatId: 'c1', action: 'open', detail: 'example.com', done: true, at: 1 }]
  const status = (target: string): AgentBrowserStatus => ({ target, open: true, url: 'https://example.com/', title: 'Example', controlled: false })
  const browsers: RcBrowsers = {
    list: () => [status('agent'), status('worker:w1')],
    status,
    label: (target) => (target === 'agent' ? 'Eaon’s browser' : 'Ada’s browser'),
    steps: (target) => steps.filter((s) => s.target === target),
    watch: (target, onFrame) => {
      let set = frameListeners.get(target)
      if (!set) frameListeners.set(target, (set = new Set()))
      set.add(onFrame)
      return () => set!.delete(onFrame)
    },
    onStep: (listener) => {
      stepListeners.add(listener)
      return () => stepListeners.delete(listener)
    }
  }
  const frame = (target: string, n: number): AgentBrowserFrame => ({ target, url: 'https://example.com/', title: 'Example', image: `data:image/jpeg;base64,${n}`, viewport: { width: 1100, height: 700 }, at: n })
  return {
    browsers,
    paint: (target: string, n: number) => frameListeners.get(target)?.forEach((l) => l(frame(target, n))),
    step: (s: AgentBrowserStep) => stepListeners.forEach((l) => l(s)),
    watching: (target: string) => frameListeners.get(target)?.size ?? 0
  }
}

const terminals = { layout: () => ({}), tap: () => () => undefined, agents: async () => [] } as unknown as TerminalsControl

test('the web sees each agent’s browser: a snapshot, throttled pictures, steps, and nothing after it stops watching', async () => {
  const fake = fakeBrowsers()
  const sent: Record<string, unknown>[] = []
  const handler = createRcHandler({ terminals, ade: { list: () => [], changes: async () => null }, workers: null, browsers: fake.browsers, send: (m) => sent.push(m) })

  await handler.handle({ t: 'req', from: 'tab1', id: 'r1', method: 'GET', path: '/browsers' })
  const list = sent.find((m) => m.t === 'res') as { body: { browsers: { target: string; label: string; last: AgentBrowserStep | null }[] } }
  assert.deepEqual(
    list.body.browsers.map((b) => [b.target, b.label, b.last?.action ?? null]),
    [
      ['agent', 'Eaon’s browser', 'open'],
      ['worker:w1', 'Ada’s browser', null]
    ]
  )

  // Only a browser's own name: no path tricks.
  await handler.handle({ t: 'bsub', from: 'tab1', target: '../etc' })
  assert.equal(fake.watching('../etc'), 0)

  sent.length = 0
  await handler.handle({ t: 'bsub', from: 'tab1', target: 'agent' })
  const snap = sent.find((m) => m.t === 'bsnap') as { to: string; label: string; steps: AgentBrowserStep[] }
  assert.equal(snap.to, 'tab1')
  assert.equal(snap.label, 'Eaon’s browser')
  assert.equal(snap.steps.length, 1)

  // A burst of pictures goes as one, the newest; the next waits out the gap.
  for (let n = 1; n <= 6; n++) fake.paint('agent', n)
  await sleep(20)
  let frames = sent.filter((m) => m.t === 'bframe') as { frame: AgentBrowserFrame }[]
  assert.equal(frames.length, 1)
  assert.equal(frames[0].frame.image.endsWith(',6'), true, 'the newest picture won')
  fake.paint('agent', 7)
  fake.paint('agent', 8)
  await sleep(150)
  assert.equal(sent.filter((m) => m.t === 'bframe').length, 1, 'not before the gap')
  await sleep(300)
  frames = sent.filter((m) => m.t === 'bframe') as { frame: AgentBrowserFrame }[]
  assert.equal(frames.length, 2)
  assert.equal(frames[1].frame.image.endsWith(',8'), true)

  // A step, to the tab watching that browser only.
  fake.step({ target: 'agent', chatId: 'c1', action: 'click', detail: 'button “Sign in”', done: false, at: 2 })
  fake.step({ target: 'worker:w1', chatId: 'c2', action: 'open', detail: 'other.com', done: false, at: 3 })
  const stepsSent = sent.filter((m) => m.t === 'bstep') as { to: string; step: AgentBrowserStep }[]
  assert.deepEqual(stepsSent.map((m) => [m.to, m.step.action]), [['tab1', 'click']])

  // The tab goes away: its watch ends.
  await handler.handle({ t: 'gone', from: 'tab1' })
  assert.equal(fake.watching('agent'), 0)
  sent.length = 0
  fake.paint('agent', 7)
  fake.step({ target: 'agent', chatId: 'c1', action: 'type', detail: 'email', done: false, at: 4 })
  await sleep(400)
  assert.deepEqual(sent, [])

  // Unsubscribing does the same; dispose leaves nothing watching.
  await handler.handle({ t: 'bsub', from: 'tab2', target: 'worker:w1' })
  assert.equal(fake.watching('worker:w1'), 1)
  await handler.handle({ t: 'bunsub', from: 'tab2', target: 'worker:w1' })
  assert.equal(fake.watching('worker:w1'), 0)
  await handler.handle({ t: 'bsub', from: 'tab3', target: 'agent' })
  handler.dispose()
  assert.equal(fake.watching('agent'), 0)
})

test('the computer remembers which guests are connected, until each goes away', async () => {
  const handler = createRcHandler({ terminals, ade: { list: () => [], changes: async () => null }, workers: null, browsers: fakeBrowsers().browsers, send: () => undefined })
  await handler.handle({ t: 'req', from: 'g1', guest: 'Bob', id: 'r1', method: 'GET', path: '/browsers' })
  await handler.handle({ t: 'req', from: 'own', id: 'r2', method: 'GET', path: '/browsers' })
  assert.deepEqual(handler.guestsOnline(), ['bob'])
  await handler.handle({ t: 'gone', from: 'g1' })
  assert.deepEqual(handler.guestsOnline(), [])
  handler.dispose()
})
