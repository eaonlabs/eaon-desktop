import { createInterface } from 'node:readline/promises'
import { boot, shutdown } from '../runtime/boot'
import { desktopHome } from '../runtime/paths'
import {
  desktopChats,
  desktopTradingSnapshot,
  desktopWorkers,
  findDesktop,
  importFromDesktop,
  isDesktopRunning,
  planImport,
  type ImportChoices,
  type ImportPlan,
  type ImportReport
} from '../core/desktop'

/**
 * `eaon import` and `eaon desktop`: plain-text commands over
 * core/desktop.ts. Import asks part by part (or takes flags), then prints
 * counts — never a key.
 */

const tty = process.stdout.isTTY === true
const bold = (text: string): string => (tty ? `\x1b[1m${text}\x1b[22m` : text)
const dim = (text: string): string => (tty ? `\x1b[2m${text}\x1b[22m` : text)

const PARTS: { id: keyof ImportChoices; label: string; describe: (plan: ImportPlan) => string; available: (plan: ImportPlan) => boolean }[] = [
  {
    id: 'keys',
    label: 'API keys and sign-ins',
    describe: (plan) => (plan.keys === null ? 'encrypted; macOS asks once to unlock them' : `${plan.keys} saved`),
    available: (plan) => plan.keys !== 0
  },
  { id: 'providers', label: 'Model providers', describe: (plan) => `${plan.providers} configured`, available: (plan) => plan.providers > 0 },
  { id: 'settings', label: 'Model, effort and agent settings', describe: () => 'your current choices', available: (plan) => plan.settings },
  { id: 'mcp', label: 'MCP servers', describe: (plan) => `${plan.mcpServers} added by you`, available: (plan) => plan.mcpServers > 0 },
  {
    id: 'trading',
    label: 'Trading setup',
    describe: (plan) =>
      [plan.trading.config ? 'broker and limits' : null, plan.trading.schedules ? `${plan.trading.schedules} schedule${plan.trading.schedules === 1 ? '' : 's'} (imported switched off)` : null]
        .filter(Boolean)
        .join(', '),
    available: (plan) => plan.trading.config || plan.trading.schedules > 0
  }
]

function printPlan(plan: ImportPlan): void {
  console.log(bold('From Eaon Desktop:'))
  for (const part of PARTS) {
    if (!part.available(plan)) console.log(`  ${dim(`${part.label} — nothing to bring`)}`)
    else console.log(`  ${part.label} ${dim(`— ${part.describe(plan)}`)}`)
  }
}

function printReport(report: ImportReport): void {
  const lines: string[] = []
  if (report.keys && !report.keys.error) lines.push(`Keys: ${report.keys.added} added, ${report.keys.updated} updated`)
  if (report.providers !== undefined) lines.push(`Providers: ${report.providers}`)
  if (report.settings !== undefined) lines.push(`Settings: ${report.settings ? 'copied' : 'nothing to copy'}`)
  if (report.mcpServers !== undefined) lines.push(`MCP servers: ${report.mcpServers}`)
  if (report.trading) {
    const t = report.trading
    lines.push(`Trading: ${t.config ? 'broker and limits copied' : 'no setup'}, ${t.schedules} schedule${t.schedules === 1 ? '' : 's'}${t.disabled ? ` (${t.disabled} switched off — turn them on in the CLI once the desktop no longer runs them)` : ''}`)
    if (t.config) lines.push(dim('Real-money trading, if you had it on, has to be confirmed again in the CLI.'))
  }
  for (const line of lines) console.log(`  ${line}`)
  for (const error of report.errors) console.log(`  ${bold('Not imported')} ${error}`)
}

