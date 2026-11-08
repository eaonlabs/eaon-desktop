import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../../state/store'
import { Card, Section } from '../../ui'
import { normalizeRules, parseRuleText } from '@shared/commandRules'

/**
 * Settings → General → Command rules: the shell commands the agent may run
 * without asking, and the ones it may never run. One pattern a line
 * (shared/commandRules.ts says how they match).
 */
export function CommandRules(): JSX.Element {
  // The stored value is selected as it is and cleaned outside the selector: a selector that builds a new object each time never settles.
  const stored = useApp((s) => s.settings?.general.commandRules)
  const patchSettings = useApp((s) => s.patchSettings)
  const rules = useMemo(() => normalizeRules(stored), [stored])
  const [allow, setAllow] = useState(rules.allow.join('\n'))
  const [deny, setDeny] = useState(rules.deny.join('\n'))
  // Settings changed elsewhere (the CLI, another window) show here too.
  const saved = JSON.stringify(rules)
  useEffect(() => {
    const now = JSON.parse(saved) as typeof rules
    setAllow(now.allow.join('\n'))
    setDeny(now.deny.join('\n'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved])

  const save = (next: { allow?: string; deny?: string }): void => {
    const a = parseRuleText(next.allow ?? allow)
    const d = parseRuleText(next.deny ?? deny)
    if (JSON.stringify({ allow: a, deny: d }) === saved) return
    void patchSettings({ general: { commandRules: { allow: a, deny: d } } })
  }

  return (
    <Section label="Command rules">
      <Card>
        <div className="row row--stack">
          <div className="row__body">
            <div className="row__title">Always allow</div>
            <div className="row__desc">
              Commands that run without asking, one pattern a line. <code>npm test</code> also covers <code>npm test --watch</code>; <code>npm run *</code> covers any script. A command that
              chains others (<code>&amp;&amp;</code>, <code>;</code>, <code>|</code>) runs only if every part is allowed, and one that writes to a file or hides another command is always
              asked about. What can’t be undone, like <code>sudo</code>, still asks.
            </div>
          </div>
          <textarea
            aria-label="Commands to always allow"
            className="input"
            style={{ width: '100%', minHeight: 84, fontFamily: 'var(--font-mono)', fontSize: 13 }}
            value={allow}
            spellCheck={false}
            placeholder={'npm test\nnpm run *\ngit status'}
            onChange={(e) => setAllow(e.target.value)}
            onBlur={() => save({ allow })}
          />
        </div>
        <div className="row row--stack">
          <div className="row__body">
            <div className="row__title">Never allow</div>
            <div className="row__desc">
              Commands that never run, in any mode, for workers and scheduled tasks too: the agent is told why and goes another way. Each command in a chain is checked, and so is
              what’s inside <code>$(…)</code>, backticks and <code>sh -c</code>. This reads the command line; it can’t see what a script does once it runs, so it isn’t a sandbox.
            </div>
          </div>
          <textarea
            aria-label="Commands to never allow"
            className="input"
            style={{ width: '100%', minHeight: 84, fontFamily: 'var(--font-mono)', fontSize: 13 }}
            value={deny}
            spellCheck={false}
            placeholder={'git push *\nrm -rf *\ncat .env*'}
            onChange={(e) => setDeny(e.target.value)}
            onBlur={() => save({ deny })}
          />
        </div>
      </Card>
    </Section>
  )
}
