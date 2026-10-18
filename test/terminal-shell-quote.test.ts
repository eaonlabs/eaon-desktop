import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quoteArg, quoteCommand, shellKindOf } from '../src/main/features/terminals/shellQuote'
import { PtyManager, shellArgs } from '../src/main/features/terminals/ptyManager'
import { promptLine } from '../src/main/features/terminals'
import { registryPath } from '../src/main/shellEnv'

/**
 * What a pane types into its shell, written in that shell's syntax: POSIX on
 * macOS and Linux, PowerShell on Windows (cmd.exe where there is none).
 */

test('the shell a pane runs decides the syntax it is typed in', () => {
  assert.equal(shellKindOf('/bin/zsh', 'darwin'), 'posix')
  assert.equal(shellKindOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), 'powershell')
  assert.equal(shellKindOf('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32'), 'powershell')
  assert.equal(shellKindOf('C:\\Windows\\system32\\cmd.exe', 'win32'), 'cmd')
  assert.equal(shellKindOf('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'), 'posix')
})

test('POSIX: single quotes, an apostrophe closed and reopened around', () => {
  assert.equal(quoteArg('/usr/local/bin/eaon-cli', 'posix'), '/usr/local/bin/eaon-cli')
  assert.equal(quoteArg('/Applications/Eaon.app/Contents/eaon cli', 'posix'), `'/Applications/Eaon.app/Contents/eaon cli'`)
  assert.equal(quoteArg("it's", 'posix'), `'it'\\''s'`)
  assert.equal(quoteCommand('/Users/me/My Apps/eaon-cli', 'posix'), `'/Users/me/My Apps/eaon-cli'`)
})

test('PowerShell: a quoted program runs through &, and an apostrophe is doubled', () => {
  assert.equal(quoteCommand('C:\\Users\\me\\eaon-cli.exe', 'powershell'), 'C:\\Users\\me\\eaon-cli.exe', 'a path without spaces runs bare')
  assert.equal(quoteCommand('C:\\Program Files\\Eaon\\eaon-cli.exe', 'powershell'), `& 'C:\\Program Files\\Eaon\\eaon-cli.exe'`)
  assert.equal(quoteCommand("C:\\Users\\O'Brien\\eaon-cli.exe", 'powershell'), `& 'C:\\Users\\O''Brien\\eaon-cli.exe'`)
  assert.equal(quoteArg('it\u2019s $HOME; rm -rf / `whoami`', 'powershell'), `'it\u2019\u2019s $HOME; rm -rf / \`whoami\`'`)
  assert.equal(quoteArg('a,b', 'powershell'), `'a,b'`, 'a comma would make an array')
  assert.equal(quoteArg('@args', 'powershell'), `'@args'`, 'an @ would splat')
})

test('cmd: double quotes, doubled inside', () => {
  assert.equal(quoteCommand('C:\\Program Files\\Eaon\\eaon-cli.exe', 'cmd'), `"C:\\Program Files\\Eaon\\eaon-cli.exe"`)
  assert.equal(quoteArg('say "hi" & exit', 'cmd'), `"say ""hi"" & exit"`)
})

test('a task is typed as one argument in the pane’s own syntax', () => {
  const base = { paneId: 'p', cwd: 'C:\\w', cols: 80, rows: 24, agent: 'claude' as const }
  const task = `Review PR #7 (it's "broken"). Read .eaon/review-task.md`
  assert.equal(promptLine({ ...base, command: 'claude', prompt: task }, 'powershell').command, `claude 'Review PR #7 (it''s ''broken''). Read .eaon/review-task.md'`)
  assert.equal(promptLine({ ...base, command: 'claude', prompt: task }, 'cmd').command, `claude "Review PR #7 (it's 'broken'). Read .eaon/review-task.md"`)
  assert.equal(promptLine({ ...base, command: `& 'C:\\Program Files\\x\\claude.exe'`, prompt: 'go' }, 'powershell').command, `& 'C:\\Program Files\\x\\claude.exe' go`)
  assert.equal(promptLine({ ...base, command: 'claude', prompt: task }, 'posix').command, `claude 'Review PR #7 (it'\\''s "broken"). Read .eaon/review-task.md'`)
})

test('PowerShell starts with scripts allowed for its own process, so npm’s .ps1 shims run', () => {
  assert.deepEqual(shellArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32'), ['-NoLogo', '-ExecutionPolicy', 'Bypass'])
  assert.deepEqual(shellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), ['-NoLogo', '-ExecutionPolicy', 'Bypass'])
  assert.deepEqual(shellArgs('C:\\Windows\\system32\\cmd.exe', 'win32'), [])
  assert.deepEqual(shellArgs('/bin/zsh', 'darwin'), ['-l'])
})

test('the registry’s PATH is read out of `reg query`, its variables expanded', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\AppData\\Roaming\\npm;%NOPE%\\bin',
    ''
  ].join('\r\n')
  assert.equal(registryPath(output, { USERPROFILE: 'C:\\Users\\me' }), 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\AppData\\Roaming\\npm;%NOPE%\\bin')
  assert.equal(registryPath('    Path    REG_SZ    C:\\Windows', {}), 'C:\\Windows')
  assert.equal(registryPath('ERROR: The system was unable to find the specified registry key or value.', {}), null)
})

test('a pane in a folder that is gone says so instead of opening in the home folder', () => {
  const manager = new PtyManager()
  const result = manager.spawn({ paneId: 'gone', cwd: join(tmpdir(), 'eaon-no-such-folder-' + Date.now()), cols: 80, rows: 24, command: null })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /isn’t there any more/)
  assert.equal(manager.has('gone'), false)
})

test('closing a folder’s shells waits until they have exited', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-close-in-'))
  const other = mkdtempSync(join(tmpdir(), 'eaon-close-out-'))
  const manager = new PtyManager()
  const exits: string[] = []
  manager.setSender((channel, payload) => {
    if (channel === 'terminal:exit') exits.push((payload as { paneId: string }).paneId)
  })
  try {
    assert.ok(manager.spawn({ paneId: 'in', cwd: dir, cols: 80, rows: 24, command: null }).ok)
    assert.ok(manager.spawn({ paneId: 'out', cwd: other, cols: 80, rows: 24, command: null }).ok)
    // The window's kill arrives first, as it does when a session is removed.
    manager.kill('in')
    await manager.closeIn(dir, 10_000)
    assert.deepEqual(exits, ['in'], 'the shell in the folder has exited; the other is untouched')
    assert.equal(manager.has('out'), true)
  } finally {
    await manager.shutdown()
    rmSync(dir, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})
