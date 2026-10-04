import { createInterface } from 'node:readline/promises'
import type { Provider } from '@shared/types'
import { addCustomProvider, checkProviderKey, findKeyRow, GROUPS, keyRows, removeProviderKey, saveProviderKey, templateValues, type KeyRow } from '../core/providerDirectory'
import { boot, shutdown } from '../runtime/boot'

/**
 * `eaon keys`: API keys from a shell, the same providers and checks as the
 * app's /keys screen. A key is read from stdin when one is piped in, or
 * typed at a hidden prompt — never taken as an argument, where it would
 * land in the shell's history.
 */

const USAGE = `eaon keys                       the providers with a key or sign-in
eaon keys list --all            every provider, grouped
eaon keys add <provider>        add or replace a key (hidden prompt, or piped in:
                                pbpaste | eaon keys add groq)
           --base-url <url>     for providers on your own endpoint (Azure)
           --<field> <value>    for templated endpoints (--account-id for Cloudflare)
eaon keys add --custom <name> --base-url <url> [--format openai|anthropic|responses]
                                an endpoint of your own (LiteLLM, a company proxy)
eaon keys check <provider>      check a saved key by listing the models
eaon keys remove <provider>     forget a key`

function flag(args: string[], name: string): string | undefined {
  const at = args.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (at === -1) return undefined
  return args[at].includes('=') ? args[at].slice(args[at].indexOf('=') + 1) : args[at + 1]
}

/** The words that aren't flags or flag values. */
function positional(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (!args[i].includes('=') && args[i + 1] && !args[i + 1].startsWith('--') && args[i] !== '--all') i++
      continue
    }
    out.push(args[i])
  }
  return out
}

const tty = process.stdout.isTTY
const paint = (code: string, text: string): string => (tty ? `\x1b[${code}m${text}\x1b[0m` : text)
const green = (t: string): string => paint('32', t)
const dim = (t: string): string => paint('2', t)
const red = (t: string): string => paint('31', t)
const bold = (t: string): string => paint('1', t)

function status(row: KeyRow): string {
  if (row.auth === 'oauth') return row.ready ? green(`signed in · ${row.models} models`) : dim('sign in from the app: /login')
  return row.ready ? green(row.models ? `key · ${row.models} models` : 'key ✓') : ''
}

function list(all: boolean): number {
  const rows = keyRows()
  const ready = rows.filter((r) => r.ready)
  console.log(`${bold('API keys')} — ${ready.length} set up of ${rows.length} providers${all ? '' : dim('   (eaon keys list --all shows every one)')}`)
  const shown = all ? rows : ready
  if (!shown.length) {
    console.log(`\nNone yet. Add one with ${bold('eaon keys add <provider>')} — e.g. anthropic, openai, openrouter, groq — or ${bold('/keys')} in the app.`)
    return 0
  }
  const width = Math.max(...shown.map((r) => r.name.length)) + 2
  for (const group of GROUPS) {
    const inGroup = shown.filter((r) => r.group === group.id)
    if (!inGroup.length) continue
    console.log(`\n${paint('33;1', group.label.toUpperCase())}`)
    for (const row of inGroup) console.log(`  ${row.ready ? green('●') : dim('○')} ${row.name.padEnd(width)}${dim(row.id.padEnd(22))} ${status(row)}`)
  }
  return 0
}

