import { findCommand } from './commands'
import { failure } from './protocol'

/**
 * `eaon-apps` arguments, parsed here in the app rather than in the launcher
 * so the launcher stays a few lines that only pass them on. The grammar is
 * the usual one: `<command> [positionals…] [--name value | --name=value |
 * --flag]`, with `-i` for --interactive and `-c` for --compact. Dashes in
 * names become underscores, and numbers become numbers.
 */

const SHORT: Record<string, string> = { i: 'interactive', c: 'compact', a: 'app', f: 'force' }

/** Flags any command takes, besides its own. */
const COMMON_FLAGS = new Set(['interactive', 'compact', 'skeleton', 'exact', 'gone', 'force', 'activate', 'all', 'menubar', 'keep-going', 'no-wait', 'wait-gone'])

const NUMERIC = new Set(['depth', 'limit', 'max_nodes', 'timeout', 'units', 'x', 'y', 'w', 'h', 'repeat', 'ms', 'wait_timeout'])

const key = (name: string): string => name.replace(/-/g, '_')

/** Slots that take the rest of the words when they come last: text with spaces, a menu path, an app's name. */
const REST = new Set(['text', 'path', 'option', 'value', 'app'])

export function parseArgv(argv: readonly string[]): { command: string; args: Record<string, unknown> } {
  const [first, ...rest] = argv
  if (!first || first === '--help' || first === '-h' || first === 'help') return { command: 'guide', args: {} }
  const def = findCommand(first)
  if (!def) return { command: first, args: {} }
  const flags = new Set([...COMMON_FLAGS, ...(def.flags ?? [])])
  const args: Record<string, unknown> = {}
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token === '--') {
      positionals.push(...rest.slice(i + 1))
      break
    }
    let name: string | null = null
    let inline: string | undefined
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=')
      name = eq === -1 ? token.slice(2) : token.slice(2, eq)
      inline = eq === -1 ? undefined : token.slice(eq + 1)
    } else if (/^-[a-z]$/i.test(token)) {
      name = SHORT[token.slice(1)] ?? null
      if (!name) throw failure('INVALID_ARGS', `Unknown option ${token}.`)
    }
    if (name === null) {
      positionals.push(token)
      continue
    }
    if (name.startsWith('no-') && flags.has(name.slice(3))) {
      args[key(name.slice(3))] = false
      continue
    }
    if (flags.has(name) && inline === undefined) {
      args[key(name)] = true
      continue
    }
    let value = inline
    if (value === undefined) {
      if (i + 1 >= rest.length) throw failure('INVALID_ARGS', `--${name} needs a value.`)
      value = rest[++i]
    }
    // --element is what other tools call a ref.
    const k = name === 'element' ? 'ref' : key(name)
    args[k] = NUMERIC.has(k) && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value
  }
  const slots = def.positional ?? []
  // A first positional that isn't a ref goes to the next slot (`type --app Notes hello`).
  let slot = 0
  for (let p = 0; p < positionals.length; p++) {
    while (slot < slots.length && args[slots[slot]] !== undefined) slot++
    if (slot >= slots.length) throw failure('INVALID_ARGS', `Unexpected "${positionals[p]}". Usage: ${def.usage}`)
    const name = slots[slot]
    if (name === 'ref' && !positionals[p].startsWith('@') && !/^s[a-z0-9]+:e\d+$/.test(positionals[p]) && slots.length > 1) {
      slot++
      p--
      continue
    }
    // The last slot takes what's left when it's words (text with spaces, a menu path).
    if (slot === slots.length - 1 && REST.has(name)) {
      args[name] = positionals.slice(p).join(' ')
      break
    }
    args[name] = positionals[p]
    slot++
  }
  return { command: def.name, args }
}
