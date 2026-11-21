/**
 * A project's picture: the avatar of the account or organisation that owns
 * its repository on GitHub, GitLab, Codeberg or Bitbucket, found from the
 * folder's `origin` remote (main/features/projectAvatars.ts looks it up and
 * keeps it). A project on another host, or with no remote, keeps its
 * initials (threads.tsx ProjectBadge).
 */

export type Forge = 'github' | 'gitlab' | 'codeberg' | 'bitbucket'

export interface RepoOwner {
  forge: Forge
  /** The account or organisation: the first part of the repository's path. */
  owner: string
  /** Everything before the repository's name: GitLab's group and subgroups, else the owner. */
  namespace: string
}

/** The forge a remote's host is, by its name; SSH aliases for a second account (github.com-work) count as theirs. */
function forgeOf(host: string): Forge | null {
  const h = host.toLowerCase()
  const is = (name: string): boolean => h === name || h === `www.${name}` || h.startsWith(`${name}-`)
  if (is('github.com') || h === 'ssh.github.com') return 'github'
  if (is('gitlab.com') || h === 'altssh.gitlab.com') return 'gitlab'
  if (is('codeberg.org')) return 'codeberg'
  if (is('bitbucket.org') || h === 'altssh.bitbucket.org') return 'bitbucket'
  return null
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const REPO = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/

/**
 * Who owns the repository at a remote URL, in any of git's spellings
 * (https://, ssh://, git@host:owner/repo.git); null for a host this doesn't
 * know or a path that isn't owner/repository. Credentials in the URL are
 * never read past the host.
 */
export function ownerOfRemote(remote: string | null | undefined): RepoOwner | null {
  const text = remote?.trim()
  if (!text || text.length > 2048) return null
  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return null
    }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) return null
    host = url.hostname
    path = url.pathname
  } else if (scp && scp[1].length > 1) {
    // A drive letter (C:\…) is a folder, not a host.
    host = scp[1]
    path = scp[2]
  } else return null
  const forge = forgeOf(host)
  if (!forge) return null
  let parts: string[]
  try {
    parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  if (parts.length < 2 || !REPO.test(parts[parts.length - 1]) || parts.slice(0, -1).some((part) => !OWNER.test(part))) return null
  // Only GitLab nests groups; elsewhere a longer path is a page in the repository, not a deeper owner.
  const namespace = forge === 'gitlab' ? parts.slice(0, -1).join('/') : parts[0]
  return { forge, owner: parts[0], namespace }
}

/** What the picture is kept under: one per owner, so every project of theirs shares it. */
export const ownerKey = (owner: RepoOwner): string => `${owner.forge}:${owner.namespace.toLowerCase()}`

/**
 * Where to ask, in order. "image": the picture itself (GitHub answers
 * github.com/<owner>.png with a redirect to it, and 404 for no such owner).
 * "json": a public API whose answer names the picture's address (`pick`).
 */
export type AvatarStep = { kind: 'image'; url: string } | { kind: 'json'; url: string; pick: (body: unknown) => string | null }

const field = (body: unknown, ...path: string[]): string | null => {
  let at: unknown = body
  for (const key of path) at = at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined
  return typeof at === 'string' && at ? at : null
}

export function avatarSteps(owner: RepoOwner): AvatarStep[] {
  const name = encodeURIComponent(owner.owner)
  switch (owner.forge) {
    case 'github':
      return [{ kind: 'image', url: `https://github.com/${name}.png?size=64` }]
    case 'gitlab': {
      // The group the repository is in (a subgroup has a picture of its own, or none), then its top group, then a person's account.
      const groups = [owner.namespace, ...(owner.namespace.includes('/') ? [owner.owner] : [])]
      return [
        ...groups.map((group) => ({ kind: 'json' as const, url: `https://gitlab.com/api/v4/groups/${encodeURIComponent(group)}?with_projects=false`, pick: (body: unknown) => field(body, 'avatar_url') })),
        { kind: 'json', url: `https://gitlab.com/api/v4/users?username=${name}`, pick: (body) => (Array.isArray(body) ? field(body[0], 'avatar_url') : null) }
      ]
    }
    case 'codeberg':
      // Organisations answer here too.
      return [{ kind: 'json', url: `https://codeberg.org/api/v1/users/${name}`, pick: (body) => field(body, 'avatar_url') }]
    case 'bitbucket':
      return [{ kind: 'json', url: `https://api.bitbucket.org/2.0/workspaces/${name}`, pick: (body) => field(body, 'links', 'avatar', 'href') }]
  }
}
