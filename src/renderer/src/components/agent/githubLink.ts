/**
 * Links to GitHub in a reply. They're drawn with GitHub's mark in front, and a
 * bare address is shortened to what it points at, the way GitHub writes it:
 * `owner/repo#12` for a pull request or an issue, `files.ts:75` for a line of
 * a file, a commit's short hash. The whole address stays in the link's
 * tooltip.
 */

const HOSTS = /^https?:\/\/(?:www\.)?github\.com(?=[/?#]|$)/i
const GIST = /^https?:\/\/gist\.github\.com(?=[/?#]|$)/i

export const isGitHubUrl = (href: string): boolean => HOSTS.test(href) || GIST.test(href)

/** `gh` run anywhere in a command line: first, or after `cd x &&`, a pipe or `;`. */
const GH_COMMAND = /(?:^|[;&|(]\s*)gh\s+[a-z]/m
export const isGitHubCommand = (command: unknown): boolean => typeof command === 'string' && GH_COMMAND.test(command)

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** `#L75` → `:75`, `#L428-L431` → `:428–431`. */
function lines(hash: string): string {
  const match = /^#L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/.exec(hash)
  if (!match) return ''
  return match[2] && match[2] !== match[1] ? `:${match[1]}–${match[2]}` : `:${match[1]}`
}

/** A few words for what a GitHub address points at, or null when it isn't one. */
export function githubLabel(href: string): string | null {
  if (GIST.test(href)) return 'Gist'
  if (!HOSTS.test(href)) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decode)
  if (parts.length === 0) return 'GitHub'
  if (parts.length === 1) return parts[0]
  const [owner, name, kind, ...rest] = parts
  const repo = `${owner}/${name.replace(/\.git$/, '')}`
  if (!kind) return repo
  switch (kind) {
    case 'pull':
    case 'pulls':
    case 'issues':
      if (/^\d+$/.test(rest[0] ?? '')) {
        // A pull request's commit is that commit.
        if (rest[1] === 'commits' && rest[2]) return rest[2].slice(0, 7)
        return `${repo}#${rest[0]}`
      }
      return repo
    case 'commit':
      return rest[0] ? rest[0].slice(0, 7) : repo
    case 'blob':
    case 'blame':
      // The ref may hold slashes itself, so the file's name is all that's sure.
      return rest.length > 1 ? `${rest[rest.length - 1]}${lines(url.hash)}` : repo
    case 'tree':
      // A branch (which may hold slashes) and maybe a folder in it, as written.
      return rest.length ? rest.join('/') : repo
    case 'compare':
      return rest.length ? rest.join('/').replace(/\.\.\.?/, '…') : repo
    case 'releases':
      return rest[0] === 'tag' && rest[1] ? `${repo} ${rest[1]}` : repo
    default:
      return repo
  }
}
