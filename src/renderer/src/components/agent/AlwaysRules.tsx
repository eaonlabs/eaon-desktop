import { useMemo, useState, type JSX } from 'react'
import { useApp, type PendingApproval } from '../../state/store'
import { addRulePatch, suggestRules } from '@shared/commandRules'
import { approvalRisk } from './ApprovalCard'

/**
 * Under a command's question: save a rule for it so the next one doesn't ask
 * ("npm test" always allowed), or never runs. The rule is the command's tool
 * and subcommand (shared/commandRules.ts patternFor), for every project or
 * for this chat's project only, and shows before it is saved.
 */
export function AlwaysRules({ ask, answer }: { ask: PendingApproval; answer: (approved: boolean) => void }): JSX.Element | null {
  const patchSettings = useApp((s) => s.patchSettings)
  const general = useApp((s) => s.settings?.general)
  const folder = useApp((s) => {
    const projectId = s.chats.find((c) => c.messages.some((m) => m.id === ask.messageId))?.projectId
    return s.projects.find((p) => p.id === projectId)?.folder ?? null
  })
  const [scope, setScope] = useState<'project' | 'all'>(folder ? 'project' : 'all')
  const command = String(ask.input.command ?? '')
  const patterns = useMemo(() => suggestRules(command), [command])
  if (ask.tool !== 'run_command' || !patterns) return null
  // What can't be taken back is asked every time; it can still be refused for good.
  const canAllow = !ask.critical && approvalRisk(ask.tool, ask.input) !== 'high'
  const where = scope === 'project' && folder ? folder : null

  const save = (list: 'allow' | 'deny'): void => {
    void patchSettings({ general: addRulePatch(general, list, patterns, where) })
    answer(list === 'allow')
  }

  return (
    <div className="ask-row__rules" role="group" aria-label="Save a rule for this command">
      <div className="ask-row__rules-what">
        <span className="ask-row__rules-cap">Remember</span>
        {patterns.map((p) => (
          <code key={p}>{p}</code>
        ))}
      </div>
      <div className="ask-row__rules-act">
        {folder && (
          <span className="ask-row__rules-scope" role="radiogroup" aria-label="Where the rule applies">
            {(['project', 'all'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={scope === value} data-on={scope === value || undefined} onClick={() => setScope(value)}>
                {value === 'project' ? 'This project' : 'Every project'}
              </button>
            ))}
          </span>
        )}
        <span className="ask-row__rules-go-group">
          <button type="button" className="ask-row__rules-go ask-row__rules-go--deny" onClick={() => save('deny')}>
            Never allow
          </button>
          {canAllow && (
            <button type="button" className="ask-row__rules-go ask-row__rules-go--allow" onClick={() => save('allow')}>
              Always allow
            </button>
          )}
        </span>
      </div>
    </div>
  )
}
