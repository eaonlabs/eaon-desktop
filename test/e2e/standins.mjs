/**
 * Stand-ins for the coding CLIs a developer's Mac has signed in. A scratch
 * HOME hides ~/.codex and ~/.claude, but Claude Code and Copilot keep their
 * sign-in in the login keychain, which a scratch HOME does not hide. Put
 * first on PATH, these answer as a CLI that is installed and signed out, so
 * no run of the suite starts a turn on someone's plan.
 *
 * First on PATH is not enough on its own: Eaon reads PATH from a login shell
 * (shellEnv.ts), and on a Mac the login shell's path_helper puts
 * /etc/paths.d (Homebrew's /opt/homebrew/bin among them) ahead of what it
 * was given. The stand-in shell is a login shell that reads no profile, so
 * PATH comes back as it went in.
 *
 * Scenarios that bring their own stand-ins put theirs before these, and
 * their own EAON_CODEX_BIN, EAON_CLAUDE_BIN and SHELL win over these.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** name → shell script. Each prints what the real one prints when signed out. */
const SCRIPTS = {
  claude: `case "$1" in
  --version|-v) echo "2.1.300 (Claude Code)" ;;
  auth) echo '{"loggedIn":false}'; exit 1 ;;
  *) echo "claude (test stand-in): not signed in" >&2; exit 1 ;;
esac`,
  codex: `case "$1" in
  --version|-V) echo "codex-cli 1.0.0" ;;
  login) echo "Not logged in" >&2; exit 1 ;;
  *) echo "codex (test stand-in): not signed in" >&2; exit 1 ;;
esac`,
  copilot: `case "$1" in
  --version) echo "0.0.350" ;;
  *) echo "copilot (test stand-in): not signed in" >&2; exit 1 ;;
esac`,
  gemini: `case "$1" in
  --version) echo "0.10.0" ;;
  *) echo "gemini (test stand-in): not signed in" >&2; exit 1 ;;
esac`,
  gh: `case "$1" in
  --version) echo "gh version 2.80.0 (test stand-in)" ;;
  auth) echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1 ;;
  *) echo "gh (test stand-in): not logged in" >&2; exit 4 ;;
esac`,
}

/**
 * The login shell: bash with no profile. It is named bash, in a folder of its
 * own off PATH, because Eaon tells a bare prompt from a program by comparing
 * the pane's foreground process with $SHELL's name (terminals/strayModes.ts).
 */
const SHELL = 'exec /bin/bash --noprofile --norc "$@"'

/**
 * Writes the stand-ins into `dir` and returns the folder to put first on
 * PATH, plus the variables that point Eaon's own searches at them.
 * @param {string} dir
 */
export function writeStandIns(dir) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const [name, body] of Object.entries(SCRIPTS)) {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  const shell = join(dir, 'shell', 'bash')
  mkdirSync(join(dir, 'shell'), { recursive: true })
  writeFileSync(shell, `#!/bin/sh\n${SHELL}\n`)
  chmodSync(shell, 0o755)
  return { bin, env: { EAON_CODEX_BIN: join(bin, 'codex'), EAON_CLAUDE_BIN: join(bin, 'claude'), SHELL: shell } }
}
