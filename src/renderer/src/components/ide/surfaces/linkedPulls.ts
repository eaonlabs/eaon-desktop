import type { ChatMessage } from '@shared/types'

/** Pull requests a chat names by their links: what the dock's Linked pull requests lists. Free of React, for the tests. */

export interface LinkedPull {
  url: string
  repo: string
  number: number
}

const PULL_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g

/** Pull requests named in a chat by their links, newest mention first, each once. */
export function linkedPulls(messages: ChatMessage[]): LinkedPull[] {
  const seen = new Map<string, LinkedPull>()
  for (const message of messages) {
    for (const part of message.parts) {
      const text = part.type === 'text' ? part.text : part.type === 'tool' ? `${JSON.stringify(part.input)} ${typeof part.output === 'string' ? part.output : ''}` : ''
      for (const m of text.matchAll(PULL_URL)) {
        const url = `https://github.com/${m[1]}/pull/${m[2]}`
        seen.delete(url)
        seen.set(url, { url, repo: m[1], number: Number(m[2]) })
      }
    }
  }
  return [...seen.values()].reverse()
}
