import { relative, resolve, sep } from 'node:path'

/**
 * Checks on what the renderer sends main over IPC, for the handlers that
 * take a vault id, a download path or a server URL. The renderer is Eaon's
 * own page, but it renders text from models, web pages and plugins; main
 * decides what a request may touch rather than trusting the page that sent
 * it.
 */

/**
 * The secrets vault holds model-provider keys under the provider's id, and
 * everything else under a namespaced id (`plugin:github`, `channel:…`,
 * `payments:card`, OAuth tokens). The Keys handlers are for the first kind
 * only: a provider Eaon knows, never a namespaced entry, so a request can't
 * read back a plugin token's fallbacks, overwrite the card, or clear a chat
 * app's bot token.
 */
export function providerKeyId(id: unknown, knownProviders: string[]): string {
  if (typeof id !== 'string' || !id || id.length > 200 || id.includes(':') || !knownProviders.includes(id)) {
    throw new Error('That isn’t a model provider Eaon knows.')
  }
  return id
}

const REPO = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/

/**
 * A Hugging Face repo id and a file in it, safe to put in a download URL and
 * under the models folder: `owner/name`, and a relative path whose every
 * part is a plain name. Anything else — `..`, an absolute path, a `?` or `#`
 * that would turn the rest of the URL into a query — is refused, so a
 * download can never write outside `<models>/<owner>__<name>/`.
 */
export function checkHfFile(repoId: unknown, filename: unknown, root: string): { repoId: string; filename: string; dest: string } {
  if (typeof repoId !== 'string' || !REPO.test(repoId) || repoId.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('That isn’t a Hugging Face repository Eaon can download from.')
  }
  const parts = typeof filename === 'string' ? filename.split('/') : []
  if (
    parts.length === 0 ||
    parts.length > 8 ||
    parts.some((part) => !part || part === '.' || part === '..' || part.length > 255 || /[\\?#%\u0000-\u001f]/.test(part))
  ) {
    throw new Error('That isn’t a file Eaon can download.')
  }
  const folder = resolve(root, repoId.replace('/', '__'))
  const dest = resolve(folder, ...parts)
  const inside = relative(folder, dest)
  if (!inside || inside.startsWith('..') || inside.startsWith(sep)) throw new Error('That isn’t a file Eaon can download.')
  return { repoId, filename: parts.join('/'), dest }
}

/** The same scheme, host and port: where a credential made for one server may be sent. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}
