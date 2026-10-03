/**
 * Reading a `run_command` call for its card: the programs it runs, for the
 * header, and how it ended, for the exit badge. Pure, so it can be tested
 * without a renderer.
 */

/** Words before the program that say nothing about what ran. */
const PREFIXES = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command'])

/**
 * The programs a command line runs, in order and without repeats: `cd app &&
 * NODE_ENV=test npm test | grep fail` → "npm, grep". A `cd` is left out
 * unless it is all there is, since every agent command starts with one.
 */
export function commandSummary(command: string): string {
  const programs: string[] = []
  for (const segment of command.split(/\|\||&&|[|;\n]/)) {
    const words = segment.trim().split(/\s+/)
    let index = 0
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) || PREFIXES.has(words[index]))) index++
    const word = words[index]?.replace(/^[('"]+/, '')
    if (!word) continue
    const program = word.split('/').pop() || word
    if (!programs.includes(program)) programs.push(program)
  }
  const named = programs.length > 1 ? programs.filter((p) => p !== 'cd') : programs
  return named.slice(0, 4).join(', ')
}

/**
 * `run_command` reports how the shell ended on its first line ("exit code 1",
 * "terminated (SIGTERM)") and the output after it; "(no output)" means none.
 * A background start or an error message has no status line and is all text.
 */
export function splitCommandOutput(output: string | null): { exit: number | null; signal: string | null; text: string } {
  if (!output) return { exit: null, signal: null, text: '' }
  const newline = output.indexOf('\n')
  const first = newline === -1 ? output : output.slice(0, newline)
  const rest = newline === -1 ? '' : output.slice(newline + 1)
  const code = /^exit code (-?\d+)$/.exec(first)
  const killed = /^terminated \((.+)\)$/.exec(first)
  if (!code && !killed) return { exit: null, signal: null, text: output }
  const text = rest.startsWith('(no output)') ? rest.slice('(no output)'.length).trim() : rest
  return { exit: code ? Number(code[1]) : null, signal: killed ? killed[1] : null, text }
}
