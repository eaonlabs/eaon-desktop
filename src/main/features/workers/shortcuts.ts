import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The user's Shortcuts on this Mac (macOS's `shortcuts` command), for a worker
 * linked to the Shortcuts app (labs): how a worker uses the apps on the
 * device. A shortcut can turn on a scene in Home, send a Message, play in
 * Music, start a Focus, or run an action any Mac or iPhone app adds to
 * Shortcuts — things no website reaches. The user makes the shortcut; the
 * worker lists them and runs one, with text as its input.
 */

const LIST_TIMEOUT_MS = 15_000
const RUN_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 4000

export type RunCommand = (args: string[], timeoutMs: number) => Promise<string>

const shortcutsCli: RunCommand = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/shortcuts', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const said = String(stderr || '').trim().split('\n').pop()
        reject(new Error((error as { killed?: boolean }).killed ? 'The shortcut didn’t finish in two minutes.' : said || error.message))
      } else resolve(String(stdout))
    })
  })

export function createShortcuts(run: RunCommand = shortcutsCli) {
  return {
    /** Every shortcut's name, as the Shortcuts app lists them. */
    async list(): Promise<string[]> {
      const out = await run(['list'], LIST_TIMEOUT_MS)
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    },

    /** Runs one by its exact name, with `input` as its text input; what it outputs, as text. */
    async run(name: string, input?: string): Promise<string> {
      const names = await this.list()
      const found = names.find((n) => n === name) ?? names.find((n) => n.toLowerCase() === name.toLowerCase())
      if (!found) {
        throw new Error(
          names.length
            ? `There’s no shortcut called “${name}”. The user has: ${names.slice(0, 40).join(', ')}.`
            : 'The user has no shortcuts yet. Suggest one they could make in the Shortcuts app for what they want.'
        )
      }
      const dir = await mkdtemp(join(tmpdir(), 'eaon-shortcut-'))
      try {
        const args = ['run', found, '--output-path', join(dir, 'output'), '--output-type', 'public.plain-text']
        if (input) {
          await writeFile(join(dir, 'input.txt'), input)
          args.push('--input-path', join(dir, 'input.txt'))
        }
        await run(args, RUN_TIMEOUT_MS)
        const output = await readFile(join(dir, 'output'), 'utf8').catch(() => '')
        return output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}…` : output
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
}

export type Shortcuts = ReturnType<typeof createShortcuts>
