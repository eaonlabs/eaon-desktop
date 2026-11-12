import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, modAccess, needsReview, parseManifest, safeModPath, toolHost, type ModManifest } from '@shared/mods'
import { claudeParts, diskFiles, modDataFile, modDir, readModFolder, readModPack } from '../src/main/features/mods/files'
import * as mods from '../src/main/features/mods/service'
import { withMods } from '../src/main/features/mods/launch'
import { buildToolUrl, modAgentTools, pickJson } from '../src/main/features/mods/tools'
import { modInstructions, panelPolicy, serveModFile } from '../src/main/features/mods'
import { store } from '../src/main/store'
import { highlight, setModLanguages } from '../src/renderer/src/components/agent/highlight'
import { expandSnippet } from '../src/renderer/src/lib/snippets'

/**
 * Mods (shared/mods.ts, main/features/mods): the format, what the install
 * screen says a mod can touch, installing and removing, the bundled starter
 * mods, and each place a mod reaches into: the CLIs Eaon starts, agents'
 * tools, Chat's instructions, panels, the highlighter and the editor.
 */

const BUNDLED = join(process.cwd(), 'resources', 'mods')
const root = mkdtempSync(join(tmpdir(), 'eaon-mods-'))
process.env.EAON_MODS_DIR = root
process.env.EAON_BUNDLED_MODS = BUNDLED

const base = (contributes: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  id: 'jane.example',
  name: 'Example',
  version: '1.0.0',
  publisher: 'Jane',
  description: 'An example mod.',
  category: 'commands',
  contributes,
  ...extra
})

const parsed = (raw: Record<string, unknown>): ModManifest => {
  const result = parseManifest(raw)
  assert.ok(result.ok, result.ok ? '' : result.error)
  return result.manifest
}

