import type { CardInput, PaymentLimits, PaymentsMode, PaymentsStatus } from '@shared/payments'
import type { WorkerMail } from '@shared/workers'
import { registerToolSource } from '../agent/tools'
import { secrets } from '../secrets'
import { store } from '../store'
import { agentBrowserUrl, typeSecretInAgentBrowser } from './agentBrowser'
import { typeHidden } from './computer/tool'
import { setPaymentAccess } from './payments/access'
import { PaymentsEngine, urlMatchesSite } from './payments/engine'
import { grantFor, setPurchaseLookup, watchFor } from './payments/plans'
import { PAYMENT_GUIDANCE, paymentTool } from './payments/tool'
import type { Feature } from './types'
import { workersService } from './workers'

/**
 * Agent payments, wired to the app: the config in `payments.json`, the card
 * number and security code in the encrypted vault (`payments:card`), IPC for
 * Settings → Payments, and the `payment_card` tool. The rules themselves are
 * in `payments/engine.ts`.
 */

const FILE = 'payments.json'
const VAULT_KEY = 'payments:card'

let engine: PaymentsEngine | null = null
let send: (channel: string, ...args: unknown[]) => void = () => undefined

/**
 * Whose work a worker's running turn carries, when it isn't only the
 * user's: a guest's message from a chat app, or mail from a colleague (a
 * hand-off, a message, a room post). Nothing is bought in such a turn.
 */
export function mailOrigin(mail: WorkerMail[]): 'guest' | 'delegated' | null {
  if (mail.some((m) => m.from === 'guest' || m.channel?.cap)) return 'guest'
  if (mail.some((m) => m.from !== 'user')) return 'delegated'
  return null
}

/** The running engine, for tests and other features; null before registration. */
export function paymentsEngine(): PaymentsEngine | null {
  return engine
}

/**
 * The steps on the way to a checkout ("Proceed to checkout", "Continue to
 * payment"), as opposed to the press that places the order. A purchase
 * schedule's run may take these on its own store before it has a total to
 * authorize; the order itself still needs its authorization.
 */
const CHECKOUT_STEP = /\b(check ?out|proceed to (?:check ?out|payment|shipping|delivery)|continue to (?:check ?out|payment|shipping|delivery)|go to check ?out)\b/i
const ORDER_PRESS = /\b(place|buy now|pay now|pay \$|complete|confirm|submit|subscribe|donate|transfer|withdraw|book)\b/i

export function checkoutStepCovered(url: string, click: { messageId?: string; name?: string } | undefined): boolean {
  const grant = click?.messageId ? grantFor(click.messageId) : null
  const name = click?.name ?? ''
  return Boolean(grant && urlMatchesSite(url, grant.site) && CHECKOUT_STEP.test(name) && !ORDER_PRESS.test(name))
}

function createEngine(): PaymentsEngine {
  const created = new PaymentsEngine({
    load: () => store.getJson<unknown>(FILE, null),
    save: (config) => {
      store.setJson(FILE, config)
      // Purchases the agent makes show up in an open Settings page at once.
      queueMicrotask(() => engine && send('payments:changed', engine.status()))
    },
    getSecret: () => secrets.get(VAULT_KEY),
    setSecret: (value) => (value ? secrets.set(VAULT_KEY, value) : secrets.clear(VAULT_KEY))
  })
  setPaymentAccess({
    // One press of the pay button per authorization (see claimSpendingClick).
    // A step towards checkout on a purchase schedule's store first, so it never uses up the one press an authorization covers.
    covers: (chatId, url, click) => checkoutStepCovered(url, click) || created.claimSpendingClick(chatId, url),
    secret: () => {
      try {
        const { number, cvc } = created.cardSecret()
        return { number, cvc }
      } catch {
        return null
      }
    }
  })
  setPurchaseLookup({ all: () => created.purchases() })
  return created
}

const tool = paymentTool(
  () => engine,
  {
    browser: typeSecretInAgentBrowser,
    browserUrl: agentBrowserUrl,
    screen: typeHidden
  },
  // A worker's turn that carries a guest's or a colleague's work, or a guest's cap.
  (ctx) => {
    if (!ctx.request.workerId) return null
    // By the run, not the worker: a worker's threads run side by side, and a
    // user's message in one must not clear a guest's or colleague's in another.
    return workersService()?.engine.turnOrigin(ctx.request.messageId) ?? null
  }
)

registerToolSource({
  id: 'payments',
  // The main agent and workers, never sub-agents or trading sessions, and only once a card is set up —
  // or in a purchase schedule's run, whose free orders and order tracking need no card.
  tools: (query) =>
    query.mode === 'work' &&
    query.depth === 0 &&
    !query.request.chatId?.startsWith('trading:') &&
    engine !== null &&
    (engine.effectiveMode() !== 'off' || grantFor(query.request.messageId) !== null || watchFor(query.request.messageId) !== null)
      ? [tool]
      : [],
  guidance: () => PAYMENT_GUIDANCE
})

export const paymentsFeature: Feature = {
  id: 'payments',
  register: (ctx) => {
    send = ctx.send
    engine = createEngine()
    const live = (): PaymentsEngine => engine!
    const { ipcMain } = ctx
    ipcMain.handle('payments:status', (): PaymentsStatus => live().status())
    ipcMain.handle('payments:set-card', (_e, input: CardInput): PaymentsStatus => live().setCard(input))
    ipcMain.handle('payments:remove-card', (): PaymentsStatus => live().removeCard())
    ipcMain.handle('payments:set-mode', (_e, mode: PaymentsMode): PaymentsStatus => live().setMode(mode))
    ipcMain.handle('payments:accept-waiver', (_e, version: number, checks: boolean[]): PaymentsStatus => live().acceptWaiver(version, checks))
    ipcMain.handle('payments:revoke-waiver', (): PaymentsStatus => live().revokeWaiver())
    ipcMain.handle('payments:set-limits', (_e, patch: Partial<PaymentLimits>): PaymentsStatus => live().setLimits(patch))
    ipcMain.handle('payments:set-currency', (_e, currency: string): PaymentsStatus => live().setCurrency(currency))
  },
  dispose: () => {
    setPaymentAccess(null)
    setPurchaseLookup(null)
  }
}
