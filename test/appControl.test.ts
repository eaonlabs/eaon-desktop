import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AppControlEnvelope, AppControlSettings, UiNode } from '@shared/appControl'
import { parseArgv } from '../src/main/features/appControl/argv'
import { findCommand } from '../src/main/features/appControl/commands'
import { failure, type AppControlEngine, type RawNode } from '../src/main/features/appControl/protocol'
import { formatRef, parseRef, RefStore } from '../src/main/features/appControl/refs'
import { commandRisk, protectedEntry } from '../src/main/features/appControl/safety'
import { AppControlService } from '../src/main/features/appControl/service'
import { appControlTool } from '../src/main/features/appControl/tool'
import { capNodes, convertTree, interactiveOnly, treeText } from '../src/main/features/appControl/tree'
import type { ToolContext } from '../src/main/agent/tools'

/**
 * App control without an engine process: a scripted app that answers the
 * engine protocol the way the macOS one does (AX roles, value-as-state
 * checkboxes, a menu bar), so every command, the switches, the safety rules
 * and the activity list are checked without touching a real app.
 */

/* ------------------------------------------------------------ a fake app */

interface El {
  role: string
  subrole?: string
  title?: string
  value?: string
  description?: string
  enabled?: boolean
  focused?: boolean
  expanded?: boolean
  bounds?: number[]
  actions?: string[]
  settable?: boolean
  children?: El[]
  gone?: boolean
  onPress?: () => void
}

const NOTES = 100
const EAON = 200
const VAULT = 300

class FakeApp implements AppControlEngine {
  readonly platform = 'darwin' as const
  epoch = 1
  calls: { op: string; params: Record<string, unknown> }[] = []
  private snapshots = new Map<string, El[]>()
  private nextSid = 1
  private status = ''
  window: El
  menubar: El
  popupMenu: El

  constructor() {
    this.status = 'Ready'
    const statusText: El = { role: 'AXStaticText', value: 'Ready' }
    this.popupMenu = {
      role: 'AXMenu',
      children: ['Small', 'Medium', 'Large'].map((title) => ({ role: 'AXMenuItem', title, actions: ['AXPress'], onPress: () => (sizePopup.value = title) }))
    }
    const sizePopup: El = { role: 'AXPopUpButton', title: 'Size', value: 'Medium', actions: ['AXPress', 'AXShowMenu'], bounds: [300, 60, 90, 22], children: [this.popupMenu] }
    const bold: El = { role: 'AXCheckBox', title: 'Bold', value: '0', actions: ['AXPress'], bounds: [20, 60, 40, 22] }
    bold.onPress = () => (bold.value = bold.value === '1' ? '0' : '1')
    this.window = {
      role: 'AXWindow',
      title: 'Untitled',
      bounds: [0, 0, 800, 600],
      children: [
        {
          role: 'AXGroup',
          children: [
            {
              role: 'AXToolbar',
              children: [
                bold,
                sizePopup,
                { role: 'AXButton', title: 'Add', actions: ['AXPress'], bounds: [400, 60, 50, 22], onPress: () => this.window.children!.push({ role: 'AXStaticText', value: 'Added!' }) },
                { role: 'AXButton', title: 'Share', enabled: false, actions: ['AXPress'] }
              ]
            }
          ]
        },
        { role: 'AXTextArea', title: 'Body', value: 'Hello', actions: [], settable: true, bounds: [20, 100, 760, 400] },
        { role: 'AXTextField', subrole: 'AXSecureTextField', title: 'Password', actions: [], settable: true },
        { role: 'AXGroup', children: [{ role: 'AXImage', description: 'logo' }] },
        statusText
      ]
    }
    this.menubar = {
      role: 'AXMenuBar',
      children: [
        { role: 'AXMenuBarItem', title: 'Notes', children: [{ role: 'AXMenu', children: [{ role: 'AXMenuItem', title: 'Quit Notes', actions: ['AXPress'] }] }] },
        {
          role: 'AXMenuBarItem',
          title: 'File',
          children: [
            {
              role: 'AXMenu',
              children: [
                { role: 'AXMenuItem', title: 'Save As…', actions: ['AXPress'], onPress: () => (this.status = 'saved-as') },
                { role: 'AXMenuItem', title: 'Print…', enabled: false, actions: ['AXPress'] }
              ]
            }
          ]
        }
      ]
    }
  }

