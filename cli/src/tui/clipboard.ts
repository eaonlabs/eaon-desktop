import { spawnSync } from 'node:child_process'

/**
 * Puts text on the system clipboard: the platform's own tool when there is
 * one, else the terminal's OSC 52 sequence (which also works over SSH in
 * terminals that allow it). Returns false when neither could be tried.
 */
export function copyToClipboard(text: string, write: (data: string) => void = (d) => process.stdout.write(d)): boolean {
  const tools: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']]
          ]
  for (const [command, args] of tools) {
    const result = spawnSync(command, args, { input: text, timeout: 2000, stdio: ['pipe', 'ignore', 'ignore'] })
    if (result.status === 0) return true
  }
  write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)
  return true
}
