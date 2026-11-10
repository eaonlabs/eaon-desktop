#!/usr/bin/env node
/**
 * App control's Windows engine on a real Windows desktop (CI: the
 * "App control engine" job in .github/workflows/windows.yml). Starts the
 * engine the way the app does, opens Notepad through it, finds the editor in
 * Notepad's UI Automation tree, writes into it and reads it back, then
 * closes Notepad. Only Node is needed; the engine compiles itself with
 * Windows PowerShell's Add-Type.
 *
 *   node scripts/test-app-control-windows.mjs
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log('app-control (Windows): skipped, not on Windows.')
  process.exit(0)
}

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const script = join(root, 'resources', 'app-control', 'win32', 'eaon-app-control.ps1')
const engine = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'inherit'] })
engine.stdout.setEncoding('utf8')

let buffer = ''
const waiting = new Map()
engine.stdout.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line)
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  }
})

let nextId = 1
function call(op, params = {}, timeout = 60_000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${op} timed out`)), timeout)
    waiting.set(id, (message) => {
      clearTimeout(timer)
      if (message.ok) resolve(message.result)
      else reject(new Error(`${op}: ${message.code}: ${message.message}`))
    })
    engine.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`)
  })
}

function nodes(tree, out = []) {
  out.push(tree)
  for (const child of tree.children ?? []) nodes(child, out)
  return out
}

function check(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`ok  ${message}`)
}

let pid = null
try {
  const status = await call('status', {}, 120_000)
  check(status.version === '1.0.0', `engine compiled and answers (version ${status.version}, ${status.os})`)

  const app = await call('launch', { name: 'notepad.exe', timeout: 30 })
  pid = app.pid
  check(Number.isInteger(pid) && pid > 0, `Notepad started (pid ${pid}, ${app.name})`)

  const windows = await call('windows', { pid })
  check(windows.length > 0 && windows[0].role === 'Window', `its window is listed (“${windows[0]?.title ?? ''}”)`)

  const snap = await call('snapshot', { pid, depth: 12 })
  const all = nodes(snap.tree)
  check(all.length > 3, `snapshot read ${all.length} elements`)
  const typable = (node) => node.valueSettable || (node.actions ?? []).includes('inserttext')
  const editor = all.find((node) => (node.role === 'Edit' || node.role === 'Document') && typable(node))
  if (!editor) {
    for (const node of all) console.log(`    ${node.n ?? '-'} ${node.role} “${node.title ?? ''}” id=${node.identifier ?? ''} settable=${Boolean(node.valueSettable)} actions=${(node.actions ?? []).join(',')}`)
  }
  check(editor, `found the editor (${editor?.role} “${editor?.title ?? ''}”)`)

  // A control with a settable value takes it at once; a classic editor (Notepad's "Text Editor") is typed into.
  const text = 'Hello from Eaon app control'
  if (editor.valueSettable) await call('act', { sid: snap.sid, n: editor.n, action: 'setvalue', value: text })
  else {
    await call('act', { sid: snap.sid, n: editor.n, action: 'inserttext', text })
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const read = await call('read', { sid: snap.sid, n: editor.n })
  check((read.value ?? '').trim() === text, `wrote into it and read it back (“${read.value}”)`)

  const menu = all.find((node) => node.role === 'MenuBar')
  check(menu || true, menu ? 'its menu bar is in the tree' : 'no classic menu bar (newer Notepad)')

  const stale = await call('read', { sid: 'snotreal', n: 1 }).then(() => null, (error) => error.message)
  check(/STALE_REF/.test(stale ?? ''), 'an unknown snapshot is STALE_REF')

  await call('quit', { pid, force: true })
  pid = null
  check(true, 'Notepad closed')
  console.log('app-control (Windows): all checks passed')
} catch (error) {
  console.error(`app-control (Windows): ${error.message}`)
  process.exitCode = 1
} finally {
  if (pid) await call('quit', { pid, force: true }).catch(() => undefined)
  engine.stdin.end()
}
