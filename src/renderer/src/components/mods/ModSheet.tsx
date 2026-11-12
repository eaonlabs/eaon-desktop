import { useState, type JSX } from 'react'
import { BadgeCheck, Code2, Eye, KeyRound, ListPlus, TriangleAlert } from 'lucide-react'
import { MOD_CATEGORIES, SOUND_EVENTS, type ModAccessRow, type ModInfo, type ModManifest } from '@shared/mods'
import { useMods } from '../../state/mods'
import { ConfirmDialog, Modal, Switch } from '../ui'
import { notify } from '../Notice'
import { ModPreview } from './ModPreview'
import { errorText } from '../../lib/errors'

/**
 * One mod up close: what it adds, where each part shows up, and exactly
 * what it can touch (shared/mods.ts `modAccess`). Installing anything that
 * runs code or reaches past the app's look happens here, after reading
 * that list.
 *
 * `token` is set for a mod read from a folder, a file or a link and not yet
 * installed: Install puts that copy in place, the one reviewed.
 */

export interface SheetState {
  info: ModInfo
  token?: string
}

const LEVELS: Record<ModAccessRow['level'], { icon: JSX.Element; label: string }> = {
  code: { icon: <Code2 size={14} strokeWidth={2} />, label: 'Runs code' },
  access: { icon: <KeyRound size={14} strokeWidth={2} />, label: 'Reaches further' },
  adds: { icon: <ListPlus size={14} strokeWidth={2} />, label: 'Adds' },
  look: { icon: <Eye size={14} strokeWidth={2} />, label: 'Looks and sounds' }
}

/** Where each part of a mod shows up once it's on. */
export function whereItShows(manifest: ModManifest): string[] {
  const c = manifest.contributes
  const out: string[] = []
  if (c.appThemes) out.push('Settings → Appearance → Color theme, under From mods')
  if (c.terminalThemes) out.push('Type /theme in an ADE terminal, or Settings → ADE → Terminal theme')
  if (c.commands) {
    const workersOnly = c.commands.every((cmd) => cmd.where && !cmd.where.includes('chat'))
    out.push(`Type / in ${workersOnly ? 'a worker’s chat' : 'Chat’s message box'}: ${c.commands.map((cmd) => `/${cmd.name}`).join(', ')}`)
  }
  if (c.instructions) out.push('Every Chat reply, from your next message')
  if (c.snippets) out.push(`In the code editor, type a prefix and press Tab: ${c.snippets.map((s) => s.prefix).join(', ')}`)
  if (c.languages) out.push(`The code editor and code blocks in replies: ${c.languages.map((l) => l.aliases.slice(0, 2).map((a) => `.${a}`).join(' ')).join(', ')}`)
  if (c.panels) out.push(`The dock’s + menu, in Chat and the ADE: ${c.panels.map((p) => p.title).join(', ')}`)
  if (c.workerTemplates) out.push('Workers → New worker, under Suggestions')
  if (c.sessionPresets) out.push('ADE → New session, under “Or a preset from your mods”')
  if (c.widgets) out.push('The ADE’s top bar')
  if (c.sounds) out.push(`Plays when ${SOUND_EVENTS.filter((e) => c.sounds?.[e.id]).map((e) => e.label).join(', or when ')}`)
  if (c.tools) out.push('Agents in Chat (with tools on) and Workers call these when a question needs them')
  if (c.claudePlugin) out.push('Claude Code panes the ADE starts from now on. Restart a running one to load it.')
  if (c.codex) out.push('Codex panes the ADE starts from now on. Restart a running one to load it.')
  return out
}

function sourceText(info: ModInfo): string {
  const source = info.source
  if (info.official || source?.kind === 'bundled') return 'Bundled with Eaon'
  if (source?.kind === 'folder') return `From the folder ${source.path}`
  if (source?.kind === 'file') return `From the file ${source.path}`
  if (source?.kind === 'url') return `From ${source.url}`
  if (info.from) return `Listed by ${new URL(info.from).hostname}`
  return ''
}

