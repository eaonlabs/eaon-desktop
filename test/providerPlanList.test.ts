import { test } from 'node:test'
import assert from 'node:assert/strict'
import { store } from '../src/main/store'
import { getProvider } from '../src/main/providers'
import { nativeOptions, OUTSIDE_PLAN_NOTE } from '@shared/modelSelection'

/**
 * The ChatGPT plan's own model list lags new models: an account whose list
 * named four models could still use the newer ones the catalog knows. Those
 * stay offered, after the plan's own, marked "May not be on your plan".
 * Copilot's list is its policy, so a model it leaves out stays out.
 */

const row = (providerId: string, id: string) => ({ id, label: id, providerId })

test('ChatGPT: the plan’s own models first, then the catalog’s newer ones, marked', () => {
  const plan = ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']
  store.saveProviderConfig({
    chatgpt: { listed: plan.map((id) => row('chatgpt', id)), listedAt: Date.now() },
    'github-copilot': { listed: [row('github-copilot', 'gpt-5.5')], listedAt: Date.now() }
  })
  const chatgpt = getProvider('chatgpt')
  assert.ok(chatgpt)
  const ids = chatgpt.models.map((m) => m.id)
  assert.deepEqual(ids.slice(0, plan.length).sort(), [...plan].sort(), 'the plan’s own models lead')
  for (const model of chatgpt.models.slice(0, plan.length)) assert.equal(model.outsidePlan, undefined, model.id)
  const extra = chatgpt.models.slice(plan.length)
  assert.ok(extra.some((m) => m.id === 'gpt-6.1-sol'), `the newest catalog model is offered: ${ids.join(', ')}`)
  assert.ok(extra.every((m) => m.outsidePlan === true), 'and marked')

  // The pickers say so on the row; it stays usable (not "needs attention").
  const options = nativeOptions([{ ...chatgpt, hasKey: true, signedIn: true }])
  const sol = options.find((o) => o.modelId === 'gpt-6.1-sol')
  assert.equal(sol?.planNote, OUTSIDE_PLAN_NOTE)
  assert.equal(options.find((o) => o.modelId === 'gpt-6-astra')?.planNote, null)

  // Copilot's list is what its policy allows: nothing else appears.
  const copilot = getProvider('github-copilot')
  assert.deepEqual(
    copilot?.models.map((m) => m.id),
    ['gpt-5.5']
  )
})
