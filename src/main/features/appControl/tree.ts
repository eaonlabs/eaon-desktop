import type { UiNode } from '@shared/appControl'
import type { RawNode } from './protocol'
import { clip, formatRef, type RefSummary } from './refs'

/**
 * Turning an engine's elements into Eaon's: one vocabulary of roles and
 * states on every OS, the interactive-only view, the compact text agents
 * read, and matching for `find`. Pure, so it's tested without an engine.
 */

/* ------------------------------------------------------------------ roles */

const MAC_ROLES: Record<string, string> = {
  AXApplication: 'application',
  AXWindow: 'window',
  AXSheet: 'sheet',
  AXDrawer: 'drawer',
  AXPopover: 'popover',
  AXButton: 'button',
  AXCheckBox: 'checkbox',
  AXRadioButton: 'radio',
  AXRadioGroup: 'radiogroup',
  AXTextField: 'textfield',
  AXTextArea: 'textarea',
  AXComboBox: 'combobox',
  AXPopUpButton: 'popup',
  AXMenuButton: 'menubutton',
  AXMenuBar: 'menubar',
  AXMenuBarItem: 'menubaritem',
  AXMenu: 'menu',
  AXMenuItem: 'menuitem',
  AXList: 'list',
  AXTable: 'table',
  AXOutline: 'tree',
  AXBrowser: 'browser',
  AXRow: 'row',
  AXCell: 'cell',
  AXColumn: 'column',
  AXStaticText: 'text',
  AXHeading: 'heading',
  AXLink: 'link',
  AXImage: 'image',
  AXGroup: 'group',
  AXToolbar: 'toolbar',
  AXTabGroup: 'tabs',
  AXSlider: 'slider',
  AXIncrementor: 'stepper',
  AXScrollArea: 'scrollarea',
  AXScrollBar: 'scrollbar',
  AXSplitGroup: 'split',
  AXSplitter: 'splitter',
  AXWebArea: 'webarea',
  AXDisclosureTriangle: 'disclosure',
  AXProgressIndicator: 'progress',
  AXBusyIndicator: 'busy',
  AXLevelIndicator: 'meter',
  AXRelevanceIndicator: 'meter',
  AXValueIndicator: 'indicator',
  AXColorWell: 'colorwell',
  AXDateField: 'datefield',
  AXTimeField: 'timefield',
  AXLayoutArea: 'canvas',
  AXLayoutItem: 'item',
  AXGrid: 'grid',
  AXHelpTag: 'tooltip',
  AXMatte: 'group',
  AXDockItem: 'dockitem',
  AXHandle: 'handle',
  AXGrowArea: 'handle',
  AXListMarker: 'marker',
  AXUnknown: 'unknown'
}

const MAC_SUBROLES: Record<string, string> = {
  AXSecureTextField: 'password',
  AXSearchField: 'searchfield',
  AXSwitch: 'switch',
  AXToggle: 'togglebutton',
  AXTabButton: 'tab',
  AXDialog: 'dialog',
  AXSystemDialog: 'dialog',
  AXOutlineRow: 'treeitem',
  AXContentList: 'list',
  AXDefinitionList: 'list',
  AXApplicationAlert: 'alert',
  AXApplicationDialog: 'dialog',
  AXDocument: 'document',
  AXLandmarkNavigation: 'navigation',
  AXLandmarkMain: 'main',
  AXLandmarkSearch: 'search',
  AXLandmarkBanner: 'banner',
  AXLandmarkContentInfo: 'contentinfo',
  AXTabPanel: 'tabpanel',
  AXListItem: 'listitem'
}

/** Windows UI Automation control types. */
const WIN_ROLES: Record<string, string> = {
  Button: 'button',
  SplitButton: 'button',
  CheckBox: 'checkbox',
  RadioButton: 'radio',
  Edit: 'textfield',
  Document: 'document',
  ComboBox: 'combobox',
  List: 'list',
  ListItem: 'listitem',
  DataGrid: 'table',
  Table: 'table',
  DataItem: 'row',
  Header: 'header',
  HeaderItem: 'columnheader',
  Tree: 'tree',
  TreeItem: 'treeitem',
  Menu: 'menu',
  MenuBar: 'menubar',
  MenuItem: 'menuitem',
  Tab: 'tabs',
  TabItem: 'tab',
  Text: 'text',
  Hyperlink: 'link',
  Image: 'image',
  Group: 'group',
  Pane: 'group',
  Custom: 'group',
  Window: 'window',
  TitleBar: 'titlebar',
  ToolBar: 'toolbar',
  StatusBar: 'statusbar',
  Slider: 'slider',
  Spinner: 'stepper',
  ScrollBar: 'scrollbar',
  ProgressBar: 'progress',
  Separator: 'separator',
  ToolTip: 'tooltip',
  Calendar: 'calendar',
  Thumb: 'handle',
  SemanticZoom: 'group',
  AppBar: 'toolbar'
}

