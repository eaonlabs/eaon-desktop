import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  CalendarClock,
  CandlestickChart,
  CreditCard,
  FilePen,
  FolderInput,
  Globe,
  Mail,
  MousePointerClick,
  Plug,
  ShieldAlert,
  Smartphone,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { isCatastrophicCommand, isRiskyCommand } from '@shared/commandRisk'
import '../../styles/approval.css'

/**
 * Asking before the agent acts: the dialog over Chat and the card above a
 * worker's composer are the same card.
 *
 * It leads with what kind of thing is about to happen and how much it
 * matters (the tile's colour and the line under the title), then shows
 * exactly what will run, then the two answers. Risk is read off the tool:
 * sending and money are the ones that can't be taken back, a command or a
 * click acts on the computer, and an edit to a file is the mildest.
 */

export type ApprovalRisk = 'high' | 'medium' | 'low'

const RISK: Record<string, ApprovalRisk> = {
  email_send: 'high',
  email_reply: 'high',
  trading_order: 'high',
  trading_session: 'high',
  payment_card: 'high',
  write_file: 'low',
  edit_file: 'low'
}

/**
 * A command is as risky as what it does: `rm -rf`, `sudo` or a credential
 * read is red like an email send, not amber like `npm test`.
 */
export function approvalRisk(tool: string, input?: Record<string, unknown>): ApprovalRisk {
  const command = tool === 'run_command' && typeof input?.command === 'string' ? input.command : null
  if (command && (isCatastrophicCommand(command) || isRiskyCommand(command))) return 'high'
  return RISK[tool] ?? 'medium'
}

/** Where a keypress came from, as far as ⏎ approving is concerned. */
export interface KeyTarget {
  /** A button: it answers ⏎ itself. */
  button: boolean
  /** A text box or anything editable: ⏎ there means "send" or "new line". */
  field: boolean
  /** Inside the approval card itself. */
  inCard: boolean
  /** Nothing has focus (the document body). */
  nothingFocused: boolean
}

/**
 * Whether ⏎ should approve. Only from the card itself or with nothing
 * focused — never from a text box (the composer sits right behind the card),
 * never from a button (it answers for itself), and never for a call that
 * could delete or change the system: that one needs a click.
 */
export function enterApproves(target: KeyTarget, risk: ApprovalRisk): boolean {
  if (target.button || target.field) return false
  if (risk === 'high') return false
  return target.inCard || target.nothingFocused
}

/** What the action does, in a few words, under the title. */
const DOES: Record<string, string> = {
  run_command: 'Runs on your computer',
  write_file: 'Changes a file',
  edit_file: 'Changes a file',
  delete_file: 'Moves it to the Trash',
  move_file: 'Moves a file',
  computer: 'Uses your mouse and keyboard',
  browser: 'Acts in your browser',
  web_browser: 'Acts in its browser',
  email_send: 'Sends an email as you',
  email_reply: 'Sends an email as you',
  trading_order: 'Places an order',
  trading_session: 'Trades for you',
  payment_card: 'Spends money on your card',
  ios_simulator: 'Controls the iOS Simulator',
  use_plugin_tool: 'Acts through a plugin',
  schedule: 'Changes your schedules'
}

const ICON: Record<string, typeof ShieldAlert> = {
  run_command: SquareTerminal,
  write_file: FilePen,
  edit_file: FilePen,
  delete_file: Trash2,
  move_file: FolderInput,
  computer: MousePointerClick,
  browser: Globe,
  web_browser: Globe,
  email_send: Mail,
  email_reply: Mail,
  trading_order: CandlestickChart,
  trading_session: CandlestickChart,
  payment_card: CreditCard,
  ios_simulator: Smartphone,
  use_plugin_tool: Plug,
  schedule: CalendarClock
}

