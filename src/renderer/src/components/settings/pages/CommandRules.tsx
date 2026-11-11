import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { Card, Section, Select } from '../../ui'
import { normalizeRules, parseRuleText, ruleProblem, type CommandRules as Rules, type RuleList } from '@shared/commandRules'

/**
 * Settings → General → Command rules: the shell commands the agent may run
 * without asking, the ones it always asks about and the ones it may never
 * run, for every project and for one project's folder. One pattern a line:
 * words with "*" for anything, or a /regular expression/
 * (shared/commandRules.ts says how they match).
 */

const LISTS: { list: RuleList; title: string; aria: string; placeholder: string; desc: JSX.Element }[] = [
  {
    list: 'allow',
    title: 'Always allow',
    aria: 'Commands to always allow',
    placeholder: 'npm test\nnpm run *\ngit status',
    desc: (
      <>
        Commands that run without asking, one pattern a line. <code>npm test</code> also covers <code>npm test --watch</code>; <code>npm run *</code> covers any script. A command that
        chains others (<code>&amp;&amp;</code>, <code>;</code>, <code>|</code>) runs only if every part is allowed, and one that writes to a file or hides another command is always
        asked about. What can’t be undone, like <code>sudo</code>, still asks.
      </>
    )
  },
  {
    list: 'ask',
    title: 'Always ask',
    aria: 'Commands to always ask about',
    placeholder: 'git push *\n/^docker (rm|rmi|system prune)/',
    desc: (
      <>
        Commands that stop and ask every time, in Ask, Auto and Full access, and that a worker with nobody to ask doesn’t run. A line between slashes is a regular expression, like{' '}
        <code>/^git (push|reset)/</code>.
      </>
    )
  },
  {
    list: 'deny',
    title: 'Never allow',
    aria: 'Commands to never allow',
    placeholder: 'rm -rf *\ncat .env*\n/curl .*\\| *sh/',
    desc: (
      <>
        Commands that never run, in any mode, for workers and scheduled tasks too: the agent is told why and goes another way. Each command in a chain is checked, and so is what’s
        inside <code>$(…)</code>, backticks and <code>sh -c</code>. This reads the command line; it can’t see what a script does once it runs, so it isn’t a sandbox. It beats both lists
        above.
      </>
    )
  }
]

/** The three boxes for one set of rules; saves a box when it loses focus. */
function RuleBoxes({ rules, onSave }: { rules: Rules; onSave: (next: Rules) => void }): JSX.Element {
  const saved = JSON.stringify(rules)
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

  return (
    <>
      {LISTS.map(({ list, title, aria, placeholder, desc }) => {
        const bad = parseRuleText(text[list]).filter((p) => ruleProblem(p))
        return (
          <div className="row row--stack" key={list}>
            <div className="row__body">
              <div className="row__title">{title}</div>
              <div className="row__desc">{desc}</div>
            </div>
            <textarea
              aria-label={aria}
              className="input"
              style={{ width: '100%', minHeight: 84, fontFamily: 'var(--font-mono)', fontSize: 13 }}
              value={text[list]}
              spellCheck={false}
              placeholder={placeholder}
              onChange={(e) => setText({ ...text, [list]: e.target.value })}
              onBlur={save}
            />
            {bad.length > 0 && (
              <div className="row__desc" role="alert">
                Not a valid regular expression, so it matches nothing: <code>{bad[0]}</code>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

export function CommandRules(): JSX.Element {
  // The stored value is selected as it is and cleaned outside the selector: a selector that builds a new object each time never settles.
  const { general, projects, patchSettings } = useApp(useShallow((s) => ({ general: s.settings?.general, projects: s.projects, patchSettings: s.patchSettings })))
  const stored = general?.commandRules
  const rules = useMemo(() => normalizeRules(stored), [stored])

  const folders = useMemo(() => projects.filter((p) => p.folder).map((p) => ({ value: p.folder as string, label: p.name })), [projects])
  const [folder, setFolder] = useState<string>('')
  const chosen = folders.some((f) => f.value === folder) ? folder : (folders[0]?.value ?? '')
  const projectStored = chosen ? general?.projectCommandRules?.[chosen.replace(/[\\/]+$/, '')] : undefined
  const projectRules = useMemo(() => normalizeRules(projectStored), [projectStored])

  return (
    <>
      <Section label="Command rules">
        <Card>
          <RuleBoxes rules={rules} onSave={(next) => void patchSettings({ general: { commandRules: next } })} />
        </Card>
      </Section>
      {folders.length > 0 && (
        <Section label="Command rules for one project">
          <Card>
            <div className="row">
              <div className="row__body">
                <div className="row__title">Project</div>
                <div className="row__desc">These rules add to the ones above while the agent works in this project’s folder. “Always allow” on a question can save here too.</div>
              </div>
              <Select<string> label="Project" value={chosen} options={folders} onChange={setFolder} width={220} />
            </div>
            <RuleBoxes key={chosen} rules={projectRules} onSave={(next) => void patchSettings({ general: { projectCommandRules: { [chosen.replace(/[\\/]+$/, '')]: next } } })} />
          </Card>
        </Section>
      )}
    </>
  )
}
