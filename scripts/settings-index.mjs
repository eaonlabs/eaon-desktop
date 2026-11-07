#!/usr/bin/env node
/**
 * Writes src/shared/settingsIndex.ts: every Settings page, and the name and
 * description of each row on it, read from the pages' own source. Settings
 * search and the command palette use it to find a single setting, not only a
 * page, without drawing every page first.
 *
 *   node scripts/settings-index.mjs          rewrite the file
 *   node scripts/settings-index.mjs --check  exit 1 if the file is out of date
 *
 * test/settingsIndex.test.ts runs the same check, so adding a setting without
 * regenerating shows up there. A row is found by its <Row title="…"
 * description="…"> in the page's file, or in a file it imports from
 * components/settings; a title or description built at run time (a template
 * with a value in it, a variable) is left out rather than guessed.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Where the pages are; set from the repo root each time the index is built, so a test bundled elsewhere can pass its own. */
let settings = join(here, 'src/renderer/src/components/settings')
const OUT = join(here, 'src/shared/settingsIndex.ts')

const parse = (file) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

/** Resolves './pages/General' from `from` to a file on disk. */
function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) if (existsSync(candidate)) return candidate
  return null
}

/** name → file, for the named imports of a source file. */
function importsOf(sf) {
  const map = new Map()
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const file = resolveImport(sf.fileName, statement.moduleSpecifier.text)
    const named = statement.importClause?.namedBindings
    if (file && named && ts.isNamedImports(named)) for (const element of named.elements) map.set(element.name.text, file)
  }
  return map
}

/** The static text of a title or description: string pieces only, or null when there is none. */
function staticText(node, { whole }) {
  if (!node) return null
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isJsxExpression(node)) return node.expression ? staticText(node.expression, { whole }) : null
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression, { whole })
  if (ts.isTemplateExpression(node)) {
    // A value in the text: fine for a description's words, but a title is matched on screen by its exact text.
    if (whole) return null
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')
  }
  if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node)) {
    if (whole) return null
    const parts = ts.isConditionalExpression(node) ? [node.whenTrue, node.whenFalse] : [node.left, node.right]
    return parts.map((part) => staticText(part, { whole })).filter(Boolean).join(' ') || null
  }
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
    if (whole) return null
    const out = []
    for (const child of node.children) {
      if (ts.isJsxText(child)) out.push(child.text)
      else if (ts.isJsxExpression(child) || ts.isJsxElement(child) || ts.isJsxFragment(child)) out.push(staticText(child, { whole }) ?? '')
      else if (ts.isJsxSelfClosingElement(child)) out.push('')
    }
    return out.join(' ')
  }
  return null
}

const clean = (text) => text.replace(/\s+/g, ' ').trim()

const attr = (element, name) => {
  const prop = element.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.text === name)
  return prop && ts.isJsxAttribute(prop) ? prop.initializer : undefined
}

/** The rows in one file, with the Section label each sits under. */
function rowsIn(file) {
  const rows = []
  const sections = []
  const visit = (node) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null
    const tag = opening?.tagName.getText()
    if (opening && tag === 'Section') {
      const label = clean(staticText(attr(opening, 'label'), { whole: true }) ?? '')
      sections.push(label)
      ts.forEachChild(node, visit)
      sections.pop()
      return
    }
    if (opening && tag === 'Row') {
      const title = clean(staticText(attr(opening, 'title'), { whole: true }) ?? '')
      if (title) {
        const description = clean(staticText(attr(opening, 'description'), { whole: false }) ?? '')
        const section = [...sections].reverse().find(Boolean) ?? ''
        rows.push({ title, description, section })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(file))
  return rows
}

/** The files a page draws its rows from: its own, and the ones it imports from components/settings (not other pages' roots). */
function filesFor(rootFile, otherRoots) {
  const seen = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const next of importsOf(parse(file)).values()) {
      if (!next.startsWith(settings) || (otherRoots.has(next) && next !== rootFile)) continue
      walk(next)
    }
  }
  walk(rootFile)
  return [...seen]
}

