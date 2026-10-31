import type { OAuthFlow } from './index'
import { claudeCodeStatus, onClaudePlan } from '../../engines/claude/status'

/**
 * Claude Agent's sign-in, which is Claude Code's own: Eaon opens the user's
 * terminal on `claude auth login` and waits for Claude Code to say it is
 * signed in. Eaon stores nothing and never sees a token; every request is
 * made by Claude Code itself (providers/claudeAgent). Anthropic forbids apps
 * their own Claude sign-in, and allows the user's own Claude Code
 * (code.claude.com/docs/en/legal-and-compliance).
 */

const WAIT_MS = 5 * 60_000
const POLL_MS = 3_000

/** The Claude engine, which runs the sign-in and checks it; loaded when needed, as it loads the engines. */
async function claudeEngine() {
  const { engine } = await import('../../engines')
  const found = engine('claude')
  if (!found?.login) throw new Error('Claude Code isn’t available in this copy of Eaon.')
  return found
}

export const claudeCodeFlow: OAuthFlow = {
  id: 'claude-code',

  async signIn(onPrompt, signal) {
    const engine = await claudeEngine()
    if (onClaudePlan(await engine.detect({ force: true }))) return
    onPrompt({ url: '', message: 'Finish signing in in the Terminal window Eaon opened (claude auth login), with your Claude account. This updates when you’re done.' })
    const stop = (): void => void engine.cancelLogin?.()
    signal.addEventListener('abort', stop, { once: true })
    try {
      await engine.login!()
      const until = Date.now() + WAIT_MS
      // Signed in with a key instead: Claude Agent is for the plan, and says so.
      while (!onClaudePlan(claudeCodeStatus()) && Date.now() < until && !signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        await engine.detect({ force: true })
      }
      if (!onClaudePlan(claudeCodeStatus())) {
        throw new Error('Claude Code is signed in with an API key, which Anthropic charges per use. Sign in with your Claude account: claude auth login.')
      }
    } finally {
      signal.removeEventListener('abort', stop)
    }
  },

  async signOut() {
    // Signing Claude Code out would sign out its terminals too: that is the user's to do.
    throw new Error('Claude Agent uses Claude Code’s own sign-in. To sign out, run claude auth logout in a terminal.')
  },

  isSignedIn: () => onClaudePlan(claudeCodeStatus()),

  // No token of Eaon's: Claude Code signs every request itself.
  credentials: async () => ({}),

  account() {
    const status = claudeCodeStatus()
    return onClaudePlan(status) ? `Claude account${status?.auth.plan ? ` · ${status.auth.plan}` : ''}` : undefined
  }
}
