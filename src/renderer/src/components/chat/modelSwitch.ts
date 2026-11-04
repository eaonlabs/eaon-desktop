import type { ChatMessage, Provider } from '@shared/types'

/**
 * Where a conversation changed model: the user messages whose reply ran on a
 * different model from the reply before, each with the model it moved to.
 * A reply with no model recorded (an older chat's) neither starts nor ends one.
 */
export function modelSwitches(messages: ChatMessage[]): Map<string, string> {
  const at = new Map<string, string>()
  let previous: string | null = null
  let asked: string | null = null
  for (const message of messages) {
    if (message.role === 'user') asked = message.id
    if (message.role !== 'assistant' || !message.model) continue
    if (previous && message.model !== previous && asked) at.set(asked, message.model)
    previous = message.model
  }
  return at
}

/** A model's name as the picker shows it, or its id when no provider lists it any more. */
export function modelName(providers: Provider[], id: string): string {
  for (const provider of providers) {
    const found = provider.models?.find((m) => m.id === id)
    if (found) return found.label
  }
  return id
}
