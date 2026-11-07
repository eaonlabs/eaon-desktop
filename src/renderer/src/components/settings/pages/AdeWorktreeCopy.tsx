import { useEffect, useState, type JSX } from 'react'
import { Card, Row, Section, Switch } from '../../ui'
import { DEFAULT_COPY_PATTERNS, parsePatterns, type WorktreeCopySettings } from '@shared/worktreeCopy'

/**
 * Settings → ADE → Files for new worktrees: which of a project's ignored files
 * (.env…) the New session dialog offers to copy into a session's new folder.
 * It is always a choice in that dialog, with the files it would copy listed;
 * this is where the patterns are kept and whether the box starts ticked.
 */
export function WorktreeCopySection(): JSX.Element {
  const [settings, setSettings] = useState<WorktreeCopySettings | null>(null)
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void window.api.adeTools.copySettings().then(
      (loaded) => {
        setSettings(loaded)
        setText(loaded.patterns.join('\n'))
      },
      () => setFailed(true)
    )
  }, [])

  const save = (next: WorktreeCopySettings): void => {
    setSettings(next)
    void window.api.adeTools.saveCopySettings(next).then(setSettings, () => setFailed(true))
  }

  return (
    <Section label="Files for new worktrees">
      <Card>
        <Row
          title="Copy ignored files into a new worktree"
          description="A new worktree is a fresh checkout, so it has none of the files git ignores, and an agent can’t run the app without its .env. The New session dialog lists the matching files and offers to copy them. Turn this on to have that box ticked."
        >
          <Switch label="Tick the copy box by default" checked={settings?.enabled ?? false} disabled={!settings} onChange={(enabled) => settings && save({ ...settings, enabled })} />
        </Row>
        <div className="row row--stack">
          <div className="row__body">
            <div className="row__title">Which files</div>
            <div className="row__desc">
              One pattern per line, written as in a .gitignore: <code>.env.*</code> at any depth, <code>config/*.local.json</code> from the project’s root, <code>secrets/</code> for a folder.
              Only files git ignores are copied, never into a file that is there, and never from node_modules or other dependency and build folders, or past 1 MB a file.
            </div>
          </div>
          <textarea
            aria-label="Files to copy into new worktrees"
            className="input"
            style={{ width: '100%', minHeight: 84, fontFamily: 'var(--font-mono)', fontSize: 13 }}
            value={text}
            spellCheck={false}
            disabled={!settings}
            placeholder={DEFAULT_COPY_PATTERNS.join('\n')}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => settings && save({ ...settings, patterns: parsePatterns(text) })}
          />
          {failed && (
            <div className="row__desc" role="alert">
              Eaon couldn’t save this. Try again.
            </div>
          )}
        </div>
      </Card>
    </Section>
  )
}