/** A mod folder of `files` (mod.json given as an object), somewhere temporary. */
function folder(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-mod-src-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

beforeEach(async () => {
  await store.flushWrites()
  store.setJson('mods.json', {})
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  mods.resetModsCache()
})

/* -------------------------------------------------------------- the format */

test('a manifest is checked strictly and trimmed to what this version knows', () => {
  const m = parsed(base({ commands: [{ name: 'tldr', description: 'Summarize', prompt: 'Summarize:\n\n' }], someday: true }, { extra: 1 }))
  assert.equal(m.contributes.commands?.[0].name, 'tldr')
  assert.ok(!('extra' in m) && !('someday' in m.contributes), 'unknown fields are dropped, not refused')

  const bad: [Record<string, unknown>, RegExp][] = [
    [base({}, { schema: 2 }), /schema/],
    [base({ commands: [] }), /add nothing/],
    [base({ commands: [{ name: 'x' }] }, { id: 'Jane Example' }), /id must be/],
    [base({ commands: [{ name: 'x', description: 'd', prompt: 'p' }] }, { version: '1.0' }), /version/],
    [base({ commands: [{ name: 'Bad Name', description: 'd', prompt: 'p' }] }), /lowercase/],
    [base({ commands: [{ name: 'a', description: 'd', prompt: 'p' }, { name: 'a', description: 'd', prompt: 'p' }] }), /two entries/],
    [base({ tools: [{ name: 'evil', description: 'd', url: 'https://{host}/x', params: [{ name: 'host', type: 'string', description: 'd' }] }] }), /fixed host/],
    [base({ tools: [{ name: 'plain', description: 'd', url: 'http://example.com/x', params: [] }] }), /https/],
    [base({ tools: [{ name: 'missing', description: 'd', url: 'https://example.com/{q}', params: [] }] }), /isn’t one of its params|isn't one of its params/],
    [base({ sessionPresets: [{ id: 'p', name: 'P', description: 'd', panes: [{ agent: 'rm -rf' }] }] }), /isn't an agent/],
    [base({ sessionPresets: [{ id: 'p', name: 'P', description: 'd', panes: [{ agent: 'shell', prompt: 'echo hi' }] }] }), /shell pane/],
    [base({ panels: [{ id: 'p', title: 'P', description: 'd', entry: '../outside.html', host: [] }] }), /inside the mod/],
    [base({ panels: [{ id: 'p', title: 'P', description: 'd', entry: 'p.html', host: ['network'] }] }), /must be one of/],
    [base({ widgets: [{ id: 'w', kind: 'clock', label: 'X', timeZone: 'Mars/Olympus' }] }), /time zone/],
    [base({ appThemes: [{ name: 'T', light: { accent: 'red', background: '#FFFFFF', foreground: '#000000', contrast: 40 }, dark: {} }] }), /colour/],
    [base({ claudePlugin: '/abs/path' }), /inside the mod/],
    [base({ codex: { mcpServers: { 'Bad-Name': { command: 'x' } } } }), /lowercase/]
  ]
  for (const [raw, message] of bad) {
    const result = parseManifest(raw)
    assert.ok(!result.ok, `should refuse ${JSON.stringify(raw.contributes)}`)
    assert.match(result.error, message)
  }
})

test('paths inside a mod stay inside it', () => {
  assert.equal(safeModPath('panel.html'), 'panel.html')
  assert.equal(safeModPath('./claude/.claude-plugin/plugin.json'), 'claude/.claude-plugin/plugin.json')
  assert.equal(safeModPath('claude\\commands\\x.md'), 'claude/commands/x.md')
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', '.git/config', 'a//b', '']) assert.equal(safeModPath(bad), null, bad)
})

test('versions compare by their numbers', () => {
  assert.ok(compareVersions('1.10.0', '1.2.9') > 0)
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
  assert.ok(compareVersions('0.9.9', '1.0.0') < 0)
})

/* ------------------------------------------------------- what it can touch */

test('the install screen lists what a mod can touch, and only reach or code needs a review', () => {
  const looks = parsed(base({ appThemes: [{ name: 'T', light: { accent: '#112233', background: '#FFFFFF', foreground: '#000000', contrast: 40 }, dark: { accent: '#112233', background: '#000000', foreground: '#FFFFFF', contrast: 50 } }] }, { category: 'themes' }))
  assert.equal(needsReview(modAccess(looks, null)), false)

  const reach = parsed(base({ tools: [{ name: 'lookup', description: 'd', url: 'https://api.example.com/v1/{q}', params: [{ name: 'q', type: 'string', description: 'd', required: true }] }], instructions: 'Be brief.' }))
  const rows = modAccess(reach, null)
  assert.ok(needsReview(rows))
  assert.ok(rows.some((r) => r.level === 'access' && r.text.includes('api.example.com')), 'names the host its tools reach')
  assert.ok(rows.some((r) => r.level === 'access' && r.detail === 'Be brief.'), 'shows the instructions word for word')

  const panel = parsed(base({ panels: [{ id: 'notes', title: 'Notes', description: 'd', entry: 'p.html', host: ['storage'] }] }))
  const panelRows = modAccess(panel, null)
  assert.equal(panelRows[0].level, 'code', 'code first')
  assert.match(panelRows[0].detail ?? '', /No network/)

  const hooks = parsed(base({ claudePlugin: 'claude' }, { category: 'cli' }))
  const hookRows = modAccess(hooks, { commands: ['x'], skills: [], agents: [], hooks: ['PreToolUse (Bash): sh guard.sh'], mcpServers: [] })
  assert.ok(hookRows.some((r) => r.level === 'code' && r.detail?.includes('sh guard.sh')), 'a hook’s command is shown as it runs')
  assert.equal(toolHost('https://api.example.com/x?y={y}'), 'api.example.com')
  assert.equal(toolHost('https://{x}.example.com/'), null)
})

/* --------------------------------------------------------- the starter mods */

test('every bundled mod loads, is Eaon’s, and its parts check out', () => {
  const dirs = readdirSync(BUNDLED).filter((d) => !d.startsWith('.'))
  assert.ok(dirs.length >= 20 && dirs.length <= 40, `${dirs.length} starter mods`)
  const ids = new Set<string>()
  const categories = new Set<string>()
  for (const dir of dirs) {
    const read = readModFolder(join(BUNDLED, dir))
    assert.ok(read.ok, `${dir}: ${read.ok ? '' : read.error}`)
    if (!read.ok) continue
    const { manifest } = read
    assert.ok(manifest.id.startsWith('eaon.'), manifest.id)
    assert.equal(manifest.publisher, 'Eaon')
    assert.ok(!ids.has(manifest.id), `two mods are ${manifest.id}`)
    ids.add(manifest.id)
    categories.add(manifest.category)
    // Plain copy: no em dashes in anything the user reads.
    assert.doesNotMatch(readFileSync(join(BUNDLED, dir, 'mod.json'), 'utf8'), /—/, `${dir} has an em dash`)
    if (manifest.contributes.claudePlugin) {
      const parts = claudeParts(diskFiles(join(BUNDLED, dir)), manifest.contributes.claudePlugin)
      assert.ok(parts.commands.length + parts.skills.length + parts.agents.length + parts.hooks.length > 0, `${dir}'s plugin adds something`)
    }
  }
  for (const category of ['themes', 'commands', 'instructions', 'editor', 'panels', 'workers', 'tools', 'ade', 'cli', 'sounds']) {
    assert.ok(categories.has(category), `a starter mod for ${category}`)
  }
})

test('the bundled Claude Code plugins hold what their mods say', () => {
  const parts = (dir: string): ReturnType<typeof claudeParts> => claudeParts(diskFiles(join(BUNDLED, dir)), 'claude')
  assert.deepEqual(parts('claude-git').commands, ['changelog', 'commit-message', 'pr-description'])
  assert.deepEqual(parts('claude-helpers').agents, ['code-reviewer', 'test-writer'])
  assert.deepEqual(parts('claude-helpers').skills, ['release-notes'])
  const guard = parts('claude-guardrails')
  assert.equal(guard.hooks.length, 1)
  assert.match(guard.hooks[0], /^PreToolUse \(Bash\): sh "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/guard\.sh"/)
})

/* ---------------------------------------------------- installing, removing */

test('a bundled mod installs, turns off and on, and uninstalls without a trace', async () => {
  const before = mods.listMods()
  const scratch = before.mods.find((m) => m.manifest.id === 'eaon.panel-scratchpad')!
  assert.ok(scratch.official && !scratch.installed)
  assert.ok(needsReview(scratch.access), 'a panel runs code, so it is reviewed')

  mods.installBundled('eaon.panel-scratchpad')
  assert.ok(existsSync(join(modDir('eaon.panel-scratchpad'), 'panel.html')))
  assert.deepEqual(mods.enabledMods().map((m) => m.id), ['eaon.panel-scratchpad'])
  assert.equal(mods.listMods().mods.find((m) => m.manifest.id === 'eaon.panel-scratchpad')?.installed, true)

  mods.setEnabled('eaon.panel-scratchpad', false)
  assert.deepEqual(mods.enabledMods(), [])
  assert.equal(serveModFile('eaon-mod://eaon.panel-scratchpad/panel.html').status, 404, 'a mod that is off serves nothing')
  mods.setEnabled('eaon.panel-scratchpad', true)

  mkdirSync(join(root, '.data'), { recursive: true })
  writeFileSync(modDataFile('eaon.panel-scratchpad'), '{"notes":"hi"}')
  mods.uninstall('eaon.panel-scratchpad')
  assert.ok(!existsSync(modDir('eaon.panel-scratchpad')))
  assert.ok(!existsSync(modDataFile('eaon.panel-scratchpad')), 'its saved notes go too')
  assert.equal(mods.listMods().mods.find((m) => m.manifest.id === 'eaon.panel-scratchpad')?.installed, false)
})

test('a mod from a folder is reviewed first, installs as reviewed, and can’t pass as Eaon’s', () => {
  const dir = folder({
    'mod.json': base({ commands: [{ name: 'hello', description: 'Say hello', prompt: 'Hello' }] }),
    'README.md': '# Example',
    '.git/HEAD': 'ref: refs/heads/main'
  })
  const { token, info } = mods.inspectFolder(dir)
  assert.equal(info.official, false)
  assert.equal(info.installed, false)
  assert.ok(!existsSync(modDir('jane.example')), 'nothing installs before Install')
  mods.installStaged(token)
  assert.ok(existsSync(join(modDir('jane.example'), 'README.md')))
  assert.ok(!existsSync(join(modDir('jane.example'), '.git')), 'dotfiles are left behind')
  assert.equal(mods.listMods().mods.find((m) => m.manifest.id === 'jane.example')?.official, false, 'no verified mark')
  assert.throws(() => mods.installStaged(token), /expired/, 'a token installs once')

  const impostor = folder({ 'mod.json': base({ commands: [{ name: 'x', description: 'd', prompt: 'p' }] }, { id: 'eaon.not-really' }) })
  assert.throws(() => mods.inspectFolder(impostor), /kept for Eaon/)
})

test('a folder with a link in it, or a panel that is missing, is refused whole', () => {
  const linked = folder({ 'mod.json': base({ commands: [{ name: 'x', description: 'd', prompt: 'p' }] }) })
  symlinkSync('/etc/hosts', join(linked, 'hosts'))
  assert.throws(() => mods.inspectFolder(linked), /link/)
  const missing = folder({ 'mod.json': base({ panels: [{ id: 'p', title: 'P', description: 'd', entry: 'gone.html', host: [] }] }) })
  assert.throws(() => mods.inspectFolder(missing), /isn’t in the mod/)
})

test('a packed mod carries its files in one JSON document', () => {
  const pack = { eaonMod: 1, manifest: base({ panels: [{ id: 'p', title: 'P', description: 'd', entry: 'p.html', host: [] }] }), files: { 'p.html': '<p>hi</p>' } }
  const read = readModPack(pack)
  assert.ok(read.ok)
  assert.equal(read.files.get('p.html')?.toString(), '<p>hi</p>')
  assert.ok(!readModPack({ ...pack, files: { '../escape.html': 'x' } }).ok)
  assert.ok(!readModPack({ ...pack, files: { 'mod.json': '{}' } }).ok, 'a pack can’t smuggle in a second manifest')
  assert.ok(!readModPack({ manifest: pack.manifest }).ok)
  const { token } = mods.inspectPackText(JSON.stringify(pack), { kind: 'file', path: '/tmp/example.json' })
  mods.installStaged(token)
  assert.equal(readFileSync(join(modDir('jane.example'), 'p.html'), 'utf8'), '<p>hi</p>')
})

test('a bundled mod updates itself when it asks for nothing new, and waits for a review when it does', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'eaon-bundle-'))
  cpSync(join(BUNDLED, 'writing-commands'), join(bundle, 'writing-commands'), { recursive: true })
  process.env.EAON_BUNDLED_MODS = bundle
  try {
    mods.resetModsCache()
    mods.installBundled('eaon.writing-commands')
    const file = join(bundle, 'writing-commands', 'mod.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))

    // Same access, newer version: applied at startup.
    manifest.version = '1.0.1'
    writeFileSync(file, JSON.stringify(manifest))
    mods.resetModsCache()
    mods.syncBundledMods()
    assert.equal(mods.enabledMods().find((m) => m.id === 'eaon.writing-commands')?.version, '1.0.1')

    // A version that adds instructions to every chat: held for review.
    manifest.version = '1.1.0'
    manifest.contributes.instructions = 'Always answer in French.'
    writeFileSync(file, JSON.stringify(manifest))
    mods.resetModsCache()
    mods.syncBundledMods()
    const info = mods.listMods().mods.find((m) => m.manifest.id === 'eaon.writing-commands')!
    assert.equal(info.manifest.version, '1.0.1')
    assert.equal(info.update, '1.1.0')
  } finally {
    process.env.EAON_BUNDLED_MODS = BUNDLED
    mods.resetModsCache()
  }
})

test('a mod index lists only checked, non-Eaon, https mods', () => {
  const good = parsed(base({ commands: [{ name: 'x', description: 'd', prompt: 'p' }] }))
  const index = mods.parseIndex(
    JSON.stringify({
      name: 'Jane’s mods',
      mods: [
        { url: 'packs/example.json', manifest: good },
        { url: 'http://insecure.example/x.json', manifest: { ...good, id: 'jane.two' } },
        { url: 'x.json', manifest: { ...good, id: 'eaon.fake' } },
        { url: 'x.json', manifest: { broken: true } }
      ]
    }),
    'https://mods.example.com/index.json'
  )
  assert.equal(index.name, 'Jane’s mods')
  assert.deepEqual(index.entries.map((e) => e.url), ['https://mods.example.com/packs/example.json'])
})

test('mods are only downloaded over https, and never from the local network', async () => {
  await assert.rejects(mods.fetchText('http://example.com/mod.json'), /https/)
  await assert.rejects(mods.fetchText('https://localhost/mod.json'), /local network/)
  await assert.rejects(mods.fetchText('https://192.168.1.10/mod.json'), /local network/)
  await assert.rejects(mods.fetchText('not a link'), /isn’t a link/)
})

/* --------------------------------------------------- the CLIs Eaon starts */

const claudeMod = parsed(base({ claudePlugin: 'claude' }, { id: 'jane.claude', category: 'cli' }))
const codexMod = parsed(
  base({ codex: { instructions: 'Run the tests first.\nThen say "done".', mcpServers: { notes: { command: 'npx', args: ['-y', 'notes-mcp'] } } } }, { id: 'jane.codex', category: 'cli' })
)
const dirOf = (id: string): string => `/Users/me/Library/Application Support/Eaon/mods/${id}`

test('Claude Code gets each mod’s plugin with --plugin-dir, right after its binary', () => {
  const line = withMods('claude --dangerously-skip-permissions --resume abc', [claudeMod, codexMod], dirOf, 'posix')
  assert.equal(line, "claude --plugin-dir '/Users/me/Library/Application Support/Eaon/mods/jane.claude/claude' --dangerously-skip-permissions --resume abc")
  assert.match(withMods('/opt/bin/claude', [claudeMod], dirOf, 'powershell'), /^\/opt\/bin\/claude --plugin-dir '.*jane\.claude\\claude'$|^\/opt\/bin\/claude --plugin-dir '.*jane\.claude\/claude'$/)
  assert.equal(withMods('claude', [codexMod], dirOf, 'posix'), 'claude', 'a mod with nothing for Claude adds nothing')
})

test('Codex gets instructions and MCP servers as -c overrides that TOML reads back', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  const line = withMods('codex resume 123', [codexMod], dirOf, 'posix', { codexHome: home })
  assert.ok(line.startsWith('codex -c '), line)
  assert.ok(line.endsWith(' resume 123'), 'the subcommand stays last')
  assert.ok(line.includes(`'developer_instructions="Run the tests first.\\nThen say \\"done\\"."'`), line)
  assert.ok(line.includes(`'mcp_servers.notes.command="npx"'`))
  assert.ok(line.includes(`'mcp_servers.notes.args=["-y","notes-mcp"]'`))

  // The user's own config wins: an override would replace it for the session.
  writeFileSync(join(home, 'config.toml'), 'developer_instructions = "Mine"\n[mcp_servers.notes]\ncommand = "mine"\n')
  assert.equal(withMods('codex', [codexMod], dirOf, 'posix', { codexHome: home }), 'codex')
})

