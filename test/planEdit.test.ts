import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PLAN_STEPS, MAX_STEP_CHARS, cleanPlanSteps, moveStep, planApprovalMessage, planChanged } from '../src/shared/planEdit'

/** Editing the plan the agent proposed before it builds: what typed steps become, and what the agent is told on approval. */

test('steps as typed are trimmed, blanks dropped, long ones cut and the count capped', () => {
  assert.deepEqual(cleanPlanSteps(['  Add the route  ', '', '   ', 'Write\n  tests']), ['Add the route', 'Write tests'])
  assert.equal(cleanPlanSteps(['x'.repeat(2000)])[0].length, MAX_STEP_CHARS)
  assert.equal(cleanPlanSteps(Array.from({ length: 100 }, (_, i) => `step ${i}`)).length, MAX_PLAN_STEPS)
  assert.deepEqual(cleanPlanSteps([]), [])
})

test('a step moves up or down by one and stays put at the ends', () => {
  assert.deepEqual(moveStep(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c'])
  assert.deepEqual(moveStep(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b'])
  assert.deepEqual(moveStep(['a', 'b'], 0, -1), ['a', 'b'])
  assert.deepEqual(moveStep(['a', 'b'], 1, 1), ['a', 'b'])
  assert.deepEqual(moveStep(['a'], 5, 1), ['a'])
  const original = ['a', 'b']
  moveStep(original, 0, 1)
  assert.deepEqual(original, ['a', 'b'], 'the list given is not changed')
})

test('a plan counts as changed only when its steps differ', () => {
  assert.equal(planChanged(['a', 'b'], ['a', 'b']), false)
  assert.equal(planChanged(['a', 'b'], ['b', 'a']), true)
  assert.equal(planChanged(['a', 'b'], ['a']), true)
  assert.equal(planChanged(['a'], ['a', 'b']), true)
})

test('approving an untouched plan says so; approving an edited one hands the agent the person’s steps in order', () => {
  assert.match(planApprovalMessage({ title: 'Add search', steps: ['a'] }), /^Approved — carry out the plan\./)
  assert.doesNotMatch(planApprovalMessage({ title: 'Add search', steps: ['a'] }), /changed the plan/)
  const edited = planApprovalMessage({ title: 'Add search', steps: ['Write the test first', 'Add the route'], edited: true })
  assert.match(edited, /I changed the plan, so carry out this version, not your first one \(Add search\)/)
  assert.match(edited, /1\. Write the test first\n2\. Add the route/)
  assert.match(edited, /in this order and nothing else/)
})
