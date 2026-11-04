import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  AudioLines,
  BadgeCheck,
  Braces,
  ChevronDown,
  Ellipsis,
  FileJson,
  FolderOpen,
  LayoutGrid,
  Link,
  Palette,
  PanelRight,
  Plug,
  Plus,
  RefreshCw,
  Rss,
  ScrollText,
  SquareSlash,
  SquareTerminal,
  TerminalSquare,
  TriangleAlert,
  Wrench,
  X
} from 'lucide-react'
import { MOD_CATEGORIES, modSurfaces, needsReview, type ModCategory, type ModInfo } from '@shared/mods'
import { useMods } from '../../state/mods'
import { formatShortcut, SHORTCUTS } from '../../lib/keys'
import { MenuItem, MenuSeparator, Modal, Popover, SearchField, Segmented, Switch, useDisclosure } from '../ui'
import { notify } from '../Notice'
import { errorText } from '../../lib/errors'
import { WorkersGlyph } from '../ModeSwitch'
import { PluginCatalog } from '../plugins/PluginCatalog'
import { ModPreview } from './ModPreview'
import { ModSheet, type SheetState } from './ModSheet'
import './mods.css'

/**
 * The mods marketplace: Eaon's own mods (bundled, so it works offline),
 * those listed by the mod sources the user added, and any installed from a
 * folder, a file or a link. Connectors, the MCP plugins, are one of its
 * categories and keep their own page and behaviour.
 *
 * In Settings → Mods and in the Plugins page's Mods tab.
 */

const ICON = { size: 14, strokeWidth: 1.9 } as const

export const CATEGORY_ICONS: Record<ModCategory, ReactNode> = {
  themes: <Palette {...ICON} />,
  commands: <SquareSlash {...ICON} />,
  instructions: <ScrollText {...ICON} />,
  editor: <Braces {...ICON} />,
  panels: <PanelRight {...ICON} />,
  workers: <WorkersGlyph {...ICON} />,
  tools: <Wrench {...ICON} />,
  ade: <SquareTerminal {...ICON} />,
  cli: <TerminalSquare {...ICON} />,
  sounds: <AudioLines {...ICON} />
}

/** By category, in the chips' order, then by name. */
const sortMods = (list: ModInfo[]): ModInfo[] => {
  const rank = (m: ModInfo): number => MOD_CATEGORIES.findIndex((c) => c.id === m.manifest.category)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.manifest.name.localeCompare(b.manifest.name))
}

const ALPHA_KEY = 'eaon.mods.alphaNoticeHidden'
const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

type Filter = 'all' | 'installed' | 'available'