/** AT-SPI role names. */
const LINUX_ROLES: Record<string, string> = {
  'push button': 'button',
  button: 'button',
  'toggle button': 'togglebutton',
  'check box': 'checkbox',
  'radio button': 'radio',
  'combo box': 'combobox',
  'menu bar': 'menubar',
  menu: 'menu',
  'popup menu': 'menu',
  'menu item': 'menuitem',
  'check menu item': 'menuitem',
  'radio menu item': 'menuitem',
  'tearoff menu item': 'menuitem',
  list: 'list',
  'list box': 'list',
  'list item': 'listitem',
  table: 'table',
  'tree table': 'tree',
  tree: 'tree',
  'tree item': 'treeitem',
  'table row': 'row',
  'table cell': 'cell',
  'table column header': 'columnheader',
  'column header': 'columnheader',
  'row header': 'rowheader',
  label: 'text',
  static: 'text',
  caption: 'text',
  text: 'textfield',
  entry: 'textfield',
  'password text': 'password',
  'spin button': 'stepper',
  slider: 'slider',
  'scroll bar': 'scrollbar',
  'scroll pane': 'scrollarea',
  viewport: 'scrollarea',
  'page tab list': 'tabs',
  'page tab': 'tab',
  'tool bar': 'toolbar',
  'status bar': 'statusbar',
  link: 'link',
  image: 'image',
  icon: 'image',
  heading: 'heading',
  paragraph: 'text',
  section: 'group',
  panel: 'group',
  filler: 'group',
  'layered pane': 'group',
  'split pane': 'split',
  separator: 'separator',
  'tool tip': 'tooltip',
  'progress bar': 'progress',
  frame: 'window',
  window: 'window',
  dialog: 'dialog',
  'file chooser': 'dialog',
  alert: 'alert',
  notification: 'alert',
  'document web': 'webarea',
  'document frame': 'document',
  'document text': 'document',
  application: 'application',
  canvas: 'canvas',
  'drawing area': 'canvas',
  switch: 'switch',
  'level bar': 'meter',
  'color chooser': 'colorwell',
  'date editor': 'datefield'
}

export function normalizeRole(raw: RawNode, platform: NodeJS.Platform): string {
  if (raw.secure) return 'password'
  if (platform === 'darwin') {
    if (raw.subrole && MAC_SUBROLES[raw.subrole]) return MAC_SUBROLES[raw.subrole]
    return MAC_ROLES[raw.role] ?? raw.role.replace(/^AX/, '').toLowerCase()
  }
  if (platform === 'win32') return WIN_ROLES[raw.role] ?? raw.role.toLowerCase()
  return LINUX_ROLES[raw.role] ?? raw.role.toLowerCase().replace(/\s+/g, '')
}

/** Roles a person can operate; anything else counts only if it offers an action or an editable value. */
const OPERABLE = new Set([
  'button', 'checkbox', 'radio', 'switch', 'togglebutton', 'tab', 'textfield', 'textarea', 'password', 'searchfield',
  'combobox', 'popup', 'menubutton', 'menubaritem', 'menuitem', 'link', 'slider', 'stepper', 'disclosure', 'row',
  'treeitem', 'listitem', 'cell', 'colorwell', 'datefield', 'timefield', 'dockitem', 'columnheader'
])

/** Actions every element offers, which say nothing about whether it does anything. */
const PASSIVE_ACTIONS = new Set(['AXShowMenu', 'AXScrollToVisible', 'AXShowDefaultUI', 'AXShowAlternateUI', 'SetFocus', 'scrollTo'])

/** Containers worth keeping in the interactive view for context even though they do nothing themselves. */
const LANDMARKS = new Set(['window', 'dialog', 'sheet', 'popover', 'drawer', 'menu', 'menubar', 'toolbar', 'tabs', 'list', 'table', 'tree', 'webarea', 'alert', 'tabpanel', 'navigation', 'main', 'search'])

const TOGGLES = new Set(['checkbox', 'radio', 'switch', 'togglebutton', 'menuitem', 'tab'])

/* ---------------------------------------------------------------- nodes */

export interface Converted {
  node: UiNode
  summaries: Map<number, RefSummary>
}