/** Parses `--only=keys,providers` into choices; unknown names are reported. */
function onlyChoices(value: string): ImportChoices {
  const wanted = new Set(value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  const known = new Set(PARTS.map((p) => p.id))
  for (const name of wanted) if (!known.has(name as keyof ImportChoices)) throw new Error(`Unknown part "${name}". Use: ${[...known].join(', ')}.`)
  return { keys: wanted.has('keys'), providers: wanted.has('providers'), settings: wanted.has('settings'), mcp: wanted.has('mcp'), trading: wanted.has('trading') }
}

async function askChoices(plan: ImportPlan, skipKeys: boolean): Promise<ImportChoices> {
  const choices: ImportChoices = { keys: false, providers: false, settings: false, mcp: false, trading: false }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (const part of PARTS) {
      if (!part.available(plan) || (part.id === 'keys' && skipKeys)) continue
      const answer = (await rl.question(`Import ${part.label.toLowerCase()}? ${dim('[Y/n]')} `)).trim().toLowerCase()
      choices[part.id] = answer === '' || answer === 'y' || answer === 'yes'
    }
  } finally {
    rl.close()
  }
  return choices
}

export async function runImportCommand(args: string[]): Promise<number> {
  await boot({ engines: false, mcp: false })
  try {
    const desktop = findDesktop()
    if (!desktop) {
      console.log(`Eaon Desktop wasn't found. Looked in ${desktopHome()}.`)
      console.log(dim('Set EAON_DESKTOP_DATA if it keeps its data somewhere else.'))
      return 1
    }
    const plan = planImport()
    printPlan(plan)
    if (args.includes('--dry-run')) return 0

    const skipKeys = args.includes('--no-keys')
    const only = args.find((a) => a.startsWith('--only='))
    let choices: ImportChoices
    if (only) choices = onlyChoices(only.slice('--only='.length))
    else if (args.includes('--all') || args.includes('-y') || args.includes('--yes')) {
      choices = { keys: true, providers: true, settings: true, mcp: true, trading: true }
    } else if (process.stdin.isTTY) {
      console.log()
      choices = await askChoices(plan, skipKeys)
    } else {
      console.log('Nothing imported: pass --all, or --only=keys,providers,settings,mcp,trading, when not running in a terminal.')
      return 1
    }
    if (skipKeys) choices.keys = false
    // Parts with nothing in them are left out rather than reported as empty.
    for (const part of PARTS) if (!part.available(plan)) choices[part.id] = false
    if (!Object.values(choices).some(Boolean)) {
      console.log('Nothing to import.')
      return 0
    }

    console.log()
    const report = await importFromDesktop(choices, { onStatus: (line) => console.log(dim(line)) })
    console.log(bold('Imported:'))
    printReport(report)
    return report.errors.length > 0 ? 1 : 0
  } finally {
    await shutdown()
  }
}

/** `eaon desktop`: where the desktop app is, whether it runs, and what it holds — read only. */
export async function runDesktopCommand(_args: string[]): Promise<number> {
  await boot({ engines: false, mcp: false })
  try {
    const desktop = findDesktop()
    if (!desktop) {
      console.log(`Eaon Desktop wasn't found. Looked in ${desktopHome()}.`)
      return 1
    }
    const running = await isDesktopRunning()
    console.log(`${bold('Eaon Desktop')} ${dim(desktop.home)}`)
    console.log(`  ${running ? 'Running now' : 'Not running'}${desktop.hasKeys ? ', keys saved' : ''}`)
    console.log(`  Store: ${desktop.files.length} file${desktop.files.length === 1 ? '' : 's'} ${dim(desktop.files.join(', '))}`)

    const chats = desktopChats()
    console.log(`  Chats: ${chats.length}${chats[0] ? dim(` — latest “${chats[0].title}”`) : ''}`)
    const workers = desktopWorkers()
    console.log(`  Workers: ${workers.length}${workers.length ? dim(` — ${workers.map((w) => w.name).join(', ')}`) : ''}`)

    const desk = desktopTradingSnapshot()
    if (desk) {
      const last = desk.equity[desk.equity.length - 1]
      const equity = last ? ` — equity ${last.equity.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} on ${new Date(last.at).toLocaleDateString()}` : ''
      console.log(`  Trading: ${desk.config.broker}, ${desk.orders.length} order${desk.orders.length === 1 ? '' : 's'}, ${desk.sessions.length} session${desk.sessions.length === 1 ? '' : 's'}${dim(equity)}`)
    } else {
      console.log(`  Trading: ${dim('not set up')}`)
    }
    return 0
  } finally {
    await shutdown()
  }
}