export function ModsPage(): JSX.Element {
  const ensure = useMods((s) => s.ensure)
  const list = useMods((s) => s.list)
  const apply = useMods((s) => s.apply)
  useEffect(() => ensure(), [ensure])

  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ModCategory | 'connectors' | null>(null)
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [link, setLink] = useState<'install' | 'source' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [alphaHidden, setAlphaHidden] = useState(() => readFlag(ALPHA_KEY))
  const addAnchor = useRef<HTMLButtonElement>(null)
  const moreAnchor = useRef<HTMLButtonElement>(null)
  const addMenu = useDisclosure()
  const moreMenu = useDisclosure()
  const mac = window.api.platform === 'darwin'
  const shortcut = SHORTCUTS.find((s) => s.id === 'mods')

  const mods = useMemo(() => list?.mods ?? [], [list])
  const installedCount = mods.filter((m) => m.installed).length
  const q = query.trim().toLowerCase()
  const matches = (m: ModInfo): boolean =>
    (filter === 'all' || (filter === 'installed' ? m.installed : !m.installed)) &&
    (!category || category === 'connectors' || m.manifest.category === category) &&
    (!q || `${m.manifest.name} ${m.manifest.description} ${m.manifest.publisher} ${m.manifest.category} ${modSurfaces(m.manifest).join(' ')}`.toLowerCase().includes(q))

  const sections = useMemo(() => {
    const out: { key: string; title: ReactNode; note?: string; all: ModInfo[] }[] = []
    const official = sortMods(mods.filter((m) => m.official))
    if (official.length) out.push({ key: 'official', title: <>Eaon mods <span className="mods-section__verified"><BadgeCheck size={13} strokeWidth={2} /> verified</span></>, all: official })
    for (const source of list?.sources ?? []) {
      const from = sortMods(mods.filter((m) => !m.official && m.from === source.url))
      out.push({ key: source.url, title: source.name, note: `${new URL(source.url).hostname} · not reviewed by Eaon`, all: from })
    }
    const local = sortMods(mods.filter((m) => !m.official && !(list?.sources ?? []).some((s) => s.url === m.from)))
    if (local.length) out.push({ key: 'local', title: 'Installed from a folder, file or link', note: 'Not reviewed by Eaon', all: local })
    return out
  }, [mods, list])

  const counts = useMemo(() => {
    const byCategory = new Map<ModCategory, number>()
    for (const m of mods) byCategory.set(m.manifest.category, (byCategory.get(m.manifest.category) ?? 0) + 1)
    return byCategory
  }, [mods])

  const install = async (info: ModInfo): Promise<void> => {
    // Eaon's own mods that touch nothing beyond the look or a list install from the card; the rest are reviewed.
    if (!info.official || needsReview(info.access)) {
      setSheet({ info })
      return
    }
    setBusy(info.manifest.id)
    try {
      apply(await window.api.mods.installBundled(info.manifest.id))
      notify(`${info.manifest.name} is installed`)
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const setEnabled = async (info: ModInfo, enabled: boolean): Promise<void> => {
    try {
      apply(await window.api.mods.setEnabled(info.manifest.id, enabled))
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  const openLocal = async (kind: 'folder' | 'file'): Promise<void> => {
    addMenu.close()
    const result = await window.api.mods.inspect({ kind })
    if (result.ok) setSheet({ info: result.info, token: result.token })
    else if (!result.cancelled) notify(result.error ?? 'Couldn’t read that mod.', 'error')
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      apply(await window.api.mods.refresh())
    } finally {
      setRefreshing(false)
    }
  }

  const showConnectors = category === 'connectors'

  return (
    <div className="mods">
      <header className="mods__head">
        <div className="mods__title">
          <h1 className="settings__h1">
            Mods <span className="mods__alpha">Alpha</span>
          </h1>
          <p className="settings__lede">
            Themes, commands, panels, worker templates and add-ons for Chat, Workers, the ADE and the coding CLIs Eaon starts.
            {shortcut && <kbd className="mods__kbd">{formatShortcut(shortcut, mac)}</kbd>}
          </p>
        </div>
        <div className="mods__actions">
          <button ref={addAnchor} type="button" className="btn btn--primary" onClick={addMenu.toggle}>
            <Plus size={14} strokeWidth={2} />
            Add mod
            <ChevronDown size={13} strokeWidth={2} />
          </button>
          <Popover anchor={addAnchor} open={addMenu.open} onClose={addMenu.close} placement="bottom-end" width={250}>
            <MenuItem icon={<FolderOpen size={15} strokeWidth={1.8} />} title="From a folder…" description="A folder with a mod.json" onClick={() => void openLocal('folder')} />
            <MenuItem icon={<FileJson size={15} strokeWidth={1.8} />} title="From a file…" description="A packed mod (.json)" onClick={() => void openLocal('file')} />
            <MenuItem
              icon={<Link size={15} strokeWidth={1.8} />}
              title="From a link…"
              description="An https link to a packed mod"
              onClick={() => {
                addMenu.close()
                setLink('install')
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Rss size={15} strokeWidth={1.8} />}
              title="Add a mod source…"
              description="An index that lists mods"
              onClick={() => {
                addMenu.close()
                setLink('source')
              }}
            />
          </Popover>
          <button ref={moreAnchor} type="button" className="icon-btn" aria-label="More" title="More" onClick={moreMenu.toggle}>
            <Ellipsis size={16} strokeWidth={1.9} />
          </button>
          <Popover anchor={moreAnchor} open={moreMenu.open} onClose={moreMenu.close} placement="bottom-end" width={240}>
            <MenuItem
              icon={<FolderOpen size={15} strokeWidth={1.8} />}
              title="Show the mods folder"
              onClick={() => {
                moreMenu.close()
                void window.api.mods.openFolder()
              }}
            />
            <MenuItem
              icon={<Braces size={15} strokeWidth={1.8} />}
              title="How to make a mod"
              onClick={() => {
                moreMenu.close()
                void window.api.app.openExternal('https://github.com/eaonlabs/eaon-desktop/blob/main/docs/mods.md')
              }}
            />
            {(list?.sources.length ?? 0) > 0 && (
              <>
                <MenuSeparator />
                {list!.sources.map((source) => (
                  <MenuItem
                    key={source.url}
                    icon={<X size={15} strokeWidth={1.8} />}
                    title={`Remove ${source.name}`}
                    description={source.error ?? `${source.count ?? 0} mods`}
                    onClick={() => {
                      moreMenu.close()
                      void window.api.mods.removeSource(source.url).then(apply)
                    }}
                  />
                ))}
              </>
            )}
          </Popover>
        </div>
      </header>

      {!alphaHidden && (
        <div className="mods__banner" role="note">
          <TriangleAlert size={15} strokeWidth={2} aria-hidden />
          <span>
            <b>Alpha:</b> the mod format may still change. Mods you install keep working until you remove them.
          </span>
          <button
            type="button"
            className="mods__banner-close"
            aria-label="Hide this note"
            onClick={() => {
              setAlphaHidden(true)
              try {
                localStorage.setItem(ALPHA_KEY, '1')
              } catch {
                /* shown again next time */
              }
            }}
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="mods__filters">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'installed', label: `Installed (${installedCount})` },
            { value: 'available', label: 'Not installed' }
          ]}
        />
        <div className="mods__search">
          <SearchField value={query} onChange={setQuery} placeholder="Search mods" variant="sm" />
        </div>
        <button type="button" className="icon-btn" aria-label="Check mod sources again" title="Check mod sources again" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={15} strokeWidth={1.9} data-spin={refreshing || undefined} />
        </button>
      </div>

      <div className="mods__chips" role="toolbar" aria-label="Categories">
        <button type="button" className="mods-chip" data-on={category === null || undefined} onClick={() => setCategory(null)}>
          <LayoutGrid {...ICON} />
          All
        </button>
        {MOD_CATEGORIES.filter((c) => counts.get(c.id)).map((c) => (
          <button key={c.id} type="button" className="mods-chip" data-on={category === c.id || undefined} onClick={() => setCategory(category === c.id ? null : c.id)}>
            {CATEGORY_ICONS[c.id]}
            {c.label}
            <span className="mods-chip__count">{counts.get(c.id)}</span>
          </button>
        ))}
        <button type="button" className="mods-chip" data-on={showConnectors || undefined} onClick={() => setCategory(showConnectors ? null : 'connectors')}>
          <Plug {...ICON} />
          Connectors
        </button>
      </div>

      {showConnectors ? (
        <div className="mods__connectors">
          <p className="mods__note">Connectors are MCP servers Chat and Workers can use once connected. They work as they do on the Plugins page.</p>
          <PluginCatalog embedded />
        </div>
      ) : !list ? (
        <div className="mods__empty">Loading mods…</div>
      ) : (
        sections.map((section) => {
          const shown = section.all.filter(matches)
          return (
            <section key={section.key} className="mods-section">
              <div className="mods-section__head">
                <span className="mods-section__title">{section.title}</span>
                {section.note && <span className="mods-section__note">{section.note}</span>}
                <span className="mods-section__count">
                  {shown.length} of {section.all.length}
                </span>
              </div>
              {shown.length === 0 ? (
                <div className="mods__empty">{section.all.length === 0 ? 'This source lists no mods yet.' : 'No mods here match.'}</div>
              ) : (
                <div className="mods-grid">
                  {shown.map((info) => (
                    <ModCard key={info.manifest.id} info={info} busy={busy === info.manifest.id} onOpen={() => setSheet({ info })} onInstall={() => void install(info)} onToggle={(on) => void setEnabled(info, on)} />
                  ))}
                </div>
              )}
            </section>
          )
        })
      )}

      <ModSheet state={sheet} onClose={() => setSheet(null)} onChange={setSheet} />
      <LinkDialog mode={link} onClose={() => setLink(null)} onInspected={(info, token) => setSheet({ info, token })} />
    </div>
  )
}

function ModCard({ info, busy, onOpen, onInstall, onToggle }: { info: ModInfo; busy: boolean; onOpen: () => void; onInstall: () => void; onToggle: (on: boolean) => void }): JSX.Element {
  const { manifest } = info
  const review = !info.official || needsReview(info.access)
  const category = MOD_CATEGORIES.find((c) => c.id === manifest.category)
  return (
    <article className="mod-card" data-installed={info.installed || undefined} data-off={(info.installed && !info.enabled) || undefined}>
      <button type="button" className="mod-card__open" onClick={onOpen} aria-label={`${manifest.name}: details`}>
        <ModPreview manifest={manifest} claude={info.claude} />
      </button>
      <div className="mod-card__body">
        <div className="mod-card__name">
          <button type="button" className="mod-card__title" onClick={onOpen}>
            {manifest.name}
          </button>
          {info.official && (
            <span className="mod-card__verified" title="Made by Eaon and bundled with the app">
              <BadgeCheck size={14} strokeWidth={2} />
            </span>
          )}
        </div>
        <div className="mod-card__meta">
          {manifest.publisher} · v{manifest.version}
          {info.update && <span className="mod-card__update"> · update {info.update}</span>}
        </div>
        <p className="mod-card__desc">{manifest.description}</p>
        <div className="mod-card__foot">
          <span className="mod-card__tag">
            {CATEGORY_ICONS[manifest.category]}
            {category?.label}
          </span>
          {info.installed ? (
            <Switch checked={info.enabled} onChange={onToggle} label={`${manifest.name} on`} />
          ) : (
            <button type="button" className={review ? 'btn btn--sm' : 'btn btn--sm btn--primary'} disabled={busy} onClick={onInstall}>
              {busy ? 'Installing…' : review ? 'Review & install' : 'Install'}
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

/** A link to install a packed mod from, or a mod source to add. */
function LinkDialog({ mode, onClose, onInspected }: { mode: 'install' | 'source' | null; onClose: () => void; onInspected: (info: ModInfo, token: string) => void }): JSX.Element {
  const apply = useMods((s) => s.apply)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!mode) return
    setUrl('')
    setError(null)
    setBusy(false)
  }, [mode])
  const go = async (): Promise<void> => {
    if (!url.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'source') {
        const result = await window.api.mods.addSource(url.trim())
        if (!result.ok) return setError(result.error)
        apply(result.list)
        notify('Mod source added')
        onClose()
      } else {
        const result = await window.api.mods.inspect({ kind: 'url', url: url.trim() })
        if (!result.ok) return setError(result.error ?? 'Couldn’t read that mod.')
        onClose()
        onInspected(result.info, result.token)
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={mode !== null}
      onClose={() => !busy && onClose()}
      title={mode === 'source' ? 'Add a mod source' : 'Install a mod from a link'}
      width={460}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!url.trim() || busy} onClick={() => void go()}>
            {busy ? 'Reading…' : mode === 'source' ? 'Add source' : 'Review'}
          </button>
        </>
      }
    >
      <form
        className="mods-link"
        onSubmit={(e) => {
          e.preventDefault()
          void go()
        }}
      >
        <p className="mods-link__lede">
          {mode === 'source'
            ? 'A mod source is a JSON index that lists mods. Its mods show here under its name, without a verified mark, and each one is reviewed before it installs.'
            : 'A packed mod is one JSON file holding a mod.json and its files. You see what it can touch before anything installs.'}
        </p>
        <input className="input" autoFocus value={url} spellCheck={false} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        {error && (
          <p className="mods-link__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
