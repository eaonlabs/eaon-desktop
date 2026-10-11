import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRemote, remoteCwd, remoteLocation, type SshHost } from '../src/shared/adeRemote'
import { sessionSubtitle } from '../src/shared/adeSessions'
import { hostFromManualInput, hostsFromConfig, remoteCommandLine, remoteShellCommand, sshArgv } from '../src/main/features/ade/ssh'
import { SessionBook, type SavedSessions } from '../src/main/features/ade/sessions'

/**
 * Sessions on another machine (shared/adeRemote.ts, main/features/ade/ssh.ts):
 * the `ssh://` folder, what `ssh` is run with, and that the session list
 * treats a remote folder as a remote folder.
 */

const config: SshHost = { id: 'cfg:box', label: 'box', hostname: '10.0.0.5', user: 'me', port: 2222, identityFile: '/k', source: 'config', alias: 'box' }
const manual: SshHost = { id: 'manual:1', label: 'me@build', hostname: 'build.local', user: 'me', port: 2222, identityFile: '/Users/me/.ssh/id', source: 'manual', alias: null }

test('a remote folder round-trips through its ssh:// form, host ids with colons and all', () => {
  const cwd = remoteCwd('cfg:my box', '/home/me/My Project')
  assert.equal(cwd, 'ssh://cfg%3Amy%20box/home/me/My Project')
  assert.deepEqual(remoteLocation(cwd), { hostId: 'cfg:my box', path: '/home/me/My Project' })
  assert.equal(isRemote('/Users/me/project'), false)
  assert.equal(remoteLocation('ssh://nohost'), null)
})

test('a host from ~/.ssh/config is reached by its alias alone; one added in Eaon passes every flag', () => {
  assert.deepEqual(sshArgv(config, { interactive: true }), ['-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-tt', 'box'])
  assert.deepEqual(sshArgv(manual, { interactive: false }), [
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'BatchMode=yes',
    '-p', '2222', '-i', '/Users/me/.ssh/id', 'me@build.local'
  ])
})

test('every word sent to the remote shell is quoted, so a path or message can’t run anything', () => {
  assert.equal(remoteCommandLine("/srv/it's here", 'git', ['commit', '-m', 'a; rm -rf ~']), `cd '/srv/it'\\''s here' && 'git' 'commit' '-m' 'a; rm -rf ~'`)
  assert.equal(remoteShellCommand('/home/me/app'), `cd '/home/me/app' 2>/dev/null; exec "$SHELL" -l`)
})

test('~/.ssh/config gives one host per plain alias; wildcards and Match are left out', () => {
  const hosts = hostsFromConfig(['Host *', '  User nobody', 'Host box dev', '  HostName 10.0.0.5', '  Port 2222', '  User me', 'Host gpu-?', '  User x', 'Host=eq', 'HostName eq.local'].join('\n'))
  assert.deepEqual(hosts.map((h) => [h.alias, h.hostname, h.user, h.port]), [
    ['box', '10.0.0.5', 'me', 2222],
    ['dev', '10.0.0.5', 'me', 2222],
    ['eq', 'eq.local', null, null]
  ])
})

test('a typed host is checked before ssh ever sees it', () => {
  assert.throws(() => hostFromManualInput({ hostname: '-oProxyCommand=evil' }, 'x'))
  assert.throws(() => hostFromManualInput({ hostname: 'ok', user: 'a b' }, 'x'))
  assert.throws(() => hostFromManualInput({ hostname: 'ok', port: 70000 }, 'x'))
  assert.equal(hostFromManualInput({ hostname: 'build.local', user: 'me' }, 'x').label, 'me@build.local')
})

test('a remote session is never "folder not found", follows its branch over SSH, and says where it is', async () => {
  const saved = { value: null as SavedSessions | null }
  let branch: string | null = 'main'
  const book = new SessionBook({
    load: () => saved.value,
    save: (v) => (saved.value = structuredClone(v)),
    now: () => 1,
    worktreesRoot: () => '/tmp/none',
    remoteRepo: async () => ({ branch, repo: true })
  })
  const cwd = remoteCwd('cfg:box', '/home/me/app')
  const made = book.addRemote({ cwd, host: 'box', title: null, branch: 'main', repo: true })
  assert.equal(book.addRemote({ cwd, host: 'box', title: null, branch: 'main', repo: true }).id, made.id, 'one session per remote folder')
  branch = 'feature/x'
  const [session] = await book.refresh()
  assert.equal(session.missing, undefined)
  assert.equal(session.branch, 'feature/x')
  assert.equal(sessionSubtitle(session), 'feature/x · on box')
  assert.equal(new SessionBook({ load: () => saved.value, save: () => undefined, now: () => 1, worktreesRoot: () => '' }).list()[0].host, 'box', 'the host survives a restart')
})