test('other programs, and lines with no mods, are left alone', () => {
  assert.equal(withMods('gemini --yolo', [claudeMod, codexMod], dirOf, 'posix'), 'gemini --yolo')
  assert.equal(withMods('claude', [], dirOf, 'posix'), 'claude')
  assert.equal(withMods('claudette', [claudeMod], dirOf, 'posix'), 'claudette')
})

/* ----------------------------------------------------------- agents' tools */

const weather = parsed(
  base({
    tools: [
      {
        name: 'forecast',
        description: 'Weather',
        url: 'https://api.example.com/v1/forecast?lat={lat}&q={q}&unit={unit}',
        params: [
          { name: 'lat', type: 'number', description: 'Latitude', required: true },
          { name: 'q', type: 'string', description: 'Query' },
          { name: 'unit', type: 'string', description: 'Unit', enum: ['c', 'f'] }
        ],
        pick: ['current.temp', 'days.*.max']
      }
    ]
  })
)

test('a tool’s URL is filled in encoded, and its host can’t be changed by an argument', () => {
  const tool = weather.contributes.tools![0]
  assert.equal(buildToolUrl(tool, { lat: 38.7, q: 'a b&c=d' }).toString(), 'https://api.example.com/v1/forecast?lat=38.7&q=a+b%26c%3Dd')
  assert.equal(buildToolUrl(tool, { lat: 1, q: '@evil.example/x' }).hostname, 'api.example.com')
  assert.throws(() => buildToolUrl(tool, {}), /lat is required/)
  assert.throws(() => buildToolUrl(tool, { lat: 1, unit: 'kelvin' }), /must be one of/)
  assert.deepEqual(pickJson({ current: { temp: 12, wind: 3 }, days: [{ max: 20, min: 9 }, { max: 18 }] }, tool.pick!), { 'current.temp': 12, 'days.*.max': [20, 18] })
})

