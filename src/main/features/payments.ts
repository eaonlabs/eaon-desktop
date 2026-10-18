import type { CardInput, PaymentLimits, PaymentsMode, PaymentsStatus } from '@shared/payments'
import type { WorkerMail } from '@shared/workers'
import { registerToolSource } from '../agent/tools'
import { secrets } from '../secrets'
import { store } from '../store'
import { agentBrowserUrl, typeSecretInAgentBrowser } from './agentBrowser'
import { typeHidden } from './computer/tool'
import { setPaymentAccess, type SpendingClick } from './payments/access'
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
 * An autopilot purchase schedule's run, on its store, once its order is
 * authorized (so the price was checked against the maximum): its presses go
 * through without anyone, the order button too, and again if the first press
 * didn't take, until the order is completed. Before the authorization the
 * usual rules hold, so a "Buy now" can't place an order nobody priced.
 */
export function autopilotCovers(chatId: string, url: string, click: SpendingClick | undefined, payments: Pick<PaymentsEngine, 'openPlanOrder'>): boolean {
  const grant = click?.messageId ? grantFor(click.messageId) : null
  return Boolean(grant?.autopilot && grant.used && urlMatchesSite(url, grant.site) && payments.openPlanOrder(chatId, grant.planId, url))
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
    // On autopilot, any press on the store while the schedule's order is authorized; a press on nothing named, only then.
    covers: (chatId, url, click) => autopilotCovers(chatId, url, click, created) || (!click?.unnamed && created.claimSpendingClick(chatId, url)),
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
