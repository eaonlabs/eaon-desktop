import type { CardInput, PaymentLimits, PaymentsMode, PaymentsStatus } from '@shared/payments'
import type { WorkerMail } from '@shared/workers'
import { registerToolSource } from '../agent/tools'
import { secrets } from '../secrets'
import { store } from '../store'
import { agentBrowserUrl, typeSecretInAgentBrowser } from './agentBrowser'
import { typeHidden } from './computer/tool'
import { setPaymentAccess } from './payments/access'
import { PaymentsEngine } from './payments/engine'
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
const turnOrigins = new Map<string, 'guest' | 'delegated'>()
let unwatch: (() => void) | null = null

function watchWorkerTurns(): void {
  const workers = workersService()?.engine
  if (!workers) return
  unwatch?.()
  unwatch = workers.observe({
    turnStarted: (worker, mail) => {
      const origin = mailOrigin(mail)
      if (origin) turnOrigins.set(worker.id, origin)
      else turnOrigins.delete(worker.id)
    },
    turnEnded: (worker) => turnOrigins.delete(worker.id)
  })
}

/** The running engine, for tests and other features; null before registration. */
export function paymentsEngine(): PaymentsEngine | null {
  return engine
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
    covers: (chatId, url) => created.claimSpendingClick(chatId, url),
    secret: () => {
      try {
        const { number, cvc } = created.cardSecret()
        return { number, cvc }
      } catch {
        return null
      }
    }
  })
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
    const id = ctx.request.workerId
    if (!id) return null
    if (workersService()?.engine.turnCap(id)) return 'guest'
    return turnOrigins.get(id) ?? null
  }
)

registerToolSource({
  id: 'payments',
  // The main agent and workers, never sub-agents or trading sessions, and only once a card is set up.
  tools: (query) =>
    query.mode === 'work' && query.depth === 0 && !query.request.chatId?.startsWith('trading:') && engine !== null && engine.effectiveMode() !== 'off' ? [tool] : [],
  guidance: () => PAYMENT_GUIDANCE
})

export const paymentsFeature: Feature = {
  id: 'payments',
  register: (ctx) => {
    send = ctx.send
    engine = createEngine()
    // Registered after workers (features/index.ts), so their engine is there to follow.
    watchWorkerTurns()
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
    unwatch?.()
    unwatch = null
    turnOrigins.clear()
  }
}