export function ModSheet({ state, onClose, onChange }: { state: SheetState | null; onClose: () => void; onChange: (state: SheetState | null) => void }): JSX.Element | null {
  const apply = useMods((s) => s.apply)
  const list = useMods((s) => s.list)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  if (!state) return null

  // An installed mod is shown as it is now, so toggling it here shows at once.
  const live = state.token ? state.info : (list?.mods.find((m) => m.manifest.id === state.info.manifest.id) ?? state.info)
  const { manifest } = live
  const category = MOD_CATEGORIES.find((c) => c.id === manifest.category)
  const indexedOnly = !live.installed && !live.official && !state.token

  const close = (): void => {
    if (state.token) void window.api.mods.discardStaged(state.token)
    onClose()
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const install = (): Promise<void> =>
    run(async () => {
      if (state.token) {
        apply(await window.api.mods.installStaged(state.token))
        onChange(null)
      } else if (live.official) {
        apply(await window.api.mods.installBundled(manifest.id))
      }
      notify(`${manifest.name} is installed`)
    })

  // A mod a source lists is read in full before it can be installed: the list's summary isn't what installs.
  const readIndexed = (): Promise<void> =>
    run(async () => {
      const result = await window.api.mods.inspect({ kind: 'indexed', id: manifest.id })
      if (!result.ok) throw new Error(result.error ?? 'Couldn’t read that mod.')
      onChange({ info: result.info, token: result.token })
    })

  const update = (): Promise<void> =>
    live.source?.kind === 'bundled'
      ? run(async () => {
          apply(await window.api.mods.installBundled(manifest.id))
          notify(`${manifest.name} is up to date`)
        })
      : readIndexed()

  return (
    <>
      <Modal
        open
        onClose={() => !busy && close()}
        title={manifest.name}
        width={640}
        actions={
          <>
            {live.installed && !state.token && (
              <button type="button" className="btn btn--ghost mods-sheet__remove" disabled={busy} onClick={() => setConfirmRemove(true)}>
                Uninstall
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={close} disabled={busy}>
              {live.installed && !state.token ? 'Done' : 'Cancel'}
            </button>
            {live.installed && !state.token ? (
              live.update && (
                <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void update()}>
                  Review update to {live.update}
                </button>
              )
            ) : indexedOnly ? (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void readIndexed()}>
                {busy ? 'Reading…' : 'Review & install'}
              </button>
            ) : (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void install()}>
                {busy ? 'Installing…' : state.info.installed ? 'Replace and install' : 'Install'}
              </button>
            )}
          </>
        }
      >
        <div className="mods-sheet">
          <ModPreview manifest={manifest} claude={live.claude} large />
          <div className="mods-sheet__head">
            <div>
              <div className="mods-sheet__name">
                {manifest.publisher}
                {live.official && (
                  <span className="mod-card__verified" title="Made by Eaon and bundled with the app">
                    <BadgeCheck size={14} strokeWidth={2} />
                  </span>
                )}
                <span className="mods-sheet__dot">·</span>v{manifest.version}
                <span className="mods-sheet__dot">·</span>
                {category?.label}
              </div>
              <div className="mods-sheet__source">{sourceText(live)}</div>
            </div>
            {live.installed && !state.token && <Switch checked={live.enabled} onChange={(on) => void window.api.mods.setEnabled(manifest.id, on).then(apply)} label="On" />}
          </div>
          <p className="mods-sheet__desc">{manifest.description}</p>

          {!live.official && (
            <p className="mods-sheet__caution">
              <TriangleAlert size={14} strokeWidth={2} aria-hidden />
              Eaon hasn’t reviewed this mod. Install it only if you trust where it came from.
            </p>
          )}
          {indexedOnly && <p className="mods-sheet__note">This is the source’s summary. Review & install reads the whole mod and shows what it can touch.</p>}

          <h3 className="mods-sheet__h">What it can touch</h3>
          <ul className="mods-access">
            {live.access.map((row, i) => (
              <li key={i} className="mods-access__row" data-level={row.level}>
                <span className="mods-access__icon" title={LEVELS[row.level].label}>
                  {LEVELS[row.level].icon}
                </span>
                <span className="mods-access__body">
                  <span className="mods-access__text">{row.text}</span>
                  {row.detail && <span className="mods-access__detail" data-code={row.mono || undefined}>{row.detail}</span>}
                </span>
              </li>
            ))}
          </ul>

          <h3 className="mods-sheet__h">Where it shows up</h3>
          <ul className="mods-where">
            {whereItShows(manifest).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {manifest.homepage && (
            <button type="button" className="settings-link mods-sheet__link" onClick={() => void window.api.app.openExternal(manifest.homepage!)}>
              {manifest.homepage}
            </button>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmRemove}
        title={`Uninstall ${manifest.name}?`}
        confirmLabel="Uninstall"
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          void run(async () => {
            apply(await window.api.mods.uninstall(manifest.id))
            notify(`${manifest.name} is uninstalled`)
            onClose()
          })
        }}
      >
        Its files and anything its panels saved are removed. Claude Code or Codex panes already running keep it until they restart.
      </ConfirmDialog>
    </>
  )
}
