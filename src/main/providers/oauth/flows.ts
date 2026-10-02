import { huggingFaceFlow, poeFlow } from './appClients'
import { codexFlow } from './codex'
import { copilotFlow } from './copilot'
import { registerOAuthFlow } from './index'
import { openRouterFlow } from './openrouter'
import { siwcFlow } from './siwc'

/**
 * Registers the built-in sign-in flows. Imported for its side effect by
 * `providers/index.ts`, so any code that can list providers can also resolve
 * their flows. Claude Pro/Max sign-in is deliberately absent, as are Google's
 * Gemini CLI / Antigravity logins: their terms forbid other apps from using
 * them (see "Provider OAuth landscape" in the project brain). A Claude plan is
 * used by running the unmodified Claude Code in the ADE's terminal view, never
 * by routing Eaon's own requests through it.
 */
registerOAuthFlow(siwcFlow)
registerOAuthFlow(codexFlow)
registerOAuthFlow(copilotFlow)
registerOAuthFlow(openRouterFlow)
registerOAuthFlow(huggingFaceFlow)
registerOAuthFlow(poeFlow)
