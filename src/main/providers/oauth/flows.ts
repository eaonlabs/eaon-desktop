import { huggingFaceFlow, poeFlow } from './appClients'
import { codexFlow } from './codex'
import { claudeCodeFlow } from './claudeCode'
import { copilotFlow } from './copilot'
import { registerOAuthFlow } from './index'
import { openRouterFlow } from './openrouter'
import { siwcFlow } from './siwc'

/**
 * Registers the built-in sign-in flows. Imported for its side effect by
 * `providers/index.ts`, so any code that can list providers can also resolve
 * their flows. There is no Claude Pro/Max sign-in of Eaon's own, nor Google's
 * Gemini CLI / Antigravity logins: their terms forbid other apps from using
 * them (see "Provider OAuth landscape" in the project brain). A Claude plan is
 * used through the unmodified Claude Code the user signed in themselves: in
 * the ADE's terminals, and as Claude Agent, where Claude Code makes every
 * request itself (`claudeCodeFlow` only waits for its own sign-in).
 */
registerOAuthFlow(siwcFlow)
registerOAuthFlow(codexFlow)
registerOAuthFlow(copilotFlow)
registerOAuthFlow(claudeCodeFlow)
registerOAuthFlow(openRouterFlow)
registerOAuthFlow(huggingFaceFlow)
registerOAuthFlow(poeFlow)