  get savedAs(): boolean {
    return this.status === 'saved-as'
  }

  private register(els: El[]): string {
    const sid = `s${String(this.nextSid++).padStart(6, '0')}`
    this.snapshots.set(sid, els)
    return sid
  }

  private raw(el: El, n: number): RawNode {
    const node: RawNode = { n, role: el.role }
    if (el.subrole) node.subrole = el.subrole
    if (el.title) node.title = el.title
    if (el.value !== undefined && el.subrole !== 'AXSecureTextField') node.value = el.value
    if (el.description) node.description = el.description
    if (el.enabled === false) node.enabled = false
    if (el.focused) node.focused = true
    if (el.expanded !== undefined) node.expanded = el.expanded
    if (el.bounds) node.bounds = el.bounds
    if (el.actions?.length) node.actions = el.actions
    if (el.settable) node.valueSettable = true
    return node
  }

  private walk(root: El, depth: number, maxNodes: number, list: El[]): RawNode {
    const visit = (el: El, level: number): RawNode => {
      list.push(el)
      const node = this.raw(el, list.length)
      const kids = el.children ?? []
      if (kids.length && level >= depth) node.more = kids.length
      else if (kids.length) node.children = kids.map((kid) => visit(kid, level + 1))
      return node
    }
    return visit(root, 0)
  }

  private lookup(params: Record<string, unknown>): El {
    const els = this.snapshots.get(String(params.sid))
    if (!els) throw failure('STALE_REF', 'That ref’s snapshot is gone.')
    const el = els[Number(params.n) - 1]
    if (!el) throw failure('BAD_REF', 'No such element.')
    if (el.gone) throw failure('STALE_REF', 'That element is no longer there.')
    return el
  }

  async call<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, params })
    const apps = [
      { pid: NOTES, name: 'Notes', bundleId: 'com.example.notes', active: true },
      { pid: EAON, name: 'Eaon', bundleId: 'dev.eaon.desktop' },
      { pid: VAULT, name: '1Password', bundleId: 'com.1password.1password' },
      { pid: 400, name: 'Terminal', bundleId: 'com.apple.Terminal' }
    ]
    switch (op) {
      case 'status':
        return { trusted: true, version: 'fake-1' } as T
      case 'apps':
        return apps as T
      case 'frontmost':
        return apps[0] as T
      case 'snapshot': {
        const list: El[] = []
        let root: El
        if (params.sid) root = this.lookup(params)
        else if (params.scope === 'menubar') root = this.menubar
        else if (params.scope === 'app') root = { role: 'AXApplication', title: 'Notes', children: params.skipMenuBar ? [this.window] : [this.window, this.menubar] }
        else root = this.window
        const tree = this.walk(root, Number(params.depth ?? 30), Number(params.maxNodes ?? 4000), list)
        const sid = params.ephemeral ? 'ephemeral' : this.register(list)
        return { sid, pid: NOTES, tree, count: list.length, truncated: false } as T
      }
      case 'windows': {
        const sid = this.register([this.window])
        return [{ ...this.raw(this.window, 1), focused: true, sid, pid: NOTES }] as T
      }
      case 'surfaces': {
        const sid = this.register([this.popupMenu])
        return [{ ...this.raw(this.popupMenu, 1), sid }] as T
      }
      case 'read': {
        const el = this.lookup(params)
        return { ...this.raw(el, Number(params.n)) } as T
      }
      case 'act': {
        const el = this.lookup(params)
        switch (params.action) {
          case 'press':
            if (!el.actions?.includes('AXPress')) throw failure('ACTION_UNSUPPORTED', 'Can’t press that.')
            el.onPress?.()
            break
          case 'setvalue':
            el.value = String(params.value)
            break
          case 'inserttext':
            el.value = `${el.value ?? ''}${params.text}`
            break
          case 'focus':
            el.focused = true
            break
          case 'showmenu':
            break
          default:
            throw failure('ACTION_UNSUPPORTED', `No ${String(params.action)}.`)
        }
        return { after: this.raw(el, Number(params.n)) } as T
      }
      case 'keys':
      case 'text':
        return { done: true } as T
      case 'focused':
        return { sid: this.register([this.window.children![1]]), pid: NOTES, node: this.raw(this.window.children![1], 1) } as T
      case 'launch':
        return { ...apps[0], alreadyRunning: true } as T
      default:
        throw failure('INVALID_ARGS', `fake has no ${op}`)
    }
  }

  dispose(): void {}
}

