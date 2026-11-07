import { useEffect, useState, type JSX } from 'react'
import { FileText } from 'lucide-react'
import type { ProjectRules } from '@shared/projectRules'
import { useApp } from '../../state/store'
import { openInCode } from '../ide/ideStore'
import { useChatCode } from './chatCodeStore'

/**
 * The workspace card's Rules part: the project's rules files (AGENTS.md,
 * CLAUDE.md, .cursorrules…) that Eaon puts in the agent's instructions for
 * this folder, each opening in the editor beside the chat, and any it found
 * and left out, with the reason. Nothing found, nothing shown.
 */

const size = (chars: number): string => (chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars))

export function RulesPart(): JSX.Element | null {
  const folder = useChatCode((s) => s.folder)
  // A Codex model reads its own AGENTS.md; what Eaon would add isn't what it is given.
  const onEngine = useApp((s) => Boolean(s.settings?.selectedEngine))
  const [rules, setRules] = useState<Pick<ProjectRules, 'files' | 'skipped'> | null>(null)
  useEffect(() => {
    setRules(null)
    if (!folder) return
    let live = true
    const read = (): void =>
      void window.api.chatContext
        .rules(folder)
        .then((next) => live && setRules(next))
        .catch(() => {})
    read()
    // Back from an editor: the file may have changed.
    window.addEventListener('focus', read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
    }
  }, [folder])
  if (!folder || onEngine || !rules || (rules.files.length === 0 && rules.skipped.length === 0)) return null
  return (
    <div className="ws-card__part">
      <div className="ws-card__label">Project rules</div>
      {rules.files.map((file) => (
        <button
          key={file.path}
          type="button"
          className="ws-row"
          title={`${file.path}\nGiven to the agent with every message${file.cut ? ` (the first ${file.chars.toLocaleString('en-US')} characters)` : ''}`}
          onClick={() => void openInCode(file.path)}
        >
          <span className="ws-row__icon">
            <FileText size={15} strokeWidth={1.8} />
          </span>
          <span className="ws-row__label">{file.name}</span>
          <span className="ws-row__meta">{file.cut ? 'cut' : size(file.chars)}</span>
        </button>
      ))}
      {rules.skipped.map((file) => (
        <button key={file.path} type="button" className="ws-row ws-row--muted" title={`${file.path}\nNot used: it ${file.reason}`} onClick={() => void openInCode(file.path)}>
          <span className="ws-row__icon">
            <FileText size={15} strokeWidth={1.8} />
          </span>
          <span className="ws-row__label">{file.name}</span>
          <span className="ws-row__meta">not used</span>
        </button>
      ))}
    </div>
  )
}