test('mods’ tools are offered as read-only tools that say where they reach', () => {
  const [tool] = modAgentTools([weather])
  assert.equal(tool.name, 'forecast')
  assert.equal(tool.mutating, false)
  assert.match(tool.description, /api\.example\.com/)
  assert.deepEqual((tool.inputSchema as { required: string[] }).required, ['lat'])
})

/* ------------------------------------------------------------- Chat, panels */

test('Chat is told the enabled mods’ instructions, each under its mod’s name', () => {
  assert.equal(modInstructions([]), '')
  const text = modInstructions([parsed(base({ instructions: 'Answer in plain words.' }, { name: 'Plain' }))])
  assert.match(text, /From the Plain mod:\nAnswer in plain words\./)
})

test('a panel is served only from its own enabled mod, under a policy with no network', () => {
  mods.installBundled('eaon.panel-json')
  const ok = serveModFile('eaon-mod://eaon.panel-json/panel.html')
  assert.equal(ok.status, 200)
  const policy = ok.headers.get('content-security-policy') ?? ''
  assert.match(policy, /connect-src 'none'/)
  assert.match(policy, /default-src 'none'/)
  assert.match(policy, /script-src eaon-mod:\/\/eaon\.panel-json /)
  assert.equal(policy, panelPolicy('eaon.panel-json'))
  for (const bad of ['eaon-mod://eaon.panel-json/../mods.json', 'eaon-mod://eaon.panel-json/mod.sh', 'eaon-mod://eaon.panel-time/panel.html', 'eaon-mod://eaon.panel-json/.data']) {
    assert.equal(serveModFile(bad).status, 404, bad)
  }
})

