import type { ChatCost, ModelUsage } from '@shared/chatUsage'
import { allTokens } from '@shared/chatUsage'
import { costOf, priceOf, type ToknPricing } from '../usage/rows'

/**
 * What a chat's tokens cost at published per-token rates, over the models
 * the price table (Tokn's, as Settings → Usage uses) has a price for. A model
 * it has none for (a local model, a brand-new one, an unnamed one) is listed
 * with its tokens and left out of the sum: nothing is guessed.
 */
export function costForChat(groups: readonly ModelUsage[], pricing: ToknPricing): ChatCost {
  let usd: number | null = null
  const unpriced: ChatCost['unpriced'] = []
  for (const group of groups) {
    const priced = group.model ? priceOf(group.model, pricing) : null
    if (!priced) {
      unpriced.push({ model: group.model, tokens: allTokens(group.usage) })
      continue
    }
    usd = (usd ?? 0) + costOf({ requests: group.turns, ...group.usage }, priced.price)
  }
  return { usd, unpriced }
}