export function ApprovalCard({
  tool,
  input,
  title,
  asker = 'Eaon',
  since,
  lead,
  extra,
  waiting = 0,
  approveLabel = 'Approve',
  denyLabel = 'Deny',
  busy = false,
  variant,
  swap = false,
  children,
  onApprove,
  onDeny
}: {
  tool: string
  /** The call's arguments: a command's own risk can raise the card's. */
  input?: Record<string, unknown>
  title: string
  /** Who is waiting on the answer: Eaon, or a worker by name. */
  asker?: string
  /** How long it has been waiting, as "2m ago". */
  since?: string
  /** Above the preview: why it's asking, when it said so (a worker's question). */
  lead?: ReactNode
  /** Under the preview: a note field, say. */
  extra?: ReactNode
  /** More approvals queued behind this one. */
  waiting?: number
  approveLabel?: string
  denyLabel?: string
  busy?: boolean
  /**
   * `dialog` takes ⏎ and esc (it's all that's on screen); `inline` sits next
   * to a composer, where those keys belong to the text box.
   */
  variant: 'dialog' | 'inline'
  /** The next one in a queue, arriving where the last one was. */
  swap?: boolean
  /** Exactly what will happen: the command, the diff, the call. */
  children: ReactNode
  onApprove: () => void
  onDeny: () => void
}): JSX.Element {
  const risk = approvalRisk(tool, input)
  // A command that could delete or change the system says so, not just "runs".
  const does = tool === 'run_command' && risk === 'high' ? 'Could delete files or change your system' : (DOES[tool] ?? 'Needs your OK')
  const Icon = ICON[tool] ?? ShieldAlert
  const titleId = useId()
  const approve = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (variant === 'dialog') approve.current?.focus({ preventScroll: true })
  }, [variant, title, tool])

  return (
    <section
      className="approval"
      data-variant={variant}
      data-risk={risk}
      data-swap={swap || undefined}
      role={variant === 'dialog' ? 'alertdialog' : 'group'}
      aria-modal={variant === 'dialog' || undefined}
      aria-labelledby={titleId}
    >
      <header className="approval__head">
        <span className="approval__tile" aria-hidden="true">
          <Icon size={16} strokeWidth={1.9} />
        </span>
        <span className="approval__titles">
          <span id={titleId} className="approval__title">
            {title}
          </span>
          <span className="approval__meta">
            <span className="approval__does">{does}</span>
            <span className="approval__tool">{tool.replace(/_/g, ' ')}</span>
          </span>
        </span>
        {waiting > 0 && (
          <span className="approval__queue" title={`${waiting} more waiting after this`}>
            +{waiting}
          </span>
        )}
      </header>

      {lead && <div className="approval__lead">{lead}</div>}
      <div className="approval__preview">{children}</div>
      {extra}

      <footer className="approval__foot">
        <span className="approval__waiting">
          <span className="approval__dot" aria-hidden="true" />
          {asker} is waiting for you{since ? ` · ${since}` : ''}
        </span>
        <button type="button" className="btn btn--ghost approval__deny" disabled={busy} onClick={onDeny}>
          {denyLabel}
          {variant === 'dialog' && <kbd className="approval__kbd">esc</kbd>}
        </button>
        <button ref={approve} type="button" className="btn approval__approve" disabled={busy} onClick={onApprove}>
          {approveLabel}
          {variant === 'dialog' && <kbd className="approval__kbd">⏎</kbd>}
        </button>
      </footer>
    </section>
  )
}

/** A command as it will run: a prompt mark, then the line, wrapped, never cut off. */
export function CommandPreview({ command }: { command: string }): JSX.Element {
  return (
    <div className="approval__cmd">
      <span className="approval__prompt" aria-hidden="true">
        $
      </span>
      <code>{command}</code>
    </div>
  )
}

/** One line saying what will happen, with the raw arguments a click away. */
export function CallPreview({ summary, args }: { summary: string; args: unknown }): JSX.Element {
  const [open, setOpen] = useState(false)
  const json = JSON.stringify(args, null, 2) ?? ''
  const hasDetails = json.length > 2
  return (
    <div className="approval__call">
      {summary && <p className="approval__summary">{summary}</p>}
      {hasDetails && (
        <>
          <button type="button" className="approval__details-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide details' : 'Show details'}
          </button>
          {open && <pre className="approval__json">{json.slice(0, 4000)}</pre>}
        </>
      )}
    </div>
  )
}