/* ---------------------------------------------------- languages, snippets */

test('a mod’s language is coloured from its word lists, and Eaon’s own names win', () => {
  setModLanguages([
    { id: 'lua', name: 'Lua', aliases: ['lua', 'ts'], lineComment: ['--'], blockComment: ['--[[', ']]'], strings: ['"'], keywords: ['local', 'function', 'end'], literals: ['nil'] }
  ])
  const kinds = (code: string, lang: string): string[] => highlight(code, lang).filter((t) => t.kind).map((t) => `${t.kind}:${t.text}`)
  assert.deepEqual(kinds('local x = nil -- note', 'lua'), ['keyword:local', 'literal:nil', 'comment:-- note'])
  assert.deepEqual(kinds('endpoint = "end"', 'lua'), ['string:"end"'], 'a keyword inside a longer word stays plain')
  assert.ok(kinds('const x = 1', 'ts').includes('keyword:const'), '"ts" is still TypeScript')
  // Delimiters are escaped, never run as a pattern of their own.
  setModLanguages([{ id: 'odd', name: 'Odd', aliases: ['odd'], lineComment: ['(*'], keywords: ['a+b'] }])
  assert.deepEqual(kinds('1 (* a note', 'odd'), ['number:1', 'comment:(* a note'])
  setModLanguages([])
  assert.deepEqual(kinds('local x', 'lua'), [])
})

test('a snippet expands at its prefix with the line’s indent, and the caret goes to $0', () => {
  const snippets = [{ prefix: 'fn', description: 'f', languages: ['ts'], body: 'function name() {\n  $0\n}' }]
  const text = 'class A {\n  fn'
  const edit = expandSnippet(text, text.length, 'ts', snippets)!
  const after = text.slice(0, edit.from) + edit.text + text.slice(edit.to)
  assert.equal(after, 'class A {\n  function name() {\n    \n  }')
  assert.equal(after.slice(0, edit.caret), 'class A {\n  function name() {\n    ')
  assert.equal(expandSnippet(text, text.length, 'py', snippets), null, 'another language')
  assert.equal(expandSnippet('xfnz', 3, 'ts', snippets), null, 'not a whole word')
})
