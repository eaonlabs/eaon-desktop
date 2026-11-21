import { useEffect, useState, type JSX, type ReactNode } from 'react'
import type { PullRequestLabel, PullRequestSummary } from '@shared/types'
import { Octicon, type OcticonName } from './octicons'

/**
 * The small pieces the Pull requests page is built from, drawn the way
 * GitHub draws them: the state label, a branch's name, a label, an avatar,
 * a time, a counter, the five-square diffstat. Styles: pull-requests.css.
 */

export type PrState = PullRequestSummary['state']

/** Each state's icon and word, as GitHub has them. */
export const STATE: Record<PrState, { icon: OcticonName; label: string }> = {
  open: { icon: 'git-pull-request', label: 'Open' },
  merged: { icon: 'git-merge', label: 'Merged' },
  closed: { icon: 'git-pull-request-closed', label: 'Closed' },
  draft: { icon: 'git-pull-request-draft', label: 'Draft' }
}

/** A state as `gh` spelt it, whatever its case; one it has never sent reads as open rather than breaking the page. */
export function stateKey(state: string): PrState {
  const key = String(state).toLowerCase()
  return key in STATE ? (key as PrState) : 'open'
}

/** The filled label beside the title: icon and word on the state's colour. */
export function StateLabel({ state }: { state: PrState }): JSX.Element {
  const { icon, label } = STATE[state]
  return (
    <span className="gh-state" data-state={state}>
      <Octicon name={icon} />
      {label}
    </span>
  )
}

/** A branch's name, in GitHub's blue code tag. */
export function BranchRef({ name }: { name: string }): JSX.Element {
  return <code className="gh-ref" title={name}>{name}</code>
}

/** A label in its own colour: tinted, with the name in a lighter or darker shade of it to stay readable. */
export function GhLabel({ label }: { label: PullRequestLabel }): JSX.Element {
  return (
    <span className="gh-label" style={{ '--label': `#${label.color}` } as React.CSSProperties} title={label.name}>
      {label.name}
    </span>
  )
}

/** Pictures already asked for, so a conversation with one person in it asks once. */
const pictures = new Map<string, Promise<string | null>>()

/** Someone's GitHub picture, round; their initial while it loads or when there's none. */
export function Avatar({ login, size = 20 }: { login: string; size?: number }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (!login) return
    let asked = pictures.get(login)
    if (!asked) {
      asked = window.api.projectAvatars.github(login).catch(() => null)
      pictures.set(login, asked)
    }
    void asked.then((found) => live && setSrc(found))
    return () => {
      live = false
    }
  }, [login])
  return (
    <span className="gh-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} aria-hidden>
      {src ? <img src={src} alt="" /> : (login[0] ?? '?').toUpperCase()}
    </span>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "now", "5 minutes ago", "yesterday", "3 days ago", then "on Oct 3" (and the year when it isn't this one), as GitHub writes it. */
export function ghTime(iso: string, now = Date.now()): string {
  const at = new Date(iso)
  const ms = now - at.getTime()
  if (!Number.isFinite(ms)) return ''
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const year = at.getFullYear() === new Date(now).getFullYear() ? '' : `, ${at.getFullYear()}`
  return `on ${MONTHS[at.getMonth()]} ${at.getDate()}${year}`
}

/** A time in GitHub's words, with the exact moment under the pointer. */
export function RelativeTime({ iso }: { iso: string }): JSX.Element {
  const exact = new Date(iso)
  return (
    <time className="gh-time" dateTime={iso} title={Number.isNaN(exact.getTime()) ? undefined : exact.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}>
      {ghTime(iso)}
    </time>
  )
}

/** The grey pill with a number in it, on tabs and headers. */
export function Counter({ children, tone }: { children: ReactNode; tone?: 'danger' }): JSX.Element {
  return (
    <span className="gh-counter" data-tone={tone}>
      {children}
    </span>
  )
}

/** "+12 −3" and five squares, green for what was added and red for what was taken out, as on a file or a whole pull request. */
export function Diffstat({ additions, deletions, squares = true }: { additions: number; deletions: number; squares?: boolean }): JSX.Element {
  const total = additions + deletions
  const green = total ? Math.round((additions / total) * 5) : 0
  const red = total ? Math.min(5 - green, Math.round((deletions / total) * 5)) : 0
  return (
    <span className="gh-diffstat" title={`${additions.toLocaleString()} additions, ${deletions.toLocaleString()} deletions`}>
      <span className="gh-diffstat__add">+{additions.toLocaleString()}</span>
      <span className="gh-diffstat__del">−{deletions.toLocaleString()}</span>
      {squares && (
        <span className="gh-diffstat__squares" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} data-kind={i < green ? 'add' : i < green + red ? 'del' : 'none'} />
          ))}
        </span>
      )}
    </span>
  )
}

/** The number on the end of a pull request's address. */
export const numberOf = (url: string): string => url.match(/\/pull\/(\d+)/)?.[1] ?? ''

export const errorText = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error))

/** GitHub's word for how someone relates to the repository, for a comment's header; nothing for "none". */
export function associationLabel(association: string): string | null {
  const words: Record<string, string> = { OWNER: 'Owner', MEMBER: 'Member', COLLABORATOR: 'Collaborator', CONTRIBUTOR: 'Contributor', FIRST_TIME_CONTRIBUTOR: 'First-time contributor', FIRST_TIMER: 'First-time contributor' }
  return words[association] ?? null
}