function statesOf(raw: RawNode, role: string): string[] {
  const states: string[] = []
  if (raw.enabled === false) states.push('disabled')
  if (raw.focused) states.push('focused')
  if (raw.selected) states.push('selected')
  let checked: boolean | 'mixed' | undefined = raw.checked
  // macOS keeps a checkbox's state in its value: 0, 1, or 2 for mixed.
  if (checked === undefined && TOGGLES.has(role) && role !== 'menuitem' && role !== 'tab' && raw.value !== undefined && /^[012]$/.test(raw.value)) {
    checked = raw.value === '2' ? 'mixed' : raw.value === '1'
  }
  if (checked === 'mixed') states.push('mixed')
  else if (checked === true) states.push('checked')
  else if (checked === false && TOGGLES.has(role) && role !== 'menuitem' && role !== 'tab') states.push('unchecked')
  if (raw.expanded === true) states.push('expanded')
  else if (raw.expanded === false) states.push('collapsed')
  if (raw.minimized) states.push('minimized')
  if (raw.fullscreen) states.push('fullscreen')
  if (raw.modal) states.push('modal')
  if (raw.required) states.push('required')
  if (raw.visited) states.push('visited')
  if (raw.valueSettable && (role === 'textfield' || role === 'textarea' || role === 'searchfield' || role === 'combobox')) states.push('editable')
  return states
}

/** One element, without children. */
export function convertOne(raw: RawNode, sid: string, platform: NodeJS.Platform): UiNode {
  const role = normalizeRole(raw, platform)
  const node: UiNode = { ref: formatRef(sid, raw.n), role }
  let name = raw.title?.trim() || ''
  let description = raw.description?.trim() || ''
  if (!name && description) {
    name = description
    description = ''
  }
  if (!description && raw.help?.trim() && raw.help.trim() !== name) description = raw.help.trim()
  // A password field's value never leaves here, whatever an engine sent.
  let value = raw.secure || role === 'password' ? undefined : raw.value
  // Static text carries its words in its value.
  if (role === 'text' && !name && value) {
    name = value
    value = undefined
  }
  // A checkbox's 0/1 is a state, not a value.
  if (value !== undefined && TOGGLES.has(role) && /^[012]$/.test(value)) value = undefined
  if (name) node.name = name
  if (value !== undefined && value !== '' && value !== name) node.value = value
  if (description && description !== name) node.description = description
  if (raw.placeholder) node.placeholder = raw.placeholder
  if (raw.identifier) node.id = raw.identifier
  const states = statesOf(raw, role)
  if (states.length > 0) node.states = states
  if (raw.bounds && raw.bounds.length === 4) node.bounds = raw.bounds.map((n) => Math.round(n)) as UiNode['bounds']
  const actions = (raw.actions ?? []).filter((action) => !PASSIVE_ACTIONS.has(action))
  if (actions.length > 0) node.actions = actions.map(shortAction)
  const native = platform === 'darwin' ? raw.subrole || raw.role : raw.role
  if (native && native.toLowerCase().replace(/^ax/, '').replace(/\s+/g, '') !== role) node.native = native
  return node
}

const shortAction = (action: string): string => action.replace(/^AX/, '').toLowerCase()

/** The whole tree, with each element's summary for the ref store. */
export function convertTree(raw: RawNode, sid: string, platform: NodeJS.Platform): Converted {
  const summaries = new Map<number, RefSummary>()
  const visit = (r: RawNode): UiNode => {
    const node = convertOne(r, sid, platform)
    summaries.set(r.n, summaryOf(node, r))
    if (r.children && r.children.length > 0) node.children = r.children.map(visit)
    if (r.more) node.more = r.more
    return node
  }
  return { node: visit(raw), summaries }
}

export function summaryOf(node: UiNode, raw?: RawNode): RefSummary {
  return { role: node.role, name: node.name ?? node.placeholder, secure: Boolean(raw?.secure) || node.role === 'password', bounds: node.bounds }
}

export function isInteractive(node: UiNode): boolean {
  if (OPERABLE.has(node.role)) return true
  if (node.states?.includes('editable')) return true
  return (node.actions ?? []).some((action) => action === 'press' || action === 'confirm' || action === 'pick' || action === 'open' || action === 'increment' || action === 'invoke' || action === 'toggle' || action === 'expand' || action === 'click' || action === 'activate')
}

/**
 * Only what can be operated, plus the named containers around it for
 * context. Unnamed groups are dissolved into their parent; containers with
 * nothing operable inside are dropped.
 */