function setup(overrides: Partial<AppControlSettings> = {}) {
  const engine = new FakeApp()
  const settings: AppControlSettings = { enabled: true, terminalAgents: false, showActions: true, ...overrides }
  const flashes: string[] = []
  const service = new AppControlService({
    platform: 'darwin',
    engine: () => engine,
    engineInfo: () => ({ name: 'Fake', detail: null }),
    settings: () => settings,
    ownPids: () => new Set([EAON]),
    clipboard: { readText: () => 'clip', writeText: () => {}, clear: () => {}, hasImage: () => false },
    displays: () => [{ id: 1, primary: true, bounds: [0, 0, 1440, 900], workArea: [0, 25, 1440, 875], scale: 2 }],
    flash: (_bounds, label) => void flashes.push(label),
    appVersion: 'test',
    sleep: async () => {}
  })
  const source = { kind: 'chat' as const, name: 'Test chat' }
  const run = (command: string, args: Record<string, unknown> = {}): Promise<AppControlEnvelope> => service.run(command, args, source)
  return { engine, settings, service, run, flashes }
}

const data = <T = Record<string, unknown>>(envelope: AppControlEnvelope): T => {
  assert.equal(envelope.ok, true, envelope.ok ? '' : `${envelope.error.code}: ${envelope.error.message}`)
  return (envelope as { data: T }).data
}

const errorCode = (envelope: AppControlEnvelope): string => {
  assert.equal(envelope.ok, false, 'expected a failure')
  return (envelope as { error: { code: string } }).error.code
}

/** The ref of the first element in a snapshot's text whose line contains `needle`. */
function refIn(text: string, needle: string): string {
  const line = text.split('\n').find((l) => l.includes(needle))
  assert.ok(line, `no line with ${needle} in:\n${text}`)
  return /@s[a-z0-9]+:e\d+/.exec(line!)![0]
}

/* ------------------------------------------------------------------ tree */

