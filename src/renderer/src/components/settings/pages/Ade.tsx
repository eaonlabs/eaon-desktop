import { useEffect, useMemo, useState, type JSX } from 'react'
import { FolderSearch, Loader2 } from 'lucide-react'
import { useApp } from '../../../state/store'
import { useAdeSessions } from '../../code/sessionsStore'
import { AgentMark } from '../../code/terminal/TerminalWorkspace'
import { Card, Row, Section } from '../../ui'
import { ageLabel, folderName, homeRelative, type AdeImportCandidate } from '@shared/adeSessions'

const clean = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')


/**
 * Settings → ADE: bringing in the sessions Claude Code and Codex already have
 * on this computer, and where new sessions' worktrees go.
 */
export function AdePage(): JSX.Element {
  const [root, setRoot] = useState<{ path: string; home: string } | null>(null)
  const tidy = (path: string): string => homeRelative(path, root?.home)
  const [scan, setScan] = useState<'idle' | 'looking' | 'done'>('idle')
  const [found, setFound] = useState<AdeImportCandidate[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<number | null>(null)

  useEffect(() => {
    void window.api.ade.worktreesRoot().then(setRoot, () => setRoot(null))
  }, [])

  const look = async (): Promise<void> => {
    setScan('looking')
    setError(null)
    setImported(null)
    try {
      const list = await window.api.ade.importScan()
      setFound(list)
      // Everything not already in the ADE starts ticked: importing is the point of looking.
      setPicked(new Set(list.filter((c) => !c.already).map((c) => c.cwd)))
      setScan('done')
    } catch (e) {
      setError(clean(e))
      setScan('idle')
    }
  }

  const choosable = useMemo(() => found.filter((c) => !c.already), [found])

  const doImport = async (): Promise<void> => {
    setImporting(true)
    setError(null)
    try {
      const folders = choosable.filter((c) => picked.has(c.cwd)).map((c) => ({ cwd: c.cwd, at: c.conversations[0]?.touched ?? Date.now() }))
      const made = await window.api.ade.import(folders)
      setImported(made.length)
      await useAdeSessions.getState().load()
      setFound((list) => list.map((c) => (picked.has(c.cwd) ? { ...c, already: true } : c)))
      setPicked(new Set())
    } catch (e) {
      setError(clean(e))
    } finally {
      setImporting(false)
    }
  }

  const openAde = (): void => {
    const app = useApp.getState()
    const ade = app.workspaces.find((w) => w.kind === 'code')
    if (ade) app.setWorkspace(ade.id)
    app.setView('chat')
  }

  const now = Date.now()
  const count = choosable.filter((c) => picked.has(c.cwd)).length

  return (
    <>
      <h1 className="settings__h1">ADE</h1>
      <p className="settings__lede">Sessions in the ADE: a piece of work in a project, on a branch of its own, with the coding agents working on it.</p>

      <Section label="Import sessions">
        <Card>
          <Row
            title="Import sessions from Claude Code and Codex"
            description="Finds the conversations those CLIs have on this computer and adds a session for each folder they ran in, with its conversations listed under it. Nothing in Claude Code or Codex changes; clicking one reopens it."
          >
            <button type="button" className="btn btn--sm" onClick={() => void look()} disabled={scan === 'looking'}>
              {scan === 'looking' ? <Loader2 size={13} strokeWidth={2} className="spinner" /> : <FolderSearch size={13} strokeWidth={1.9} />}
              {scan === 'looking' ? 'Looking…' : scan === 'done' ? 'Look again' : 'Find sessions'}
            </button>
          </Row>
          {error && (
            <div className="row">
              <div className="row__body">
                <div className="row__desc ade-import__error" role="alert">
                  {error}
                </div>
              </div>
            </div>
          )}
          {scan === 'done' && found.length === 0 && (
            <div className="row">
              <div className="row__body">
                <div className="row__desc">No Claude Code or Codex conversations were found on this computer (in folders that still exist).</div>
              </div>
            </div>
          )}
          {found.length > 0 && (
            <div className="ade-import" role="group" aria-label="Folders with conversations">
              <div className="ade-import__bar">
                <span>
                  {found.length} {found.length === 1 ? 'folder' : 'folders'} · {found.reduce((n, c) => n + c.conversations.length, 0)} conversations
                </span>
                {choosable.length > 0 && (
                  <button
                    type="button"
                    className="ade-import__toggle"
                    onClick={() => setPicked(count === choosable.length ? new Set() : new Set(choosable.map((c) => c.cwd)))}
                  >
                    {count === choosable.length ? 'Select none' : 'Select all'}
                  </button>
                )}
              </div>
              <ul className="ade-import__list">
                {found.map((candidate) => {
                  const claude = candidate.conversations.filter((c) => c.agent === 'claude').length
                  const codex = candidate.conversations.filter((c) => c.agent === 'codex').length
                  const latest = candidate.conversations[0]
                  return (
                    <li key={candidate.cwd}>
                      <label className="ade-import__item" data-already={candidate.already || undefined}>
                        <input
                          type="checkbox"
                          disabled={candidate.already}
                          checked={candidate.already || picked.has(candidate.cwd)}
                          onChange={(e) =>
                            setPicked((set) => {
                              const next = new Set(set)
                              if (e.target.checked) next.add(candidate.cwd)
                              else next.delete(candidate.cwd)
                              return next
                            })
                          }
                        />
                        <span className="ade-import__text">
                          <span className="ade-import__name">
                            {folderName(candidate.cwd)}
                            {candidate.project !== candidate.cwd && <span className="ade-import__in"> in {folderName(candidate.project)}</span>}
                          </span>
                          <span className="ade-import__meta">
                            {tidy(candidate.cwd)}
                            {candidate.branch ? ` · ${candidate.branch}` : ''}
                          </span>
                          {latest && <span className="ade-import__latest">{latest.title}</span>}
                        </span>
                        <span className="ade-import__counts">
                          {claude > 0 && (
                            <span title={`${claude} Claude Code`}>
                              <AgentMark agent="claude" size={13} />
                              {claude}
                            </span>
                          )}
                          {codex > 0 && (
                            <span title={`${codex} Codex`}>
                              <AgentMark agent="codex" size={13} />
                              {codex}
                            </span>
                          )}
                          <span className="ade-import__age">{candidate.already ? 'In the ADE' : latest ? ageLabel(latest.touched, now) : ''}</span>
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
              <div className="ade-import__foot">
                {imported !== null && (
                  <span className="ade-import__done" role="status">
                    {imported === 0 ? 'Nothing new to import.' : `Imported ${imported} ${imported === 1 ? 'session' : 'sessions'}.`}
                    {imported > 0 && (
                      <button type="button" className="ade-import__toggle" onClick={openAde}>
                        Open the ADE
                      </button>
                    )}
                  </span>
                )}
                <button type="button" className="btn btn--primary btn--sm" disabled={count === 0 || importing} onClick={() => void doImport()}>
                  {importing ? 'Importing…' : count === 0 ? 'Import' : `Import ${count} ${count === 1 ? 'session' : 'sessions'}`}
                </button>
              </div>
            </div>
          )}
        </Card>
      </Section>

      <Section label="New sessions">
        <Card>
          <Row
            title="Worktrees"
            description={`A new session in a git project gets a branch of its own, checked out in its own folder${root ? ` under ${tidy(root.path)}` : ''}, so agents in different sessions never edit the same files. Your project folder isn’t touched.`}
          />
        </Card>
      </Section>
    </>
  )
}
