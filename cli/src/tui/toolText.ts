import { homedir } from 'node:os'
import { describeOrder } from '@main/features/trading/engine'

/**
 * One line for a tool call in the transcript — "Read src/main/store.ts",
 * "$ npm test", "Buy 5 AAPL" — the terminal version of the desktop's
 * activity lines. Unknown tools (plugins) show their name and the first
 * argument.
 */

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value))

export function shortPath(path: string, cwd?: string): string {
  if (!path) return ''
  if (cwd && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

export interface ToolLine {
  verb: string
  target: string
}

export function describeToolCall(name: string, input: Record<string, unknown>, cwd?: string): ToolLine {
  const path = shortPath(str(input.path ?? input.file ?? input.file_path), cwd)
  switch (name) {
    case 'read_file':
      return { verb: 'Read', target: path }
    case 'write_file':
      return { verb: 'Write', target: path }
    case 'edit_file':
      return { verb: 'Edit', target: path }
    case 'delete_file':
      return { verb: 'Delete', target: path }
    case 'move_file':
      return { verb: 'Move', target: `${shortPath(str(input.from ?? input.source), cwd)} → ${shortPath(str(input.to ?? input.destination), cwd)}` }
    case 'list_dir':
      return { verb: 'List', target: path || '.' }
    case 'grep':
      return { verb: 'Search', target: `“${str(input.pattern ?? input.query)}”${path ? ` in ${path}` : ''}` }
    case 'find_file':
      return { verb: 'Find', target: str(input.pattern ?? input.query ?? input.name) }
    case 'run_command':
      return { verb: '$', target: str(input.command) }
    case 'web_search':
      return { verb: 'Search web', target: `“${str(input.query)}”` }
    case 'web_fetch':
      return { verb: 'Fetch', target: str(input.url) }
    case 'update_plan':
      return { verb: 'Update plan', target: '' }
    case 'present_plan':
      return { verb: 'Plan', target: str(input.title) }
    case 'goal_complete':
      return { verb: 'Goal done', target: '' }
    case 'goal_blocked':
      return { verb: 'Goal blocked', target: '' }
    case 'spawn_agents':
      return { verb: 'Swarm', target: `${Array.isArray(input.agents) ? input.agents.length : ''} agents` }
    case 'load_skill':
      return { verb: 'Skill', target: str(input.name ?? input.id) }
    case 'generate_image':
      return { verb: 'Image', target: str(input.prompt).slice(0, 80) }
    case 'trading_order':
      return {
        verb: 'Order',
        target: describeOrder({ side: input.side, symbol: input.symbol, qty: input.qty, notional: input.notional, type: input.type ?? (input.limit_price !== undefined ? 'limit' : 'market'), limitPrice: input.limit_price })
      }
    case 'trading_quote':
      return { verb: 'Quote', target: Array.isArray(input.symbols) ? input.symbols.join(', ') : str(input.symbol) }
    case 'trading_history':
      return { verb: 'History', target: `${Array.isArray(input.symbols) ? input.symbols.join(', ') : str(input.symbol)}${input.range ? ` ${str(input.range)}` : ''}` }
    case 'trading_account':
      return { verb: 'Account', target: '' }
    case 'trading_scan':
      return { verb: 'Scan', target: str(input.kind ?? input.list) }
    case 'trading_news':
      return { verb: 'News', target: Array.isArray(input.symbols) ? input.symbols.join(', ') : str(input.symbol) }
    case 'trading_exits':
      return { verb: 'Exits', target: str(input.symbol) }
    case 'trading_cancel':
      return { verb: 'Cancel order', target: str(input.id ?? input.order_id) }
    case 'trading_session':
      return { verb: 'Session', target: `${str(input.action)}${input.strategy ? ` · ${str(input.strategy).slice(0, 60)}` : ''}` }
    case 'sessions_list':
      return { verb: 'Sessions', target: '' }
    case 'session_send':
      return { verb: 'Message', target: `${str(input.to)}: ${str(input.text).slice(0, 80)}` }
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined
      const label = name.includes('__') ? name.split('__').slice(1).join('__') : name
      return { verb: label.replace(/_/g, ' '), target: first ? first.slice(0, 80) : '' }
    }
  }
}

/** A short summary of a tool's output for the line under it. */
export function outputSummary(name: string, output: string): string {
  const lines = output.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return '(no output)'
  if (name === 'read_file') return `${lines.length} lines`
  if (name === 'list_dir' || name === 'find_file' || name === 'grep') return lines.length === 1 ? lines[0] : `${lines.length} results`
  if (name === 'run_command') return lines[lines.length - 1]
  return lines[0]
}