export function interactiveOnly(node: UiNode): UiNode | null {
  const kids = (node.children ?? []).flatMap((child) => {
    const kept = interactiveOnly(child)
    if (!kept) return []
    // An unnamed wrapper that does nothing: keep what's inside it, not it.
    if (!isInteractive(kept) && !kept.name && !LANDMARKS.has(kept.role)) return kept.children ?? []
    return [kept]
  })
  const self = isInteractive(node)
  if (!self && kids.length === 0 && !node.more) return null
  const out: UiNode = { ...node }
  if (kids.length > 0) out.children = kids
  else delete out.children
  return out
}

/** Every node, depth-first, with the names of the containers it sits in. */
export function flatten(node: UiNode, path: string[] = [], out: { node: UiNode; path: string[] }[] = []): { node: UiNode; path: string[] }[] {
  out.push({ node, path })
  const here = node.name ? [...path, `${node.role} “${clip(node.name, 30)}”`] : path
  for (const child of node.children ?? []) flatten(child, here, out)
  return out
}

export function countNodes(node: UiNode): number {
  return 1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0)
}

/** Cuts a tree to `limit` nodes, breadth-first so the outline survives; cut branches say how much is left. */
export function capNodes(root: UiNode, limit: number): { node: UiNode; cut: number } {
  const total = countNodes(root)
  if (total <= limit) return { node: root, cut: 0 }
  const keep = new Set<UiNode>()
  const queue: UiNode[] = [root]
  while (queue.length > 0 && keep.size < limit) {
    const next = queue.shift()!
    keep.add(next)
    queue.push(...(next.children ?? []))
  }
  const copy = (node: UiNode): UiNode => {
    const out: UiNode = { ...node }
    const kids = node.children ?? []
    const kept = kids.filter((child) => keep.has(child))
    const dropped = kids.length - kept.length
    if (kept.length > 0) out.children = kept.map(copy)
    else delete out.children
    if (dropped > 0) out.more = (node.more ?? 0) + dropped
    return out
  }
  return { node: copy(root), cut: total - keep.size }
}

/* ------------------------------------------------------------------ text */

const quote = (text: string, max: number): string => `“${clip(text, max)}”`

/** One line per element: `button “Save” @s1:e4 [disabled]`. */
export function nodeLine(node: UiNode): string {
  const parts = [node.role]
  if (node.name) parts.push(quote(node.name, 80))
  if (node.value !== undefined) parts.push(`value=${quote(node.value, 80)}`)
  if (node.placeholder && !node.value) parts.push(`placeholder=${quote(node.placeholder, 40)}`)
  if (node.description) parts.push(`(${clip(node.description, 60)})`)
  if (node.id) parts.push(`#${clip(node.id, 40)}`)
  parts.push(node.ref)
  if (node.states && node.states.length > 0) parts.push(`[${node.states.join(', ')}]`)
  return parts.join(' ')
}

/** The tree as indented lines, the cheap form for a model to read. */
export function treeText(root: UiNode): string {
  const lines: string[] = []
  const visit = (node: UiNode, depth: number): void => {
    const pad = '  '.repeat(depth)
    lines.push(`${pad}- ${nodeLine(node)}`)
    for (const child of node.children ?? []) visit(child, depth + 1)
    if (node.more) lines.push(`${pad}  … ${node.more} more inside (snapshot root=${node.ref})`)
  }
  visit(root, 0)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ find */

export interface FindQuery {
  role?: string[]
  name?: string
  value?: string
  text?: string
  id?: string
  state?: string[]
  interactive?: boolean
  exact?: boolean
}

const fold = (text: string | undefined): string => (text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[…]/g, '...').replace(/\s+/g, ' ').trim().toLowerCase()

function matches(haystack: string | undefined, needle: string, exact: boolean): boolean {
  const a = fold(haystack)
  const b = fold(needle)
  if (!b) return true
  return exact ? a === b : a.includes(b)
}

export function nodeMatches(node: UiNode, query: FindQuery): boolean {
  const exact = Boolean(query.exact)
  if (query.role && query.role.length > 0 && !query.role.includes(node.role)) return false
  if (query.name !== undefined && !matches(node.name, query.name, exact)) return false
  if (query.value !== undefined && !matches(node.value, query.value, exact)) return false
  if (query.id !== undefined && !matches(node.id, query.id, exact)) return false
  if (query.text !== undefined) {
    const any = [node.name, node.value, node.description, node.placeholder].some((field) => matches(field, query.text!, exact))
    if (!any) return false
  }
  if (query.state && query.state.length > 0 && !query.state.every((state) => node.states?.includes(state))) return false
  if (query.interactive && !isInteractive(node)) return false
  return true
}

/** Text anywhere in the tree (names, values, descriptions). */
export function treeHasText(root: UiNode, text: string): boolean {
  return flatten(root).some(({ node }) => nodeMatches(node, { text }))
}