test('refs: formatted with their snapshot, parsed strictly, stale across an engine restart', () => {
  assert.equal(formatRef('s4k2p9xq', 12), '@s4k2p9xq:e12')
  assert.deepEqual(parseRef('@s4k2p9xq:e12'), { sid: 's4k2p9xq', n: 12 })
  assert.deepEqual(parseRef('s4k2p9xq:e3'), { sid: 's4k2p9xq', n: 3 })
  assert.throws(() => parseRef('e12'), /isn't a ref/)
  assert.throws(() => parseRef('@s4k2p9xq:e0'), /isn't a ref/)
  const refs = new RefStore()
  refs.add('s4k2p9xq', { pid: 1, name: 'Notes' }, 1)
  assert.doesNotThrow(() => refs.entry(parseRef('@s4k2p9xq:e1'), 1))
  assert.throws(() => refs.entry(parseRef('@s4k2p9xq:e1'), 2), /gone/)
  assert.throws(() => refs.entry(parseRef('@szzzzzz:e1'), 1), /gone/)
})

test('tree: macOS roles become the shared words, checkbox values become states, password values never appear', () => {
  const raw: RawNode = {
    n: 1,
    role: 'AXWindow',
    title: 'Doc',
    children: [
      { n: 2, role: 'AXCheckBox', title: 'Bold', value: '1', actions: ['AXPress'] },
      { n: 3, role: 'AXTextField', subrole: 'AXSecureTextField', title: 'Password', value: 'hunter2' },
      { n: 4, role: 'AXStaticText', value: 'Hello there' },
      { n: 5, role: 'AXButton', title: 'Go', enabled: false, actions: ['AXPress', 'AXShowMenu'] },
      { n: 6, role: 'AXRow', subrole: 'AXOutlineRow', expanded: false, selected: true }
    ]
  }
  const { node, summaries } = convertTree(raw, 'sabc123', 'darwin')
  const [check, password, label, button, row] = node.children!
  assert.equal(check.role, 'checkbox')
  assert.deepEqual(check.states, ['checked'])
  assert.equal(check.value, undefined)
  assert.equal(password.role, 'password')
  assert.equal(password.value, undefined)
  assert.equal(summaries.get(3)?.secure, true)
  assert.equal(label.role, 'text')
  assert.equal(label.name, 'Hello there')
  assert.deepEqual(button.states, ['disabled'])
  assert.deepEqual(button.actions, ['press'], 'menu and scroll actions every element has are left out')
  assert.equal(row.role, 'treeitem')
  assert.deepEqual(row.states, ['selected', 'collapsed'])
})

test('tree: the interactive view keeps what can be operated and dissolves unnamed wrappers', () => {
  const tree: UiNode = {
    ref: '@s1aaa:e1',
    role: 'window',
    name: 'Doc',
    children: [
      { ref: '@s1aaa:e2', role: 'group', children: [{ ref: '@s1aaa:e3', role: 'group', children: [{ ref: '@s1aaa:e4', role: 'button', name: 'Go' }] }] },
      { ref: '@s1aaa:e5', role: 'group', children: [{ ref: '@s1aaa:e6', role: 'image', name: 'logo' }] },
      { ref: '@s1aaa:e7', role: 'toolbar', children: [{ ref: '@s1aaa:e8', role: 'text', name: 'Label' }, { ref: '@s1aaa:e9', role: 'textfield', name: 'Search' }] }
    ]
  }
  const kept = interactiveOnly(tree)!
  assert.deepEqual(
    kept.children!.map((n) => n.ref),
    ['@s1aaa:e4', '@s1aaa:e7'],
    'the button is lifted out of its two wrappers; the image group is dropped; the toolbar stays as context'
  )
  assert.deepEqual(kept.children![1].children!.map((n) => n.role), ['textfield'])
})

test('tree: capping keeps the outline and says how much was cut; the text form carries refs and states', () => {
  const tree: UiNode = { ref: '@s1aaa:e1', role: 'list', children: Array.from({ length: 30 }, (_, i) => ({ ref: `@s1aaa:e${i + 2}`, role: 'row', name: `Row ${i}` })) }
  const { node, cut } = capNodes(tree, 10)
  assert.equal(node.children!.length, 9)
  assert.equal(node.more, 21)
  assert.equal(cut, 21)
  const text = treeText(node)
  assert.match(text, /^- list @s1aaa:e1$/m)
  assert.match(text, /^ {2}- row “Row 0” @s1aaa:e2$/m)
  assert.match(text, /… 21 more inside \(snapshot root=@s1aaa:e1\)/)
})

/* ------------------------------------------------------------------ argv */

test('argv: positionals, flags and options parse the way eaon-apps is documented', () => {
  assert.deepEqual(parseArgv(['snapshot', 'Calculator', '-i', '--depth', '4']), { command: 'snapshot', args: { app: 'Calculator', interactive: true, depth: 4 } })
  assert.deepEqual(parseArgv(['click', '@s4k2p9xq:e12']), { command: 'click', args: { ref: '@s4k2p9xq:e12' } })
  assert.deepEqual(parseArgv(['type', '@s4k2p9xq:e3', 'hello', 'world']), { command: 'type', args: { ref: '@s4k2p9xq:e3', text: 'hello world' } })
  assert.deepEqual(parseArgv(['type', '--app', 'Notes', 'hi there']), { command: 'type', args: { app: 'Notes', text: 'hi there' } })
  assert.deepEqual(parseArgv(['menu', '--app', 'TextEdit', 'File > Save As…']), { command: 'menu', args: { app: 'TextEdit', path: 'File > Save As…' } })
  assert.deepEqual(parseArgv(['press', 'cmd+s', '--app=Notes']), { command: 'press', args: { keys: 'cmd+s', app: 'Notes' } })
  assert.deepEqual(parseArgv(['wait', '--element', '@s1abc:e6', '--predicate', 'value', '--value', '7']), { command: 'wait', args: { ref: '@s1abc:e6', predicate: 'value', value: '7' } })
  assert.deepEqual(parseArgv(['list_apps', '--all']), { command: 'list-apps', args: { all: true } })
  assert.deepEqual(parseArgv([]), { command: 'guide', args: {} })
  assert.throws(() => parseArgv(['click', '@s1abc:e1', 'extra']), /Unexpected "extra"/)
  assert.throws(() => parseArgv(['snapshot', '--depth']), /needs a value/)
  assert.throws(() => parseArgv(['snapshot', '-z']), /Unknown option/)
})

/* --------------------------------------------------------------- service */

test('switch: off answers DISABLED for everything except status, version and guide', async () => {
  const { run } = setup({ enabled: false })
  assert.equal(errorCode(await run('snapshot', { app: 'Notes' })), 'DISABLED')
  assert.equal(errorCode(await run('click', { ref: '@s1abc:e1' })), 'DISABLED')
  assert.match(String(data(await run('guide')).guide), /observe, act, verify/)
  assert.equal(data<{ settings: AppControlSettings }>(await run('status')).settings.enabled, false)
})

test('unknown commands, screenshots, reserved and pointer commands refuse with their own codes', async () => {
  const { run } = setup()
  assert.equal(errorCode(await run('teleport')), 'UNKNOWN_COMMAND')
  const shot = await run('screenshot')
  assert.equal(errorCode(shot), 'UNKNOWN_COMMAND')
  assert.match(JSON.stringify(shot), /Computer use takes screenshots/)
  for (const reserved of ['key-down', 'key-up', 'mouse-down', 'mouse-up']) assert.equal(errorCode(await run(reserved)), 'RESERVED')
  for (const pointer of ['hover', 'drag', 'mouse-click', 'triple-click']) assert.equal(errorCode(await run(pointer)), 'NEEDS_POINTER')
})

test('observe → act → verify: snapshot, click a checkbox, read it back changed', async () => {
  const { run, flashes } = setup()
  const snap = data<{ text: string; snapshot: string; nodes: number }>(await run('snapshot', { app: 'Notes', interactive: true, compact: true }))
  assert.match(snap.text, /checkbox “Bold” @s\d+:e\d+ \[unchecked\]/)
  assert.doesNotMatch(snap.text, /logo/, 'the image is not operable')
  const bold = refIn(snap.text, '“Bold”')
  const clicked = data<{ after: UiNode }>(await run('click', { ref: bold }))
  assert.deepEqual(clicked.after.states, ['checked'], 'the action returns the element as it is afterwards')
  assert.deepEqual(data<{ result: boolean }>(await run('is', { ref: bold, state: 'checked' })).result, true)
  assert.equal(flashes.length, 1, 'the click was outlined')
  assert.match(flashes[0], /^Test chat: click checkbox “Bold” in Notes$/)
})

test('check and uncheck are idempotent and verify the state they set', async () => {
  const { run, engine } = setup()
  const bold = refIn(data<{ text: string }>(await run('snapshot', { app: 'Notes', compact: true })).text, '“Bold”')
  const first = data<{ changed: boolean }>(await run('check', { ref: bold }))
  assert.equal(first.changed, true)
  const presses = engine.calls.filter((c) => c.op === 'act').length
  const again = data<{ changed: boolean }>(await run('check', { ref: bold }))
  assert.equal(again.changed, false)
  assert.equal(engine.calls.filter((c) => c.op === 'act').length, presses, 'already checked: not pressed again')
  assert.equal(data<{ changed: boolean }>(await run('uncheck', { ref: bold })).changed, true)
})

test('click then wait for the text that should follow; a wait that never comes is TIMEOUT', async () => {
  const { run } = setup()
  const add = refIn(data<{ text: string }>(await run('snapshot', { app: 'Notes', compact: true })).text, 'button “Add”')
  const clicked = data<{ waited: { met: boolean } }>(await run('click', { ref: add, wait_text: 'Added!' }))
  assert.equal(clicked.waited.met, true)
  const never = await run('wait', { app: 'Notes', text: 'Never shows', timeout: 100 })
  assert.equal(errorCode(never), 'TIMEOUT')
})

test('find returns refs with where each one sits; typing and setting values reach the field', async () => {
  const { run, engine } = setup()
  const found = data<{ matches: (UiNode & { in?: string })[]; total: number }>(await run('find', { app: 'Notes', role: 'button' }))
  assert.deepEqual(found.matches.map((m) => m.name), ['Add', 'Share'])
  assert.equal(found.matches[0].in, 'application “Notes” › window “Untitled”')
  const body = data<{ matches: UiNode[] }>(await run('find', { app: 'Notes', name: 'body' })).matches[0]
  assert.equal(body.role, 'textarea')
  const typed = data<{ after: UiNode; typed: number }>(await run('type', { ref: body.ref, text: ', world' }))
  assert.equal(typed.after.value, 'Hello, world')
  assert.equal(typed.typed, 7)
  data(await run('set-value', { ref: body.ref, value: 'Replaced' }))
  assert.equal(engine.window.children![1].value, 'Replaced')
  data(await run('clear', { ref: body.ref }))
  assert.equal(engine.window.children![1].value, '')
})

test('password fields, Eaon itself and password managers are off limits', async () => {
  const { run, engine } = setup()
  const password = data<{ matches: UiNode[] }>(await run('find', { app: 'Notes', role: 'password' })).matches[0]
  assert.ok(password, 'the field is found…')
  assert.equal(password.value, undefined, '…but its value is never read')
  assert.equal(errorCode(await run('type', { ref: password.ref, text: 'secret' })), 'PROTECTED')
  assert.equal(errorCode(await run('set-value', { ref: password.ref, value: 'secret' })), 'PROTECTED')
  assert.equal(engine.window.children![2].value, undefined, 'nothing was typed')
  assert.equal(errorCode(await run('snapshot', { app: 'Eaon' })), 'PROTECTED')
  assert.equal(errorCode(await run('snapshot', { app: String(EAON) })), 'PROTECTED')
  assert.equal(errorCode(await run('snapshot', { app: '1Password' })), 'PROTECTED')
  assert.equal(errorCode(await run('launch', { app: 'com.1password.1password' })), 'PROTECTED')
  const listed = data<{ apps: { name: string; protected?: boolean }[] }>(await run('list-apps'))
  assert.deepEqual(listed.apps.filter((a) => a.protected).map((a) => a.name), ['Eaon', '1Password'])
  assert.equal(engine.calls.some((c) => c.op === 'snapshot' && (c.params.pid === EAON || c.params.pid === VAULT)), false, 'the engine was never asked to read them')
})

test('protected apps are matched by bundle id, process name or pid', () => {
  const own = new Set([4242])
  assert.equal(protectedEntry({ pid: 4242, name: 'Electron' }, own), 'Eaon')
  assert.equal(protectedEntry({ pid: 1, name: 'Keychain Access', bundleId: 'com.apple.keychainaccess' }, own), 'Keychain Access')
  assert.equal(protectedEntry({ pid: 1, name: 'KeePassXC', path: 'C:\\Program Files\\KeePassXC\\KeePassXC.exe' }, own), 'KeePassXC')
  assert.equal(protectedEntry({ pid: 1, name: 'consent', path: 'C:\\Windows\\System32\\consent.exe' }, own), 'Windows sign-in and UAC prompts')
  assert.equal(protectedEntry({ pid: 1, name: 'TextEdit', bundleId: 'com.apple.TextEdit' }, own), null)
})

test('a ref whose element went away, or whose snapshot is gone, is STALE_REF', async () => {
  const { run, engine } = setup()
  const share = refIn(data<{ text: string }>(await run('snapshot', { app: 'Notes', compact: true })).text, '“Share”')
  engine.window.children![0].children![0].children![3].gone = true
  assert.equal(errorCode(await run('click', { ref: share })), 'STALE_REF')
  assert.equal(errorCode(await run('click', { ref: '@s999999:e1' })), 'STALE_REF')
  engine.epoch += 1
  const before = refIn(data<{ text: string }>(await run('snapshot', { app: 'Notes', compact: true })).text, '“Bold”')
  engine.epoch += 1
  assert.equal(errorCode(await run('click', { ref: before })), 'STALE_REF', 'refs from before the engine restarted are stale')
})

test('menu presses a menu-bar item by path; a greyed-out or missing one says so', async () => {
  const { run, engine } = setup()
  data(await run('menu', { app: 'Notes', path: 'File > Save As...' }))
  assert.equal(engine.savedAs, true, 'trailing dots match the ellipsis')
  assert.equal(errorCode(await run('menu', { app: 'Notes', path: 'File > Print…' })), 'ACTION_FAILED')
  const missing = await run('menu', { app: 'Notes', path: 'File > Export' })
  assert.equal(errorCode(missing), 'ELEMENT_NOT_FOUND')
  assert.match(JSON.stringify(missing), /There: Save As…, Print…/)
  assert.equal(errorCode(await run('menu', { app: 'Notes', path: 'File' })), 'INVALID_ARGS')
})

test('select opens a pop-up and picks the option by name', async () => {
  const { run, engine } = setup()
  const size = data<{ matches: UiNode[] }>(await run('find', { app: 'Notes', role: 'popup' })).matches[0]
  const picked = data<{ picked: string }>(await run('select', { ref: size.ref, option: 'large' }))
  assert.equal(picked.picked, 'Large')
  assert.equal(engine.window.children![0].children![0].children![1].value, 'Large')
  assert.equal(errorCode(await run('select', { ref: size.ref, option: 'Huge' })), 'ELEMENT_NOT_FOUND')
  assert.ok(engine.calls.some((c) => c.op === 'keys' && c.params.key === 'escape'), 'the menu opened for nothing is closed again')
})

test('press validates the combo and sends it to the app; apps are found by name, bundle id or pid', async () => {
  const { run, engine } = setup()
  data(await run('press', { keys: 'cmd+shift+s', app: 'notes' }))
  assert.deepEqual(engine.calls.at(-1), { op: 'keys', params: { pid: NOTES, key: 's', modifiers: ['shift', 'cmd'], repeat: 1 } })
  assert.equal(errorCode(await run('press', { keys: 'cmd+banana', app: 'Notes' })), 'INVALID_ARGS')
  assert.equal(errorCode(await run('press', { keys: 'shift', app: 'Notes' })), 'INVALID_ARGS')
  assert.equal(errorCode(await run('snapshot', { app: 'Nope' })), 'APP_NOT_FOUND')
  assert.equal(data<{ app: { pid: number } }>(await run('snapshot', { app: 'com.example.notes' })).app.pid, NOTES)
})

test('batch runs steps in order and stops at the first failure unless told to keep going', async () => {
  const { run } = setup()
  const bold = refIn(data<{ text: string }>(await run('snapshot', { app: 'Notes', compact: true })).text, '“Bold”')
  const stopped = data<{ ran: number; of: number }>(await run('batch', { commands: [{ command: 'click', ref: bold }, { command: 'click', ref: '@s999999:e1' }, { command: 'wait', ms: 1 }] }))
  assert.deepEqual([stopped.ran, stopped.of], [2, 3])
  const kept = data<{ ran: number }>(await run('batch', { commands: JSON.stringify([{ command: 'click', ref: '@s999999:e1' }, { command: 'wait', ms: 1 }]), keep_going: true }))
  assert.equal(kept.ran, 2)
  assert.equal(errorCode(await run('batch', { commands: [{ command: 'batch', commands: [] }] })), 'INVALID_ARGS')
})

test('the activity list records who did what, never the typed words, and nothing for quiet reads', async () => {
  const { run, service, settings, flashes } = setup()
  const body = data<{ matches: UiNode[] }>(await run('find', { app: 'Notes', name: 'Body' })).matches[0]
  await run('type', { ref: body.ref, text: 'my secret plan' })
  await run('status')
  await run('guide')
  const entries = service.trace.recent()
  assert.deepEqual(entries.map((e) => e.command), ['type', 'find'])
  assert.equal(entries[0].target, 'textarea “Body” in Notes')
  assert.equal(JSON.stringify(entries).includes('secret'), false)
  settings.showActions = false
  const before = flashes.length
  await run('type', { ref: body.ref, text: 'x' })
  assert.equal(flashes.length, before, 'no outline with the switch off')
})

/* ------------------------------------------------------------------ tool */

const toolCtx = { request: { chatId: 'c1', messageId: 'm1', chatTitle: 'Plan the trip' }, signal: new AbortController().signal } as unknown as ToolContext

test('the agent tool: reads run freely, actions go through approval, risky ones ask even in Approve for me', async () => {
  const { service, run } = setup()
  const tool = appControlTool(service)
  const mutating = tool.mutating as (input: Record<string, unknown>, ctx: ToolContext) => boolean
  assert.equal(mutating({ action: 'snapshot', app: 'Notes' }, toolCtx), false)
  assert.equal(mutating({ action: 'find', app: 'Notes', role: 'button' }, toolCtx), false)
  assert.equal(mutating({ action: 'click', ref: '@s1abc:e1' }, toolCtx), true)
  assert.equal(mutating({ action: 'batch', commands: [{ command: 'snapshot' }, { command: 'click' }] }, toolCtx), true)
  assert.equal(tool.risky!({ action: 'press', keys: 'cmd+q', app: 'Notes' }, toolCtx), true)
  assert.equal(tool.risky!({ action: 'press', keys: 'cmd+s', app: 'Notes' }, toolCtx), false)
  assert.equal(tool.risky!({ action: 'type', app: 'Terminal', text: 'rm -rf ~' }, toolCtx), true)
  assert.equal(tool.risky!({ action: 'type', app: 'Notes', text: 'rm -rf ~' }, toolCtx), false, 'words in a document only sit there')
  assert.equal(tool.risky!({ action: 'quit_app', app: 'Notes', force: true }, toolCtx), true)
  const text = String(await tool.run({ action: 'snapshot', app: 'Notes', interactive: true }, toolCtx))
  assert.match(text, /^\{"app":\{"name":"Notes","pid":100\},"snapshot":"s\d+","nodes":\d+\}\n- window “Untitled”/, 'a snapshot reaches the model as its compact text')
  const bold = refIn(text, '“Bold”')
  assert.equal(tool.describe!({ action: 'click', ref: bold }), 'click → checkbox “Bold” in Notes')
  assert.equal(tool.describe!({ action: 'menu', app: 'Notes', path: 'File > Save As…' }), 'menu “File > Save As…” → Notes')
  const failed = await tool.run({ action: 'click', ref: '@s999999:e1' }, toolCtx)
  assert.deepEqual(typeof failed === 'object' && failed.isError, true)
  const entry = service.trace.recent()[0]
  assert.deepEqual(entry.source, { kind: 'chat', name: 'Plan the trip' })
  void run
})

test('commandRisk names what makes a step risky', () => {
  assert.match(commandRisk('press', { keys: 'cmd+q' }, 'Notes', 'darwin') ?? '', /quits/)
  assert.equal(commandRisk('type', { text: 'ls -la\n' }, 'iTerm2', 'darwin'), 'types a command into a terminal and runs it')
  assert.equal(commandRisk('type', { text: 'hello' }, 'Terminal', 'darwin'), null)
  assert.equal(commandRisk('click', {}, 'Notes', 'darwin'), null)
  assert.ok(findCommand('list_windows'), 'snake_case names resolve')
})
