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
  return (
    <div className="context-usage">
      <div className="context-panel__head">
        <span>This chat</span>
        <span className="context-panel__numbers">
          {used.turns} {used.turns === 1 ? 'reply' : 'replies'}
        </span>
      </div>
      <p
        className="context-usage__tokens"
        title={`${total.input.toLocaleString()} uncached input · ${total.cacheRead.toLocaleString()} cache reads · ${total.cacheWrite.toLocaleString()} cache writes · ${total.output.toLocaleString()} output`}
      >
        {compactCount(inputTokens(total))} in · {compactCount(total.output)} out{cached > 0 ? ` · ${cached}% cached` : ''}
      </p>
      {cost?.usd != null && (
        <p className="context-usage__cost">
          About {usd(cost.usd)}
          <span> at published per-token rates</span>
        </p>
      )}
      {cost && cost.unpriced.length > 0 && (
        <p className="context-panel__note">
          {cost.usd === null ? 'No price is known for ' : 'Not in that price: '}
          {cost.unpriced.map((u) => name(u.model)).join(', ')}, so {cost.usd === null ? 'only tokens are shown' : 'only its tokens are counted'}.
        </p>
      )}
      <p className="context-panel__note">Counts are what the provider reported for each reply. A price is an estimate: a subscription plan or a free model isn’t charged it.</p>
    </div>
  )
}
