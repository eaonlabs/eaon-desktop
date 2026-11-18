import { useEffect, useMemo, useState, type JSX } from 'react'
import type { ChatMessage } from '@shared/types'
import { cachedPercent, chatUsage, compactCount, inputTokens, usd, type ChatCost } from '@shared/chatUsage'

/**
 * The tokens a chat has used, in the context meter's panel: input, output and
 * how much came from the provider's cache, added up over the replies that
 * reported them. A dollar figure appears only for a model whose price Eaon
 * already knows, at published per-token rates; for any other the tokens
 * stand alone. Nothing is shown before the first counted reply.
 */
export function ChatUsage({ messages }: { messages: readonly ChatMessage[] }): JSX.Element | null {
  const used = useMemo(() => chatUsage(messages), [messages])
  const [cost, setCost] = useState<ChatCost | null>(null)
  // Priced again only when the counts change, not on every streamed word.
  const key = JSON.stringify(used.byModel)
  useEffect(() => {
    if (used.turns === 0) {
      setCost(null)
      return
    }
    let live = true
    window.api.chatContext
      .cost(used.byModel)
      .then((next) => live && setCost(next))
      .catch(() => live && setCost(null))
    return () => {
      live = false
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  if (used.turns === 0) return null
  const { total } = used
  const cached = cachedPercent(total)
  const name = (model: string): string => model || 'an unknown model'
  // One line; the fine print is in its tooltip.
  const unpriced = cost && cost.unpriced.length > 0 ? `No price is known for ${cost.unpriced.map((u) => name(u.model)).join(', ')}. ` : ''
  const title = `${total.input.toLocaleString()} uncached input · ${total.cacheRead.toLocaleString()} cache reads · ${total.cacheWrite.toLocaleString()} cache writes · ${total.output.toLocaleString()} output. ${unpriced}Counts are what the provider reported for each reply; a price is at published per-token rates, which a subscription plan or a free model isn’t charged.`
  return (
    <div className="context-usage" title={title}>
      <div className="context-panel__head">
        <span>This chat</span>
        <span className="context-panel__numbers">
          {used.turns} {used.turns === 1 ? 'reply' : 'replies'}
        </span>
      </div>
      <p className="context-usage__tokens">
        {compactCount(inputTokens(total))} in · {compactCount(total.output)} out{cached > 0 ? ` · ${cached}% cached` : ''}
        {cost?.usd != null && <span className="context-usage__cost"> · about {usd(cost.usd)}</span>}
      </p>
    </div>
  )
}
