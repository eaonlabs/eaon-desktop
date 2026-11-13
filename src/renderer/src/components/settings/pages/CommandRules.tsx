import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { Card, Details, Section, Select } from '../../ui'
import { normalizeRules, parseRuleText, ruleProblem, type CommandRules as Rules, type RuleList } from '@shared/commandRules'

/**
 * Settings → General → Command rules: the shell commands the agent may run
 * without asking, the ones it always asks about and the ones it may never
 * run, for every project and for one project's folder. One pattern a line:
 * words with "*" for anything, or a /regular expression/
 * (shared/commandRules.ts says how they match).
 *
 * One list is open at a time, so three long boxes don't stack up on the page.
 */

const LISTS: { list: RuleList; title: string; aria: string; placeholder: string; what: string }[] = [
  { list: 'allow', title: 'Always allow', aria: 'Commands to always allow', placeholder: 'npm test\nnpm run *\ngit status', what: 'These run without asking.' },
  { list: 'ask', title: 'Always ask', aria: 'Commands to always ask about', placeholder: 'git push *\n/^docker (rm|rmi|system prune)/', what: 'These stop and ask every time, in every mode. A worker with nobody to ask doesn’t run them.' },
  { list: 'deny', title: 'Never allow', aria: 'Commands to never allow', placeholder: 'rm -rf *\ncat .env*\n/curl .*\\| *sh/', what: 'These never run, in any mode, for workers and scheduled tasks too. The agent is told why and goes another way. This list wins over the other two.' }
]

/** The three lists for one set of rules, as tabs over a single box; saves when the box loses focus. */
function RuleEditor({ rules, onSave }: { rules: Rules; onSave: (next: Rules) => void }): JSX.Element {
  const saved = JSON.stringify(rules)
  const [open, setOpen] = useState<RuleList>('allow')
  const [text, setText] = useState<Record<RuleList, string>>({ allow: '', ask: '', deny: '' })
  // Rules changed elsewhere (the CLI, another window, "Always allow" on a question) show here too.
  useEffect(() => {
    const now = JSON.parse(saved) as Rules
    setText({ allow: now.allow.join('\n'), ask: now.ask.join('\n'), deny: now.deny.join('\n') })
  }, [saved])

  const save = (): void => {
    const next: Rules = { allow: parseRuleText(text.allow), ask: parseRuleText(text.ask), deny: parseRuleText(text.deny) }
    if (JSON.stringify(next) !== saved) onSave(next)
  }

  const current = LISTS.find((l) => l.list === open) ?? LISTS[0]
  const bad = parseRuleText(text[open]).filter((p) => ruleProblem(p))

  return (
    <>
      <div className="rules__tabs" role="tablist" aria-label="Rule list">
        {LISTS.map(({ list, title }) => (
          <button key={list} type="button" role="tab" aria-selected={list === open} data-kind={list} className="rules__tab" onClick={() => setOpen(list)}>
            <span className="rules__dot" aria-hidden />
            {title}
            <span className="rules__count">{parseRuleText(text[list]).length}</span>
          </button>
        ))}
      </div>
      <div className="rules__body" role="tabpanel">
        <p className="rules__what">{current.what}</p>
        <textarea
          aria-label={current.aria}
          className="input rules__box"
          value={text[open]}
          spellCheck={false}
          placeholder={current.placeholder}
          onChange={(e) => setText({ ...text, [open]: e.target.value })}
          onBlur={save}
        />
        {bad.length > 0 && (
          <div className="rules__bad" role="alert">
            Not a valid regular expression, so it matches nothing: <code>{bad[0]}</code>
          </div>
        )}
        <div className="rules__foot">
          <span className="rules__hint">One pattern per line. Saved when you click away.</span>
        </div>
      </div>
    </>
  )
}

export function CommandRules(): JSX.Element {
  // The stored value is selected as it is and cleaned outside the selector: a selector that builds a new object each time never settles.
  const { general, projects, patchSettings } = useApp(useShallow((s) => ({ general: s.settings?.general, projects: s.projects, patchSettings: s.patchSettings })))
  const stored = general?.commandRules
  const rules = useMemo(() => normalizeRules(stored), [stored])

  const folders = useMemo(() => projects.filter((p) => p.folder).map((p) => ({ value: p.folder as string, label: p.name })), [projects])
  const [scope, setScope] = useState<'all' | 'project'>('all')
  const [folder, setFolder] = useState<string>('')
  const chosen = folders.some((f) => f.value === folder) ? folder : (folders[0]?.value ?? '')
  const projectStored = chosen ? general?.projectCommandRules?.[chosen.replace(/[\\/]+$/, '')] : undefined
  const projectRules = useMemo(() => normalizeRules(projectStored), [projectStored])
  const onProject = scope === 'project' && folders.length > 0

  return (
    <Section label="Command rules">
      <Card>
        <div className="rules__bar">
          <div className="row__body">
            <div className="row__title">Which commands run on their own</div>
            <div className="row__desc">
              Patterns for the shell commands the agent runs.
              <Details label="How patterns match">
                <p style={{ margin: '0 0 6px' }}>
                  <code>npm test</code> also covers <code>npm test --watch</code>; <code>npm run *</code> covers any script. A line between slashes is a regular expression, like{' '}
                  <code>/^git (push|reset)/</code>.
                </p>
                <p style={{ margin: '0 0 6px' }}>
                  A command that chains others (<code>&amp;&amp;</code>, <code>;</code>, <code>|</code>) runs on its own only if every part is allowed. One that writes to a file or hides another
                  command is always asked about, and so is what can’t be undone, like <code>sudo</code>.
                </p>
                <p style={{ margin: 0 }}>
                  Each command in a chain is checked, and so is what’s inside <code>$(…)</code>, backticks and <code>sh -c</code>. Rules read the command line; they can’t see what a script does
                  once it runs, so they aren’t a sandbox.
                </p>
              </Details>
            </div>
          </div>
          {folders.length > 0 && (
            <div className="rules__scope">
              <div className="rules__tabs" role="tablist" aria-label="Rules apply to">
                <button type="button" role="tab" className="rules__tab" aria-selected={!onProject} onClick={() => setScope('all')}>
                  Every project
                </button>
                <button type="button" role="tab" className="rules__tab" aria-selected={onProject} onClick={() => setScope('project')}>
                  One project
                </button>
              </div>
              {onProject && <Select<string> label="Project" value={chosen} options={folders} onChange={setFolder} width={180} />}
            </div>
          )}
        </div>
        {onProject ? (
          <RuleEditor key={chosen} rules={projectRules} onSave={(next) => void patchSettings({ general: { projectCommandRules: { [chosen.replace(/[\\/]+$/, '')]: next } } })} />
        ) : (
          <RuleEditor rules={rules} onSave={(next) => void patchSettings({ general: { commandRules: next } })} />
        )}
      </Card>
    </Section>
  )
}
