/**
 * Keys, bearer tokens and long secret-looking strings out of text that may be
 * shown, logged or copied (provider error bodies, "Copy details"). One
 * implementation for the whole app: see `src/main/redact.ts`.
 */
export { redactSecrets } from '../redact'
