import type { ChatMessage } from '@shared/types'

/** Pull requests a chat or a terminal names by their links: what the dock's Linked pull requests lists. Free of React, for the tests. */

export interface LinkedPull {
  url: string
  repo: string
  number: number
}

const PULL_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g

/** Pull requests named in a chat by their links, newest mention first, each once. */
export function linkedPulls(messages: ChatMessage[]): LinkedPull[] {
  return linkedPullsInText(
    messages.flatMap((message) =>
      message.parts.map((part) => (part.type === 'text' ? part.text : part.type === 'tool' ? `${JSON.stringify(part.input)} ${typeof part.output === 'string' ? part.output : ''}` : ''))
    )
  )
}

/** Pull requests linked in `texts`, read in the order given: the last one named comes first, each once. */
export function linkedPullsInText(texts: string[]): LinkedPull[] {
  const seen = new Map<string, LinkedPull>()
  for (const text of texts) {
    for (const m of text.matchAll(PULL_URL)) {
      const url = `https://github.com/${m[1]}/pull/${m[2]}`
      seen.delete(url)
      seen.set(url, { url, repo: m[1], number: Number(m[2]) })
    }
  }
  return [...seen.values()].reverse()
}
