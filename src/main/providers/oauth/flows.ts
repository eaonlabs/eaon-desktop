import { codexFlow } from './codex'
import { copilotFlow } from './copilot'
import { registerOAuthFlow } from './index'
import { openRouterFlow } from './openrouter'

/**
 * Registers the built-in sign-in flows. Imported for its side effect by
 * `providers/index.ts`, so any code that can list providers can also resolve
 * their flows. Claude Pro/Max subscription sign-in is deliberately absent.
 */
registerOAuthFlow(codexFlow)
registerOAuthFlow(copilotFlow)
registerOAuthFlow(openRouterFlow)