/** The NAV list of SettingsShell.tsx and the tabs of Workers.tsx: id, label, group, and the page a tab belongs to. */
function pagesOf(shell) {
  const pages = []
  const sf = parse(shell)
  let tabs = []
  const workers = join(settings, 'pages/Workers.tsx')
  const wsf = parse(workers)
  const visitTabs = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'WORKER_TABS' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      tabs = node.initializer.elements.filter(ts.isObjectLiteralExpression).map((object) => ({
        id: strProp(object, 'id'),
        label: strProp(object, 'label'),
        component: propText(object, 'page')
      }))
    }
    ts.forEachChild(node, visitTabs)
  }
  visitTabs(wsf)
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'NAV' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if (ts.isObjectLiteralExpression(element)) {
          pages.push({ id: strProp(element, 'id'), label: strProp(element, 'label'), group: strProp(element, 'group') })
        } else if (ts.isSpreadElement(element) && element.expression.getText().startsWith('WORKER_TABS')) {
          for (const tab of tabs) pages.push({ id: tab.id, label: tab.label, group: 'Integrations', parent: 'workers' })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { pages, tabs }
}

function propText(object, name) {
  const prop = object.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === name)
  return prop && ts.isPropertyAssignment(prop) ? prop.initializer.getText() : null
}
const strProp = (object, name) => {
  const prop = object.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === name)
  return prop && ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : ''
}

/** page id → the component drawn for it: PAGES in SettingsShell.tsx, and the Workers tabs. */
function componentsOf(shell, tabs) {
  const map = new Map()
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'PAGES' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const prop of node.initializer.properties) {
        if (ts.isPropertyAssignment(prop)) map.set(prop.name.getText().replace(/['"]/g, ''), prop.initializer.getText())
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(shell))
  for (const tab of tabs) map.set(tab.id, tab.component)
  return map
}

export function buildSettingsIndex(root = here) {
  settings = join(root, 'src/renderer/src/components/settings')
  const shell = join(settings, 'SettingsShell.tsx')
  const { pages, tabs } = pagesOf(shell)
  const components = componentsOf(shell, tabs)
  // Component name → file: the shell's imports, then Workers.tsx's for the tabs.
  const files = new Map([...importsOf(parse(shell)), ...importsOf(parse(join(settings, 'pages/Workers.tsx')))])
  const rootFiles = new Map()
  for (const page of pages) {
    const file = files.get(components.get(page.id) ?? '')
    if (file) rootFiles.set(page.id, file)
  }
  // The Workers page's own file is only the tab strip; its rows are its tabs'.
  const otherRoots = new Set(rootFiles.values())
  const rows = []
  for (const page of pages) {
    const rootFile = rootFiles.get(page.id)
    if (!rootFile) continue
    const seen = new Set()
    for (const file of filesFor(rootFile, otherRoots)) {
      for (const row of rowsIn(file)) {
        const key = `${row.title}\n${row.description}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({ page: page.id, ...row })
      }
    }
  }
  return { pages, rows }
}

export function renderSettingsIndex({ pages, rows }) {
  const q = (s) => JSON.stringify(s)
  return `/**
 * Every Settings page and the name and description of each row on it.
 * Generated by scripts/settings-index.mjs from the pages' source; do not edit
 * by hand. Run \`node scripts/settings-index.mjs\` after adding or renaming a
 * setting (test/settingsIndex.test.ts fails while it is out of date).
 */

export interface SettingsPageEntry {
  id: string
  label: string
  group: string
  /** A tab of another page. */
  parent?: string
}

export interface SettingsRowEntry {
  page: string
  title: string
  description: string
  /** The heading it sits under on the page. */
  section: string
}

export const SETTINGS_PAGES: SettingsPageEntry[] = [
${pages.map((p) => `  { id: ${q(p.id)}, label: ${q(p.label)}, group: ${q(p.group)}${p.parent ? `, parent: ${q(p.parent)}` : ''} }`).join(',\n')}
]

export const SETTINGS_ROWS: SettingsRowEntry[] = [
${rows.map((r) => `  { page: ${q(r.page)}, title: ${q(r.title)}, description: ${q(r.description)}, section: ${q(r.section)} }`).join(',\n')}
]
`
}

// Only when run as a script, not when a test imports it.
if (process.argv[1]?.endsWith('settings-index.mjs')) {
  const next = renderSettingsIndex(buildSettingsIndex())
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
    if (current !== next) {
      console.error('src/shared/settingsIndex.ts is out of date. Run: node scripts/settings-index.mjs')
      process.exit(1)
    }
  } else {
    writeFileSync(OUT, next)
    console.log(`Wrote ${OUT}`)
  }
}
