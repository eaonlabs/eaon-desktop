import { vmPhaseLabel, type VmDevice, type VmExecResult, type VmInput, type VmScreenshot, type VmStatus } from '@shared/vms'
import type { AgentTool, ToolResult, ToolSource } from '../agent/tools'

/**
 * The `vm` tool: agents working in the user's VMs, Devin-style — running
 * commands, and seeing and using the screen — on a whole computer that
 * isn't the user's own. Only VMs the user marked "Agents can use this" are
 * offered, wherever they run (this computer or the worker computer).
 */

/** The VMs an agent can reach and the calls it makes on them; the desktop's covers both devices. */
export interface VmDirectory {
  /** The VMs as last seen, without waiting (tool lists are built synchronously). */
  cached: () => VmStatus[]
  start: (device: VmDevice, id: string) => Promise<VmStatus>
  stop: (device: VmDevice, id: string) => Promise<VmStatus>
  exec: (device: VmDevice, id: string, command: string, timeoutMs: number) => Promise<VmExecResult>
  screenshot: (device: VmDevice, id: string) => Promise<VmScreenshot>
  input: (device: VmDevice, id: string, actions: VmInput[]) => Promise<void>
  setActive: (device: VmDevice, id: string, active: boolean) => void
}

const ACTIONS = ['list', 'start', 'stop', 'run', 'screenshot', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key'] as const
type Action = (typeof ACTIONS)[number]
const READS = new Set<Action>(['list', 'screenshot'])
const SCREEN = new Set<Action>(['click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key'])

const num = (value: unknown, name: string): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`\`${name}\` must be a number (pixels on the VM's screen).`)
  return n
}

function pick(directory: VmDirectory, name: unknown): VmStatus {
  const usable = directory.cached().filter((vm) => vm.agents)
  if (usable.length === 0) throw new Error('No VM is open to agents. The user turns that on per VM, on the Computers page.')
  const wanted = typeof name === 'string' ? name.trim().toLowerCase() : ''
  if (!wanted) {
    if (usable.length === 1) return usable[0]
    throw new Error(`Say which VM: ${usable.map((vm) => vm.name).join(', ')}.`)
  }
  const found = usable.find((vm) => vm.name.toLowerCase() === wanted || vm.id === wanted) ?? usable.find((vm) => vm.name.toLowerCase().includes(wanted))
  if (!found) throw new Error(`No VM open to agents is called “${name}”. There’s ${usable.map((vm) => vm.name).join(', ')}.`)
  return found
}

const describeVm = (vm: VmStatus): string =>
  `${vm.name} — ${vm.version}${vm.os === 'linux' ? (vm.desktop ? ', desktop' : ', terminal only') : ''}, ${vm.cpus} CPU, ${Math.round(vm.memoryMB / 1024)} GB, ${vm.device === 'host' ? 'on the worker computer' : 'on this computer'}: ${vmPhaseLabel(vm)}${vm.ready ? ' (commands work)' : ''}${vm.screen ? ' (screen available)' : ''}`

