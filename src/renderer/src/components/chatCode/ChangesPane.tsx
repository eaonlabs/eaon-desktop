import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Columns2,
  Copy,
  Ellipsis,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCompareArrows,
  History,
  ListTree,
  Loader2,
  MessageSquarePlus,
  RotateCw,
  Rows3,
  Search,
  SquareArrowOutUpRight,
  WrapText
} from 'lucide-react'
import type { ChatGitStatus } from '@shared/chatCode'
import type { ChatToolPart } from '@shared/types'
import { useApp } from '../../state/store'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { FileIcon } from '../agent/FileIcon'
import { MenuItem, MenuSearch, MenuSeparator, Popover, Switch, useDisclosure } from '../ui'
import { notify } from '../Notice'
import { useDockPlace } from '../ide/dockPlace'
import { openInCode } from '../ide/ideStore'
import { joinPath } from '../ide/paths'
import { preferredTarget, useChatCode } from './chatCodeStore'
import { agentFiles, editTurns, fileTree, gitFile, partEdit, relativePath, sameScope, toPatch, type AgentEdit, type FileTreeNode, type ReviewScope } from './changes/build'
import { DiffCard, DiffStat, splitFilePath, type DiffLayout, type LineComments } from './diff/DiffCard'
import type { DiffFileModel, DiffRow } from './diff/model'

/**
 * The dock's Diff: a chat's work as a review. The scope picker chooses what
 * is compared — everything the agent changed in this chat, one turn of it,
 * or (in a git repository) everything not committed — and each file is a
 * card with its diff. A bar over them switches between one column and side
 * by side, wraps long lines, steps from change to change, finds a file, and
 * shows the files as a tree beside the diffs. A line's number opens a
 * comment on it that goes into the message box. In the ADE's dock, where no
 * chat's edits are known, it shows what is uncommitted, and comments go to
 * the session's agent.
 */

const LAYOUT_KEY = 'eaon.diff.layout'
const WRAP_KEY = 'eaon.diff.wrap'
const TREE_KEY = 'eaon.diff.tree'
/** Past this size a file on disk isn't read for its folds: the diff alone is what matters. */
const MAX_READ = 2_000_000

const stored = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
const store = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* kept for this session */
  }
}

/** The open chat's finished edits, re-made only when a call finishes, not on every streamed token. */
function useAgentEdits(): AgentEdit[] {
  const parts = useApp(
    useShallow((s) => {
      const out: (ChatToolPart | number)[] = []
      let turn = 0
      for (const m of s.activeChat()?.messages ?? []) {
        if (m.role !== 'assistant') continue
        turn++
        for (const p of m.parts) if (p.type === 'tool' && p.status === 'done' && (p.name === 'edit_file' || p.name === 'write_file')) out.push(p, turn)
      }
      return out
    })
  )
  return useMemo(() => {
    const edits: AgentEdit[] = []
    for (let i = 0; i < parts.length; i += 2) {
      const edit = partEdit(parts[i] as ChatToolPart, parts[i + 1] as number)
      if (edit) edits.push(edit)
    }
    return edits
  }, [parts])
}

async function readText(path: string): Promise<string | null> {
  try {
    const file = await window.api.workspaceFiles.read(path)
    return file.kind === 'text' && file.text.length <= MAX_READ ? file.text : null
  } catch {
    return null
  }
}

type Loaded = { files: DiffFileModel[]; error?: undefined } | { files: null; error: string }

