import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

/**
 * Every button in the renderer does something. 2026.6.1 shipped several that
 * didn't: General's "Import", the browser panel's "Expand", Configuration's
 * "Open config.toml" and "Reinstall", an Appshots "Delete". This reads every
 * .tsx file and fails on a <button> or <MenuItem> with no handler.
 *
 * What counts as doing something: onClick (or onMouseDown/onPointerDown),
 * type="submit" inside a form, or props spread in from a caller. A button
 * that is always disabled (`disabled` with no value) is a status shown in a
 * button's shape, like "Waiting for your browser…", and is allowed.
 */

const root = process.cwd()
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.tsx') ? [path] : []
  })

function deadControls(): string[] {
  const found: string[] = []
  for (const file of walk(join(root, 'src/renderer/src'))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source)
        if (tag === 'button' || tag === 'MenuItem') {
          const props = node.attributes.properties
          const named = (name: string): ts.JsxAttribute | undefined =>
            props.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === name)
          const acts =
            ['onClick', 'onMouseDown', 'onPointerDown'].some((name) => named(name)) ||
            props.some((p) => ts.isJsxSpreadAttribute(p)) ||
            /submit/.test(named('type')?.getText(source) ?? '')
          const alwaysDisabled = named('disabled') !== undefined && named('disabled')!.initializer === undefined
          if (!acts && !alwaysDisabled) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
            found.push(`${relative(root, file)}:${line + 1} <${tag}>`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

test('no button or menu item in the app is dead', () => {
  assert.deepEqual(deadControls(), [])
})

test('the settings that nothing read are gone from Settings', () => {
  const read = (path: string): string => readFileSync(join(root, 'src/renderer/src/components', path), 'utf8')
  const general = read('settings/pages/General.tsx')
  for (const dead of ['fileOpenDestination', 'language', 'showInMenuBar', 'bottomPanel', 'Import work from other AI apps', 'opensource.org']) {
    assert.ok(!general.includes(dead), `General still offers ${dead}`)
  }
  const configuration = read('settings/pages/Configuration.tsx')
  for (const dead of ['configScope', 'approvalPolicy', 'sandbox:', 'outputDetail', 'reasoningSummary', 'workspaceDependencies', '26.819.11345', 'setTimeout']) {
    assert.ok(!configuration.includes(dead), `Configuration still offers ${dead}`)
  }
  const mcp = read('settings/pages/McpServers.tsx')
  assert.ok(!mcp.includes('useDedicatedRoutingModel') && !mcp.includes('routingModelId'), 'MCP still offers the routing model nothing used')
  const browser = read('settings/pages/Misc.tsx')
  assert.ok(!browser.includes('blockTrackers') && !browser.includes('localStorage') && !browser.includes('AppshotsPage'))
  const panel = read('BrowserPanel.tsx')
  assert.ok(!panel.includes('importedFromChrome') && !panel.includes('Maximize2'), 'the browser panel still has its fake Import or dead Expand')
  // Shortcuts are a reference of the keys that work, not editable bindings nothing applied.
  assert.ok(!read('settings/pages/Shortcuts.tsx').includes('patchSettings'))
})