function formatExec(result: VmExecResult): string {
  const parts: string[] = []
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd())
  if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`)
  parts.push(result.timedOut ? '[stopped: it ran past the time limit]' : `[exit code ${result.exitCode}]`)
  return parts.join('\n')
}

export function vmTool(directory: VmDirectory): AgentTool {
  return {
    name: 'vm',
    description:
      'Work in one of the user’s virtual machines: whole Linux or macOS computers set aside for agents, separate from the user’s own. ' +
      'Run shell commands (`run`, Linux only, as a user with passwordless sudo), and see and use the screen (`screenshot`, then `click`, `type`, `key`, `scroll`, `drag`; coordinates are pixels on the last screenshot). ' +
      'Screen actions return a new screenshot. `list` shows which VMs you may use and whether they are on.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        vm: { type: 'string', description: 'Which VM, by name. Can be left out when only one is open to agents.' },
        command: { type: 'string', description: 'For run: a shell command, run with bash as a login shell in the home folder.' },
        timeout_seconds: { type: 'number', description: 'For run: how long it may take (default 120, at most 1800).' },
        x: { type: 'number' },
        y: { type: 'number' },
        to_x: { type: 'number', description: 'For drag: where to let go.' },
        to_y: { type: 'number' },
        text: { type: 'string', description: 'For type: the text to type.' },
        keys: { type: 'string', description: 'For key: a key or combination, e.g. "enter", "ctrl+c", "ctrl+alt+t", "cmd+space".' },
        scroll_y: { type: 'number', description: 'For scroll: notches; positive scrolls down, negative up.' },
        scroll_x: { type: 'number', description: 'For scroll: notches; positive scrolls right.' }
      },
      required: ['action']
    },
    mutating: (input) => !READS.has(String(input.action) as Action),
    describe: (input) => {
      const action = String(input.action)
      const where = input.vm ? ` in ${String(input.vm)}` : ''
      if (action === 'run') return `Run in the VM${where}: ${String(input.command ?? '').slice(0, 120)}`
      if (action === 'type') return `Type in the VM${where}: ${String(input.text ?? '').slice(0, 60)}`
      if (action === 'key') return `Press ${String(input.keys ?? '')} in the VM${where}`
      return `${action.replace('_', ' ')} in the VM${where}`
    },
    run: async (input): Promise<ToolResult | string> => {
      const action = String(input.action ?? '') as Action
      if (!ACTIONS.includes(action)) return { text: `Unknown action “${action}”. Use one of: ${ACTIONS.join(', ')}.`, isError: true }
      try {
        if (action === 'list') {
          const all = directory.cached()
          const usable = all.filter((vm) => vm.agents)
          if (usable.length === 0) return 'No VM is open to agents. The user can turn that on for a VM on the Computers page.'
          return usable.map(describeVm).join('\n')
        }
        const vm = pick(directory, input.vm)
        if (action === 'start') {
          if (vm.phase === 'running') return `${vm.name} is already on.`
          await directory.start(vm.device, vm.id)
          return `${vm.name} is starting. It takes a little while to boot; \`list\` says when commands work, and \`screenshot\` shows the screen meanwhile.`
        }
        if (action === 'stop') {
          await directory.stop(vm.device, vm.id)
          return `${vm.name} is shutting down.`
        }
        directory.setActive(vm.device, vm.id, true)
        try {
          if (action === 'run') {
            const command = String(input.command ?? '').trim()
            if (!command) return { text: '`run` needs a command.', isError: true }
            const seconds = Math.max(1, Math.min(1800, Number(input.timeout_seconds) || 120))
            return formatExec(await directory.exec(vm.device, vm.id, command, seconds * 1000))
          }
          if (SCREEN.has(action)) {
            const actions: VmInput[] = []
            if (action === 'click' || action === 'double_click' || action === 'right_click') {
              actions.push({ type: 'click', x: num(input.x, 'x'), y: num(input.y, 'y'), button: action === 'right_click' ? 'right' : 'left', count: action === 'double_click' ? 2 : 1 })
            } else if (action === 'move') actions.push({ type: 'move', x: num(input.x, 'x'), y: num(input.y, 'y') })
            else if (action === 'drag') actions.push({ type: 'drag', from: [num(input.x, 'x'), num(input.y, 'y')], to: [num(input.to_x, 'to_x'), num(input.to_y, 'to_y')] })
            else if (action === 'scroll') actions.push({ type: 'scroll', x: num(input.x ?? 640, 'x'), y: num(input.y ?? 400, 'y'), dy: Number(input.scroll_y) || 0, dx: Number(input.scroll_x) || 0 })
            else if (action === 'type') {
              const text = String(input.text ?? '')
              if (!text) return { text: '`type` needs text.', isError: true }
              actions.push({ type: 'type', text })
            } else if (action === 'key') {
              const keys = String(input.keys ?? '').trim()
              if (!keys) return { text: '`key` needs keys, like "enter" or "ctrl+c".', isError: true }
              actions.push({ type: 'key', keys })
            }
            await directory.input(vm.device, vm.id, actions)
            // Give the screen a moment to change before looking.
            await new Promise((r) => setTimeout(r, action === 'type' || action === 'key' ? 400 : 600))
          }
          const shot = await directory.screenshot(vm.device, vm.id)
          return { text: `${vm.name}’s screen (${shot.width}×${shot.height}).`, images: [{ mime: 'image/png', data: shot.png }] }
        } finally {
          directory.setActive(vm.device, vm.id, false)
        }
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true }
      }
    }
  }
}

export function vmToolSource(directory: VmDirectory): ToolSource {
  const tool = vmTool(directory)
  return {
    id: 'vms',
    tools: (query) => (query.mode === 'work' && query.depth === 0 && directory.cached().some((vm) => vm.agents) ? [tool] : []),
    guidance: () => {
      const usable = directory.cached().filter((vm) => vm.agents)
      if (usable.length === 0) return null
      return (
        `The user has set aside ${usable.length === 1 ? 'a virtual machine' : 'virtual machines'} for agents (the \`vm\` tool): ${usable.map((vm) => `${vm.name} (${vm.version})`).join(', ')}. ` +
        'Prefer it for installing things, running untrusted code, long builds and anything that needs a desktop or a browser of its own, so the user’s computer stays untouched. ' +
        'Use `run` for commands; use the screen only for what needs it, and look (`screenshot`) before clicking.'
      )
    }
  }
}
