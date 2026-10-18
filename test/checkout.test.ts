import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chargedAmounts, nothingDue, SPENDING } from '../src/main/features/payments/checkout'

/**
 * A worker on a checkout page: a Pay button spends money only if the page
 * says money is due. A code or a pass that brings the total to nothing makes
 * the order free, and the worker may place it on its own; anything else —
 * money due, a trial that bills later, a page with no total — still waits
 * for the user.
 */

// Stripe Checkout's text after a 100% promotion code (a bag pass): each
// figure in its own element, so its own line.
const STRIPE_FREE = `Pay Matic Robots
$0.00
Matic Robot Bags (12 pack)
Qty 1
$30.00
Subtotal
$30.00
BAGPASS
−$30.00
Total due
$0.00
Contact information
Email
owner@example.com
Pay`

const STRIPE_DUE = STRIPE_FREE.replace('BAGPASS\n−$30.00\n', '').replace('Total due\n$0.00', 'Total due\n$30.00').replace('$0.00\nMatic', '$30.00\nMatic')

test('a checkout a code has made free charges nothing', () => {
  assert.deepEqual(chargedAmounts(STRIPE_FREE), ['$0.00'])
  assert.equal(nothingDue(STRIPE_FREE), true)
  assert.equal(nothingDue('Order summary\nItems (1): $30.00\nPromo FREEBAGS: -$30.00\nOrder total: $0.00\nPlace your order'), true)
  assert.equal(nothingDue('Total: Free\nComplete order'), true)
  assert.equal(nothingDue('Montant total\nTotal 0,00 €'), true)
})

test('anything due, or charged later, is not free', () => {
  assert.equal(nothingDue(STRIPE_DUE), false, 'the code was never applied')
  assert.equal(nothingDue('Subtotal $0.00\nShipping $5.99\nTotal $5.99'), false, 'shipping still costs')
  assert.equal(nothingDue('Total due today $0.00\nTotal after trial $30.00'), false, 'two totals, one of them real')
  assert.equal(nothingDue('Due today $0.00\nThen $30.00 per month after your free trial\nStart trial'), false, 'a trial that bills later')
  assert.equal(nothingDue('Total due today\n$0.00\n$30.00/month starting Nov 18'), false)
  assert.equal(nothingDue('Matic Robot Bags\n$30.00\nAdd to cart'), false, 'no total on the page at all')
  assert.equal(nothingDue(''), false, 'nothing read from the page')
  assert.equal(nothingDue('Subtotal $0.00\nPay'), false, 'a subtotal is not what is charged')
})

test('opening the checkout is not spending; paying and placing the order are', () => {
  for (const label of ['Checkout', 'Check out', 'Proceed to checkout', 'Go to checkout', 'Add to cart', 'Apply', 'Continue'])
    assert.equal(SPENDING.test(label), false, label)
  for (const label of ['Pay', 'Pay $30.00', 'Place your order', 'Complete order', 'Buy now', 'Subscribe', 'Start free trial', 'Complete checkout'])
    assert.equal(SPENDING.test(label), true, label)
})