/** A scope's files, read again when the edits change, when asked, and when Eaon comes back to the front. */
function useScopeFiles(scope: ReviewScope, edits: AgentEdit[], root: string | null, folder: string | null, gitStatus: ChatGitStatus | null, nonce: number): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [focusNonce, setFocusNonce] = useState(0)
  const streamEnded = useApp((s) => s.streamingMessageId === null)
  const missing = useDockPlace().missing
  // A commit, a pull or a branch switch is a new git status (`gitStatus`): the uncommitted changes are read again.
  useEffect(() => {
    const onFocus = (): void => setFocusNonce((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  // A different scope shows its own files, not the last scope's while it loads.
  const scopeKey = scope.kind === 'turn' ? `turn:${scope.turn}` : scope.kind
  useEffect(() => setLoaded(null), [scopeKey])

  useEffect(() => {
    let live = true
    void (async () => {
      if (scope.kind === 'git') {
        if (!folder) return live && setLoaded({ files: null, error: `${missing ?? 'Pick a folder first'}.` })
        const res = await window.api.chatCode.diff(folder).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
        if (!res.ok) return live && setLoaded({ files: null, error: res.error })
        const files = await Promise.all(
          res.files.map(async (f) => gitFile(f, f.binary || f.status === 'deleted' || f.hunks.length === 0 ? null : await readText(joinPath(folder, f.path))))
        )
        if (live) setLoaded({ files })
        return
      }
      const paths = [...new Set(edits.map((e) => relativePath(root, e.path)))]
      const texts = await Promise.all(paths.map((p) => readText(root ? joinPath(root, p) : p)))
      if (live) setLoaded({ files: agentFiles(edits, root, new Map(paths.map((p, i) => [p, texts[i]])), scope) })
    })()
    return () => {
      live = false
    }
    // A scope is compared by value; the edits and folder by identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, edits, root, folder, nonce, focusNonce, scope.kind === 'git' && streamEnded, scope.kind === 'git' ? gitStatus : null])
  return loaded
}

const NO_EDITS: AgentEdit[] = []

export function ChangesPane(): JSX.Element {
  const place = useDockPlace()
  const chat = place.id === 'chat'
  const root = place.store((s) => s.root)
  const review = place.store((s) => s.review)
  const { folder, status } = place
  const isRepo = Boolean(status?.repo)
  const chatEdits = useAgentEdits()
  const edits = chat ? chatEdits : NO_EDITS
  const turns = useMemo(() => editTurns(edits), [edits])

  const [scope, setScope] = useState<ReviewScope>(() => (chat ? (review?.scope ?? { kind: 'chat' }) : { kind: 'git' }))
  const [nonce, setNonce] = useState(0)
  const [layout, setLayoutState] = useState<DiffLayout>(() => (stored(LAYOUT_KEY, 'unified') === 'split' ? 'split' : 'unified'))
  const [wrap, setWrapState] = useState(() => stored(WRAP_KEY, '0') === '1')
  const [tree, setTreeState] = useState(() => stored(TREE_KEY, '0') === '1')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [focusFile, setFocusFile] = useState<string | null>(null)
  const setLayout = (v: DiffLayout): void => (setLayoutState(v), store(LAYOUT_KEY, v))
  const setWrap = (v: boolean): void => (setWrapState(v), store(WRAP_KEY, v ? '1' : '0'))
  const setTree = (v: boolean): void => (setTreeState(v), store(TREE_KEY, v ? '1' : '0'))

  // A turn's Review button: that turn, scrolled to its file.
  useEffect(() => {
    if (!review) return
    setScope(review.scope)
    setFocusFile(review.file ?? null)
  }, [review])
  // A git scope with no repository (the folder changed) falls back to the chat.
  useEffect(() => {
    if (chat && scope.kind === 'git' && !isRepo && status) setScope({ kind: 'chat' })
  }, [chat, scope, isRepo, status])

  const loaded = useScopeFiles(scope, edits, root, folder, status, nonce)
  const files = loaded?.files ?? null
  const added = files?.reduce((n, f) => n + f.added, 0) ?? 0
  const removed = files?.reduce((n, f) => n + f.removed, 0) ?? 0

  const scroller = useRef<HTMLDivElement>(null)
  const cards = useRef(new Map<string, HTMLDivElement>())

  const jumpTo = useCallback((path: string) => {
    setCollapsed((now) => {
      if (![...now].some((k) => k.endsWith(`:${path}`))) return now
      const next = new Set(now)
      for (const k of now) if (k.endsWith(`:${path}`)) next.delete(k)
      return next
    })
    requestAnimationFrame(() => {
      const card = cards.current.get(path)
      if (!card) return
      card.scrollIntoView({ block: 'start', behavior: document.body.dataset.reduceMotion === 'on' ? 'auto' : 'smooth' })
      card.dataset.flash = ''
      window.setTimeout(() => delete card.dataset.flash, 900)
    })
  }, [])

  // Once the asked-for file is drawn, bring it into view.
  useEffect(() => {
    if (!focusFile || !files) return
    if (files.some((f) => f.path === focusFile)) jumpTo(focusFile)
    setFocusFile(null)
  }, [focusFile, files, jumpTo])

  /** The next or previous change below or above the top of the view, across files. */
  const step = (dir: 1 | -1): void => {
    const box = scroller.current
    if (!box) return
    const top = box.getBoundingClientRect().top + 44
    const marks = [...box.querySelectorAll<HTMLElement>('[data-change]')]
    const target =
      dir === 1 ? marks.find((m) => m.getBoundingClientRect().top > top + 4) : [...marks].reverse().find((m) => m.getBoundingClientRect().top < top - 4)
    if (!target) return
    target.scrollIntoView({ block: 'center', behavior: document.body.dataset.reduceMotion === 'on' ? 'auto' : 'smooth' })
    target.dataset.flash = ''
    window.setTimeout(() => delete target.dataset.flash, 900)
  }

  const allCollapsed = Boolean(files?.length) && files!.every((f) => collapsed.has(f.key))
  const comments = useLineComments()
  const commentsFor = useMemo(() => new Map((files ?? []).map((f) => [f.key, comments(f)])), [files, comments])
  const toggle = useCallback(
    (key: string) =>
      setCollapsed((now) => {
        const next = new Set(now)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    []
  )
  const register = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) cards.current.set(path, el)
    else cards.current.delete(path)
  }, [])

  return (
    <div className="cpane">
      <div className="cpane__bar">
        <ScopePicker scope={scope} turns={turns} isRepo={isRepo} gitOnly={!chat} count={files?.length ?? null} added={added} removed={removed} onChange={setScope} />
        <div className="cpane__tools" role="toolbar" aria-label="Changes">
          <button type="button" className="cpane__tool" onClick={() => setNonce((n) => n + 1)} title="Reload" aria-label="Reload">
            <RotateCw size={13} strokeWidth={2} className={loaded === null ? 'spinner' : undefined} />
          </button>
          <ViewMenu
            layout={layout}
            wrap={wrap}
            allCollapsed={allCollapsed}
            canCopy={Boolean(files?.length)}
            onLayout={setLayout}
            onWrap={setWrap}
            onCollapseAll={() => setCollapsed(allCollapsed ? new Set() : new Set(files?.map((f) => f.key)))}
            onCopy={() => files && void copyText(toPatch(files)).then((ok) => notify(ok ? 'Copied the diff' : CLIPBOARD_FAILED, ok ? undefined : 'error'))}
          />
          <span className="cpane__sep" aria-hidden />
          <button type="button" className="cpane__tool" onClick={() => step(-1)} disabled={!files?.length} title="Previous change" aria-label="Previous change">
            <ChevronUp size={14} strokeWidth={2} />
          </button>
          <button type="button" className="cpane__tool" onClick={() => step(1)} disabled={!files?.length} title="Next change" aria-label="Next change">
            <ChevronDown size={14} strokeWidth={2} />
          </button>
          <FileJump files={files ?? []} onPick={jumpTo} />
          <button
            type="button"
            className="cpane__tool"
            data-active={tree || undefined}
            aria-pressed={tree}
            onClick={() => setTree(!tree)}
            title={tree ? 'Hide the file tree' : 'Show the file tree'}
            aria-label="File tree"
          >
            <ListTree size={14} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <div className="cpane__body">
        {tree && files && files.length > 0 && <FileTree files={files} onPick={jumpTo} />}
        <div className="cpane__scroll scroll" ref={scroller}>
          {loaded === null ? (
            <div className="cpane__state">
              <Loader2 size={16} className="spinner" />
            </div>
          ) : loaded.error !== undefined ? (
            <div className="cpane__state cpane__state--error">{loaded.error}</div>
          ) : loaded.files.length === 0 ? (
            <Empty scope={scope} />
          ) : (
            <div className="cpane__files">
              {loaded.files.map((file) => (
                <FileCard
                  key={file.key}
                  file={file}
                  layout={layout}
                  wrap={wrap}
                  collapsed={collapsed.has(file.key)}
                  toggle={toggle}
                  register={register}
                  comments={commentsFor.get(file.key)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** A card with its callbacks bound once, so a card redraws only when its own file, fold or comment does. */
const FileCard = memo(function FileCard({
  file,
  layout,
  wrap,
  collapsed,
  toggle,
  register,
  comments
}: {
  file: DiffFileModel
  layout: DiffLayout
  wrap: boolean
  collapsed: boolean
  toggle: (key: string) => void
  register: (path: string, el: HTMLDivElement | null) => void
  comments: LineComments | undefined
}): JSX.Element {
  const onToggle = useCallback(() => toggle(file.key), [toggle, file.key])
  const cardRef = useCallback((el: HTMLDivElement | null) => register(file.path, el), [register, file.path])
  const actions = useMemo(() => <FileActions file={file} />, [file])
  return <DiffCard file={file} layout={layout} wrap={wrap} collapsed={collapsed} onToggle={onToggle} actions={actions} comments={comments} cardRef={cardRef} />
})

const scopeLabel = (scope: ReviewScope, last: number | undefined): string =>
  scope.kind === 'git' ? 'Uncommitted' : scope.kind === 'chat' ? 'All changes' : scope.turn === last ? 'Last turn' : `Turn ${scope.turn}`

/** What the pane compares: the chat, a turn, or git's uncommitted changes. `gitOnly`: there is only the last to show (the ADE). */
function ScopePicker({
  scope,
  turns,
  isRepo,
  gitOnly,
  count,
  added,
  removed,
  onChange
}: {
  scope: ReviewScope
  turns: number[]
  isRepo: boolean
  gitOnly: boolean
  count: number | null
  added: number
  removed: number
  onChange: (scope: ReviewScope) => void
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const last = turns[turns.length - 1]
  const pick = (next: ReviewScope): void => {
    onChange(next)
    menu.close()
  }
  const icon = scope.kind === 'git' ? <GitBranch size={13} strokeWidth={2} /> : scope.kind === 'turn' ? <History size={13} strokeWidth={2} /> : <GitCompareArrows size={13} strokeWidth={2} />
  if (gitOnly) {
    return (
      <div className="cpane__scope" data-static>
        <span className="cpane__scope-icon">{icon}</span>
        <span className="cpane__scope-label">{scopeLabel(scope, last)}</span>
        {count !== null && count > 0 && <span className="cpane__badge">{count}</span>}
        <DiffStat added={added} removed={removed} className="cpane__stat" />
      </div>
    )
  }
  return (
    <>
      <button ref={anchor} type="button" className="cpane__scope" data-open={menu.open || undefined} onClick={menu.toggle} aria-haspopup="menu" title="Choose what to compare">
        <span className="cpane__scope-icon">{icon}</span>
        <span className="cpane__scope-label">{scopeLabel(scope, last)}</span>
        {count !== null && count > 0 && <span className="cpane__badge">{count}</span>}
        <DiffStat added={added} removed={removed} className="cpane__stat" />
        <ChevronDown size={13} strokeWidth={2} className="cpane__scope-chev" />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-start" width={248}>
        <div className="menu__label">This chat</div>
        <MenuItem icon={<GitCompareArrows size={15} strokeWidth={1.8} />} title="All changes" description="Everything the agent changed here" checked={scope.kind === 'chat'} onClick={() => pick({ kind: 'chat' })} />
        {turns
          .slice()
          .reverse()
          .slice(0, 12)
          .map((turn) => (
            <MenuItem
              key={turn}
              icon={<History size={15} strokeWidth={1.8} />}
              title={turn === last ? 'Last turn' : `Turn ${turn}`}
              checked={sameScope(scope, { kind: 'turn', turn })}
              onClick={() => pick({ kind: 'turn', turn })}
            />
          ))}
        {isRepo && (
          <>
            <MenuSeparator />
            <div className="menu__label">Git</div>
            <MenuItem icon={<GitBranch size={15} strokeWidth={1.8} />} title="Uncommitted changes" description="Everything not committed yet" checked={scope.kind === 'git'} onClick={() => pick({ kind: 'git' })} />
          </>
        )}
      </Popover>
    </>
  )
}

function ViewMenu({
  layout,
  wrap,
  allCollapsed,
  canCopy,
  onLayout,
  onWrap,
  onCollapseAll,
  onCopy
}: {
  layout: DiffLayout
  wrap: boolean
  allCollapsed: boolean
  canCopy: boolean
  onLayout: (layout: DiffLayout) => void
  onWrap: (wrap: boolean) => void
  onCollapseAll: () => void
  onCopy: () => void
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  return (
    <>
      <button ref={anchor} type="button" className="cpane__tool" data-active={menu.open || undefined} onClick={menu.toggle} title="View options" aria-label="View options">
        <Ellipsis size={14} strokeWidth={2} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={236}>
        <div className="menu__label">View</div>
        <MenuItem icon={<Rows3 size={15} strokeWidth={1.8} />} title="One column" checked={layout === 'unified'} onClick={() => onLayout('unified')} />
        <MenuItem icon={<Columns2 size={15} strokeWidth={1.8} />} title="Side by side" checked={layout === 'split'} onClick={() => onLayout('split')} />
        <div
          className="menu__switch-row"
          data-disabled={layout === 'split' || undefined}
          onClick={(e) => {
            if (layout === 'unified' && !(e.target as Element).closest('.switch')) onWrap(!wrap)
          }}
        >
          <WrapText size={15} strokeWidth={1.8} />
          <span>Wrap long lines</span>
          <Switch checked={wrap || layout === 'split'} disabled={layout === 'split'} onChange={onWrap} label="Wrap long lines" />
        </div>
        <MenuSeparator />
        <MenuItem
          icon={<FolderTree size={15} strokeWidth={1.8} />}
          title={allCollapsed ? 'Expand all files' : 'Collapse all files'}
          onClick={() => {
            onCollapseAll()
            menu.close()
          }}
        />
        <MenuItem
          icon={<Copy size={15} strokeWidth={1.8} />}
          title="Copy as patch"
          disabled={!canCopy}
          onClick={() => {
            onCopy()
            menu.close()
          }}
        />
      </Popover>
    </>
  )
}

/** Find a file among the changes and jump to it. */
function FileJump({ files, onPick }: { files: DiffFileModel[]; onPick: (path: string) => void }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
  return (
    <>
      <button ref={anchor} type="button" className="cpane__tool" data-active={menu.open || undefined} onClick={menu.toggle} disabled={files.length === 0} title="Go to a file" aria-label="Go to a file">
        <Search size={13} strokeWidth={2} />
      </button>
      <Popover
        anchor={anchor}
        open={menu.open}
        onClose={() => {
          menu.close()
          setQuery('')
        }}
        placement="bottom-end"
        width={300}
      >
        <MenuSearch value={query} onChange={setQuery} placeholder="Go to a changed file" />
        <div className="cpane__jump">
          {shown.map((f) => {
            const { dir, name } = splitFilePath(f.path)
            return (
              <MenuItem
                key={f.key}
                icon={<FileIcon file={name} size={14} />}
                title={
                  <span className="cpane__jump-row">
                    <span className="cpane__jump-name">{name}</span>
                    {dir && <span className="cpane__jump-dir">{dir}</span>}
                  </span>
                }
                hint={<DiffStat added={f.added} removed={f.removed} />}
                onClick={() => {
                  menu.close()
                  setQuery('')
                  onPick(f.path)
                }}
              />
            )
          })}
          {shown.length === 0 && <div className="menu__note">No changed file matches.</div>}
        </div>
      </Popover>
    </>
  )
}

function FileTree({ files, onPick }: { files: DiffFileModel[]; onPick: (path: string) => void }): JSX.Element {
  const nodes = useMemo(() => fileTree(files), [files])
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const row = (node: FileTreeNode<DiffFileModel>, depth: number): JSX.Element =>
    node.file ? (
      <button key={node.path} type="button" className="ctree__row" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onPick(node.path)} title={node.path}>
        <span className="ctree__icon">
          <FileIcon file={node.name} size={13} />
        </span>
        <span className="ctree__name" data-status={node.file.status}>
          {node.name}
        </span>
        <DiffStat added={node.file.added} removed={node.file.removed} className="ctree__stat" />
      </button>
    ) : (
      <div key={node.path}>
        <button
          type="button"
          className="ctree__row ctree__row--dir"
          style={{ paddingLeft: 8 + depth * 12 }}
          aria-expanded={!closed.has(node.path)}
          onClick={() =>
            setClosed((now) => {
              const next = new Set(now)
              if (next.has(node.path)) next.delete(node.path)
              else next.add(node.path)
              return next
            })
          }
        >
          <ChevronRight size={12} strokeWidth={2.2} className="ctree__chev" />
          <span className="ctree__name">{node.name}</span>
        </button>
        {!closed.has(node.path) && node.children.map((c) => row(c, depth + 1))}
      </div>
    )
  return (
    <nav className="ctree scroll" aria-label="Changed files">
      {nodes.map((n) => row(n, 0))}
    </nav>
  )
}

/** A file card's menu: open it here or in an editor, copy its path, show it in its folder. */
function FileActions({ file }: { file: DiffFileModel }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const { id, folder, store } = useDockPlace()
  const target = useChatCode((s) => preferredTarget(s.targets, s.preferred))
  const abs = folder ? joinPath(folder, file.path) : file.path
  const firstLine = (): number | undefined => {
    for (const block of file.blocks) if (block.type === 'rows') for (const r of block.rows) if (r.kind !== 'ctx' && r.cur) return r.cur
    return undefined
  }
  const deleted = file.status === 'deleted'
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="dv__action"
        data-active={menu.open || undefined}
        onClick={() => {
          if (!useChatCode.getState().targets) void useChatCode.getState().loadTargets()
          menu.toggle()
        }}
        aria-label={`More for ${file.path}`}
        title="More"
      >
        <Ellipsis size={14} strokeWidth={2} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={224}>
        <MenuItem
          icon={<Code2 size={15} strokeWidth={1.8} />}
          title={id === 'chat' ? 'Open in Code' : 'Open in the dock'}
          disabled={deleted}
          onClick={() => {
            menu.close()
            void openInCode(file.path, firstLine(), store)
          }}
        />
        {target && folder && (
          <MenuItem
            icon={<SquareArrowOutUpRight size={15} strokeWidth={1.8} />}
            title={`Open in ${target.label}`}
            disabled={deleted}
            onClick={() => {
              menu.close()
              void window.api.chatCode.openIn(folder, target.id, abs, firstLine() ?? null).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e), 'error'))
            }}
          />
        )}
        <MenuItem
          icon={<Copy size={15} strokeWidth={1.8} />}
          title="Copy path"
          onClick={() => {
            menu.close()
            void copyText(file.path).then((ok) => notify(ok ? 'Copied the path' : CLIPBOARD_FAILED, ok ? undefined : 'error'))
          }}
        />
        <MenuItem
          icon={<FolderOpen size={15} strokeWidth={1.8} />}
          title="Show in folder"
          disabled={deleted}
          onClick={() => {
            menu.close()
            void window.api.app.showItem(abs)
          }}
        />
      </Popover>
    </>
  )
}

function Empty({ scope }: { scope: ReviewScope }): JSX.Element {
  return (
    <div className="cpane__empty">
      <span className="cpane__empty-icon">{scope.kind === 'git' ? <GitBranch size={18} strokeWidth={1.6} /> : <GitCompareArrows size={18} strokeWidth={1.6} />}</span>
      <p className="cpane__empty-title">{scope.kind === 'git' ? 'Nothing uncommitted' : 'No changes yet'}</p>
      <p className="cpane__empty-hint">
        {scope.kind === 'git' ? 'Everything in this folder is committed.' : 'Files Eaon edits in this chat show up here, ready to review.'}
      </p>
    </div>
  )
}

/**
 * Comments on lines: a line's number opens a box under it, and what is
 * written there goes into the message box quoting the file, line and code,
 * for the agent to act on with the next message.
 */
function useLineComments(): (file: DiffFileModel) => LineComments {
  const [draft, setDraft] = useState<{ key: string; row: DiffRow; text: string } | null>(null)
  return useCallback(
    (file: DiffFileModel): LineComments => ({
      onPick: (row) => setDraft((now) => (now && now.key === file.key && now.row === row ? null : { key: file.key, row, text: now?.text ?? '' })),
      render: (row) =>
        draft && draft.key === file.key && draft.row === row ? (
          <CommentBox
            file={file}
            row={row}
            text={draft.text}
            onChange={(text) => setDraft({ ...draft, text })}
            onCancel={() => setDraft(null)}
            onDone={() => setDraft(null)}
          />
        ) : null
    }),
    [draft]
  )
}

function CommentBox({
  file,
  row,
  text,
  onChange,
  onCancel,
  onDone
}: {
  file: DiffFileModel
  row: DiffRow
  text: string
  onChange: (text: string) => void
  onCancel: () => void
  onDone: () => void
}): JSX.Element {
  const place = useDockPlace()
  const line = row.kind === 'del' ? row.old : row.cur
  const where = `${file.path}:${line}`
  const add = (): void => {
    if (!text.trim()) return
    const lang = file.path.split('.').pop() ?? ''
    const quote = row.kind === 'del' ? `${where} (a removed line)` : where
    place.addToPrompt(`\`${quote}\`\n\`\`\`${lang}\n${row.text}\n\`\`\`\n${text.trim()}\n\n`, 'the comment')
    onDone()
  }
  return (
    <div className="dv-note">
      <div className="dv-note__where">
        <MessageSquarePlus size={12} strokeWidth={2} />
        {row.kind === 'del' ? `Removed line ${line}` : `Line ${line}`}
      </div>
      <textarea
        autoFocus
        className="dv-note__input"
        rows={2}
        value={text}
        placeholder="What should change here?"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            add()
          }
        }}
      />
      <div className="dv-note__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary btn--sm" disabled={!text.trim()} onClick={add}>
          Add to {place.prompt}
        </button>
      </div>
    </div>
  )
}