/** A line typed at a prompt without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  process.stderr.write(prompt)
  stdin.setRawMode?.(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error?: Error): void => {
      stdin.off('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
      process.stderr.write(error ? '\n' : `${dim(` (${value.length} characters)`)}\n`)
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string): void => {
      // A paste arrives wrapped in bracketed-paste markers on some terminals.
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\u0003' || ch === '\u0004') return finish(new Error('Cancelled.'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function readPiped(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text.trim()
}

async function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(`${question}${fallback ? dim(` [${fallback}]`) : ''}: `)).trim() || fallback
  } finally {
    rl.close()
  }
}

async function readKey(name: string, optional: boolean): Promise<string> {
  if (!process.stdin.isTTY) return readPiped()
  return readHidden(`${name} API key${optional ? dim(' (Enter to keep or skip)') : ''}: `)
}

function report(name: string, result: { ok: boolean; message: string; models: number }): number {
  if (result.ok) {
    console.log(`${green('✓')} ${name}: ${result.message}`)
    return 0
  }
  console.log(`${red('✗')} ${name}: the key is saved, but the check failed — ${result.message}`)
  return 1
}

async function add(args: string[]): Promise<number> {
  const custom = flag(args, '--custom')
  if (custom !== undefined) {
    const baseUrl = flag(args, '--base-url') ?? ''
    const format = (flag(args, '--format') ?? 'openai').toLowerCase()
    const kind: Provider['kind'] = format.startsWith('anthropic') ? 'anthropic' : format.startsWith('resp') ? 'openai-responses' : 'openai-compatible'
    const key = await readKey(custom, true)
    const result = await addCustomProvider({ name: custom, baseUrl, kind, key })
    console.log(dim(`Added as “${result.id}”.`))
    return report(custom, result)
  }
  const [query] = positional(args)
  if (!query) {
    console.error(`Which provider? e.g. eaon keys add groq. eaon keys list --all lists them.`)
    return 2
  }
  const row = findKeyRow(query)
  if (!row) {
    console.error(`No provider called “${query}”. eaon keys list --all lists them.`)
    return 2
  }
  if (row.auth === 'oauth') {
    console.error(`${row.name} signs in with your account rather than a key: open eaon and run /login ${row.id}.`)
    return 2
  }
  const values: Record<string, string> = templateValues(row)
  for (const field of row.fields) {
    const given = flag(args, `--${field.key.replace(/_/g, '-')}`)
    if (given) values[field.key] = given
    else if (!values[field.key] || !row.ready) {
      if (!process.stdin.isTTY) {
        console.error(`${row.name} needs --${field.key.replace(/_/g, '-')} (${field.label}).`)
        return 2
      }
      values[field.key] = await ask(field.label, values[field.key])
    }
  }
  if (row.baseUrlLabel || row.group === 'custom') {
    const given = flag(args, '--base-url')
    if (given) values.baseUrl = given
    else if (!row.baseUrl || /\{[a-z_]+\}/.test(row.baseUrl)) {
      if (!process.stdin.isTTY) {
        console.error(`${row.name} needs --base-url (${row.baseUrlLabel ?? 'base URL'}).`)
        return 2
      }
      values.baseUrl = await ask(row.baseUrlLabel ?? 'Base URL')
    }
  }
  if (row.keyUrl && !row.ready && process.stdin.isTTY) console.error(dim(`Get a key at ${row.keyUrl}`))
  const key = await readKey(row.name, row.ready)
  if (!key && !row.ready) {
    console.error('No key given.')
    return 2
  }
  return report(row.name, await saveProviderKey(row, key, values))
}

async function remove(args: string[]): Promise<number> {
  const [query] = positional(args)
  const row = query ? findKeyRow(query) : undefined
  if (!row) {
    console.error(query ? `No provider called “${query}”.` : 'Which provider? e.g. eaon keys remove groq.')
    return 2
  }
  if (!row.ready && row.group !== 'custom') {
    console.log(`${row.name} has no key saved.`)
    return 0
  }
  removeProviderKey(row)
  console.log(`${row.name}: removed.`)
  return 0
}

async function check(args: string[]): Promise<number> {
  const [query] = positional(args)
  const row = query ? findKeyRow(query) : undefined
  if (!row) {
    console.error(query ? `No provider called “${query}”.` : 'Which provider? e.g. eaon keys check groq.')
    return 2
  }
  if (!row.ready) {
    console.error(`${row.name} has no key saved. Add one with eaon keys add ${row.id}.`)
    return 1
  }
  const result = await checkProviderKey(row.id)
  if (result.ok) {
    console.log(`${green('✓')} ${row.name}: ${result.message}`)
    return 0
  }
  console.log(`${red('✗')} ${row.name}: ${result.message}`)
  return 1
}

export async function runKeysCommand(args: string[]): Promise<number> {
  const [sub = 'list', ...rest] = args
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE)
    return 0
  }
  await boot({ engines: false, mcp: false })
  try {
    switch (sub) {
      case 'list':
      case 'ls':
        return list(rest.includes('--all'))
      case '--all':
      case 'providers':
        return list(true)
      case 'add':
      case 'set':
        return await add(rest)
      case 'remove':
      case 'rm':
      case 'delete':
        return await remove(rest)
      case 'check':
      case 'test':
        return await check(rest)
      default:
        console.error(`Unknown: eaon keys ${sub}\n\n${USAGE}`)
        return 2
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    await shutdown()
  }
}
