import { useEffect } from 'react'
import type { BrowserAsk as Ask } from '@shared/browserBridge'
import { useApp } from '../../state/store'

/** What goes in the composer for something sent from the browser's right-click menu. */
export function draftFor(ask: Ask): string {
  const source = ask.title ? `“${ask.title}” — ${ask.url}` : ask.url
  switch (ask.kind) {
    case 'selection': {
      const quoted = ask.text
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      return `${quoted}\n\nFrom ${source}\n\n`
    }
    case 'link':
      return `${ask.url}\n\n`
    default:
      return `About this page: ${source}${ask.tabId !== null ? ` (shared with you as tab ${ask.tabId})` : ''}\n\n`
  }
}

/**
 * Turns "Ask Eaon about…" from the browser extension's right-click menu into
 * a new chat with the page, selection or link in the composer — as a draft
 * the user finishes and sends, never sent on its own, since page text is
 * whatever the page says.
 */
export function BrowserAsk(): null {
  useEffect(() => {
    const take = async (): Promise<void> => {
      const ask = await window.api.browserBridge.takeAsk()
      if (!ask) return
      const state = useApp.getState()
      const chat = state.workspaces.find((w) => w.kind === 'chat')
      if (chat && state.settings?.activeWorkspaceId !== chat.id) await state.patchSettings({ activeWorkspaceId: chat.id })
      useApp.getState().newChat()
      useApp.getState().setComposerDraft(draftFor(ask))
    }
    // One may have been sent before this window existed.
    void take()
    return window.api.browserBridge.onAsk(() => void take())
  }, [])
  return null
}
