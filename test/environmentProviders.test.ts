import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  forgetHost,
  hostFor,
  parseFreestyle,
  parseAws,
  parseAzure,
  parseCoder,
  parseCodespaces,
  parseDigitalOcean,
  parseGcp,
  parseHetzner,
  parseLima,
  parseLinode,
  parseOrb,
  parseTailscale,
  parseVultr,
  rememberFound,
  sniff,
  type CliRunner
} from '../src/main/features/environments/providers'
import { sshArgv } from '../src/main/features/ade/ssh'

/**
 * The CLI sniffer (environments/providers.ts): each provider's listing read
 * from the shape its CLI prints, signed-out answers turned into the command
 * that fixes them, and a picked machine turned into how ssh reaches it.
 */

const scratch = mkdtempSync(join(tmpdir(), 'eaon-prov-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))

test('cloud VMs: address, user, state, and what to do when one is stopped', () => {
  const hz = parseHetzner(JSON.stringify([{ id: 42, name: 'box', status: 'running', public_net: { ipv4: { ip: '203.0.113.5' } }, server_type: { name: 'cx22' }, datacenter: { location: { name: 'fsn1' } } }, { id: 43, name: 'off', status: 'off', public_net: { ipv4: { ip: '203.0.113.6' } } }]))
  assert.deepEqual([hz[0].name, hz[0].running, hz[0].user, hz[0].detail, hz[0].why], ['box', true, 'root', 'fsn1 · cx22 · 203.0.113.5', null])
  assert.match(hz[1].why ?? '', /hcloud server poweron off/)

  const doc = parseDigitalOcean(JSON.stringify([{ id: 7, name: 'drop', status: 'active', networks: { v4: [{ ip_address: '10.0.0.2', type: 'private' }, { ip_address: '198.51.100.9', type: 'public' }] }, region: { slug: 'nyc3' }, size_slug: 's-1vcpu-1gb' }]))
  assert.equal(doc[0].detail, 'nyc3 · s-1vcpu-1gb · 198.51.100.9')
  assert.equal(doc[0].running, true)

  const home = join(scratch, 'home')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'work.pem'), 'key')
  const aws = parseAws(
    JSON.stringify({
      Reservations: [
        {
          Instances: [
            { InstanceId: 'i-1', State: { Name: 'running' }, PublicDnsName: 'ec2-1.compute.amazonaws.com', KeyName: 'work', Tags: [{ Key: 'Name', Value: 'api' }], Placement: { AvailabilityZone: 'us-east-1a' }, InstanceType: 't3.small' },
            { InstanceId: 'i-2', State: { Name: 'stopped' }, PublicDnsName: '', Tags: [] },
            { InstanceId: 'i-3', State: { Name: 'running' }, Platform: 'windows', PublicIpAddress: '1.2.3.4' }
          ]
        }
      ]
    }),
    home
  )
  assert.deepEqual(aws.map((m) => m.name), ['api', 'i-2'], 'a Windows instance is left out')
  assert.equal(aws[0].reach?.kind === 'address' && aws[0].reach.identityFile, join(home, '.ssh', 'work.pem'), 'the key pair’s .pem is offered when it is there')
  assert.equal(aws[1].why, 'It has no public address.')

  const gcp = parseGcp(JSON.stringify([{ name: 'vm-1', status: 'TERMINATED', zone: 'https://x/zones/europe-west1-b', machineType: 'https://x/machineTypes/e2-small', networkInterfaces: [{ accessConfigs: [{ natIP: '34.1.2.3' }] }] }]), home, 'me')
  assert.deepEqual([gcp[0].id, gcp[0].status, gcp[0].user, gcp[0].running], ['europe-west1-b/vm-1', 'terminated', 'me', false])
  assert.match(gcp[0].why ?? '', /gcloud compute instances start vm-1 --zone europe-west1-b/)

  const az = parseAzure(
    JSON.stringify([
      { id: '/subscriptions/x/vm1', name: 'vm1', powerState: 'VM running', publicIps: '20.1.2.3', fqdns: '', location: 'eastus', hardwareProfile: { vmSize: 'Standard_B1s' }, osProfile: { adminUsername: 'azureuser' }, storageProfile: { osDisk: { osType: 'Linux' } } },
      { name: 'win', powerState: 'VM running', publicIps: '20.1.2.4', storageProfile: { osDisk: { osType: 'Windows' } } }
    ])
  )
  assert.deepEqual([az.length, az[0].user, az[0].status, az[0].reach?.kind === 'address' && az[0].reach.hostname], [1, 'azureuser', 'running', '20.1.2.3'])

  const li = parseLinode(JSON.stringify([{ id: 9, label: 'web', status: 'running', ipv4: ['192.168.1.5', '45.33.1.2'], region: 'us-east', type: 'g6-nanode-1' }]))
  assert.equal(li[0].reach?.kind === 'address' && li[0].reach.hostname, '45.33.1.2', 'the public address, not the private one')

  const vu = parseVultr(JSON.stringify({ instances: [{ id: 'abc', label: 'vu', main_ip: '0.0.0.0', power_status: 'stopped' }, { id: 'def', label: 'up', main_ip: '149.28.1.1', power_status: 'running', region: 'ewr' }] }))
  assert.equal(vu[0].why, 'It has no public IPv4 address.')
  assert.equal(vu[1].running, true)
})

test('machines reached through their provider: Lima’s and OrbStack’s config, Coder’s proxy, a codespace', () => {
  const lima = parseLima('{"name":"deb","status":"Stopped","cpus":6,"arch":"aarch64","vmType":"vz","sshConfigFile":"/Users/me/.lima/deb/ssh.config"}\n{"name":"ubu","status":"Running","sshConfigFile":"/Users/me/.lima/ubu/ssh.config"}\n')
  assert.deepEqual(lima.map((m) => [m.name, m.running]), [['deb', false], ['ubu', true]])
  assert.match(lima[0].why ?? '', /limactl start deb/)
  assert.deepEqual(lima[1].reach, { kind: 'config', alias: 'lima-ubu', configFile: '/Users/me/.lima/ubu/ssh.config' })

  const orbJson = parseOrb(JSON.stringify([{ name: 'ubuntu', state: 'running', image: { distro: 'ubuntu', version: 'noble' } }]))
  assert.deepEqual(orbJson[0].reach?.kind === 'config' && orbJson[0].reach.alias, 'ubuntu@orb')
  const orbTable = parseOrb('NAME    STATE    DISTRO  VERSION  ARCH\narch    stopped  arch    current  arm64\n')
  assert.deepEqual([orbTable[0].name, orbTable[0].running], ['arch', false])

  const coder = parseCoder(JSON.stringify([{ name: 'dev', owner_name: 'me', template_name: 'docker', latest_build: { status: 'running' } }, { name: 'bad name;rm' }]), '/usr/local/bin/coder')
  assert.equal(coder.length, 1, 'a name that could be read as more than a name is left out')
  assert.deepEqual(coder[0].reach, { kind: 'proxy', hostname: 'coder.dev', proxyCommand: `'/usr/local/bin/coder' ssh --stdio 'me/dev'` })

  const cs = parseCodespaces(JSON.stringify([{ name: 'fluffy-space-x', displayName: 'fluffy space', state: 'Shutdown', repository: 'me/app', machineName: 'basicLinux32gb' }]))
  assert.deepEqual([cs[0].name, cs[0].status, cs[0].detail, cs[0].why], ['fluffy space', 'Shutdown', 'me/app · basicLinux32gb', null], 'a stopped codespace is started by gh when ssh reaches for it')
})

test('Tailscale: the tailnet’s computers that can run a session, and signed out', () => {
  const status = {
    BackendState: 'Running',
    CurrentTailnet: { Name: 'me@example.com' },
    Peer: {
      a: { ID: 'n1', HostName: 'pi', DNSName: 'pi.tail1.ts.net.', OS: 'linux', Online: true },
      b: { ID: 'n2', HostName: 'phone', DNSName: 'phone.tail1.ts.net.', OS: 'iOS', Online: true },
      c: { ID: 'n3', HostName: 'win', DNSName: 'win.tail1.ts.net.', OS: 'windows', Online: true },
      d: { ID: 'n4', HostName: 'mini', DNSName: 'mini.tail1.ts.net.', OS: 'macOS', Online: false }
    }
  }
  const listing = parseTailscale(JSON.stringify(status))
  assert.ok('machines' in listing)
  assert.deepEqual(
    listing.machines.map((m) => [m.name, m.detail, m.running]),
    [
      ['pi', 'linux · pi.tail1.ts.net', true],
      ['mini', 'macOS · mini.tail1.ts.net', false]
    ]
  )
  assert.equal(listing.account, 'me@example.com')
  const out = parseTailscale(JSON.stringify({ BackendState: 'NeedsLogin' }))
  assert.deepEqual(out, { state: 'signed-out', message: 'Tailscale is signed out on this computer.', fix: 'tailscale up' })
})

test('the sniffer: what’s missing says how to get it, signed out says how to sign in, ready lists machines', async () => {
  const run: CliRunner = async (bin, args) => {
    if (bin.endsWith('gh')) return { ok: false, code: 1, stdout: '', stderr: 'error getting codespaces: HTTP 403\nThis API operation needs the "codespace" scope. To request it, run:  gh auth refresh -h github.com -s codespace' }
    if (bin.endsWith('az') && args[0] === 'account') return { ok: true, code: 0, stdout: '{"name":"Sub 1"}', stderr: '' }
    if (bin.endsWith('az')) return { ok: true, code: 0, stdout: '[]', stderr: '' }
    if (bin.endsWith('hcloud')) return { ok: false, code: 1, stdout: '', stderr: 'hcloud: no active context or token (see `hcloud context --help`)' }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected' }
  }
  const find = (bins: string[]): string | null => (['gh', 'az', 'hcloud'].includes(bins[0]) ? `/bin/${bins[0]}` : null)
  const all = await sniff(run, find)
  const by = Object.fromEntries(all.map((p) => [p.id, p]))
  assert.deepEqual([by.codespaces.state, by.codespaces.fix], ['signed-out', 'gh auth refresh -h github.com -s codespace'])
  assert.deepEqual([by.azure.state, by.azure.account, by.azure.machines], ['ready', 'Sub 1', []])
  assert.deepEqual([by.hetzner.state, by.hetzner.fix], ['signed-out', 'hcloud context create <name>'])
  assert.deepEqual([by.aws.state, by.aws.fix], ['missing', 'brew install awscli'])
  assert.ok(!('reach' in (by.azure.machines[0] ?? {})), 'how a machine is reached stays in main')
})

test('a picked machine becomes the SSH host that reaches it', async () => {
  rememberFound('hetzner', '/bin/hcloud', parseHetzner(JSON.stringify([{ id: 42, name: 'box', status: 'running', public_net: { ipv4: { ip: '203.0.113.5' } } }])))
  const box = await hostFor('hetzner', '42', { dataDir: scratch })
  assert.deepEqual([box.id, box.hostname, box.user, box.source, box.provider], ['prov:hetzner:42', '203.0.113.5', 'root', 'manual', 'hetzner'])
  assert.equal((await hostFor('hetzner', '42', { dataDir: scratch, user: 'deploy' })).user, 'deploy')
  await assert.rejects(hostFor('hetzner', '42', { dataDir: scratch, user: 'x; rm' }), /user name/)
  await assert.rejects(hostFor('hetzner', 'nope', { dataDir: scratch }), /last look/)

  rememberFound('lima', '/bin/limactl', parseLima('{"name":"ubu","status":"Running","sshConfigFile":"/Users/me/.lima/ubu/ssh.config"}'))
  const lima = await hostFor('lima', 'ubu', { dataDir: scratch })
  assert.deepEqual(sshArgv(lima, { interactive: false }).slice(0, 2), ['-F', '/Users/me/.lima/ubu/ssh.config'])
  assert.equal(sshArgv(lima, { interactive: false }).at(-1), 'lima-ubu')

  rememberFound('coder', '/bin/coder', parseCoder(JSON.stringify([{ name: 'dev', owner_name: 'me', latest_build: { status: 'running' } }]), '/bin/coder'))
  const coder = await hostFor('coder', 'me/dev', { dataDir: scratch })
  assert.ok(sshArgv(coder, { interactive: false }).includes(`ProxyCommand='/bin/coder' ssh --stdio 'me/dev'`))

  // A codespace: gh writes its ssh config, which Eaon keeps beside its data and points ssh at.
  rememberFound('codespaces', '/bin/gh', parseCodespaces(JSON.stringify([{ name: 'fluffy-space-x', state: 'Available' }])))
  const fake: CliRunner = async (_bin, args) => ({ ok: true, code: 0, stdout: `Host cs.fluffy-space-x.main\n\tUser codespace\n\tProxyCommand gh cs ssh -c fluffy-space-x --stdio -- -i ~/.ssh/codespaces.auto\n`, stderr: args.join(' ') })
  const cs = await hostFor('codespaces', 'fluffy-space-x', { dataDir: scratch, run: fake })
  assert.equal(cs.alias, 'cs.fluffy-space-x.main')
  assert.match(readFileSync(cs.configFile!, 'utf8'), /ProxyCommand gh cs ssh -c fluffy-space-x --stdio/)
})

test('Freestyle: its VMs, and SSH through a token for one VM, made when it is picked and deleted when it is let go', async () => {
  const listing = JSON.stringify({
    vms: [
      { id: 'vm-ea74', state: 'running', slug: 'vm', displayName: null, resources: { cpu: 4, memory: 8192, storage: 32768 }, sourceSnapshotDisplayName: 'Ubuntu 24.04 LTS (4 vCPU · 8 GiB · 32 GB)' },
      { id: 'vm-bb01', state: 'paused', slug: 'other', resources: {} },
      { id: 'not a vm id', state: 'running' }
    ],
    totalCount: 3
  })
  const vms = parseFreestyle(listing)
  assert.deepEqual(vms.map((m) => [m.id, m.name, m.detail, m.running]), [
    ['vm-ea74', 'vm', 'Ubuntu 24.04 LTS · 4 vCPU, 8 GiB', true],
    ['vm-bb01', 'other', null, false]
  ])
  assert.match(vms[1].why ?? '', /freestyle vm start other/)

  // Picking it: an identity, allowed on that VM, with a token; written where only this user can read it.
  const calls: string[][] = []
  const run: CliRunner = async (_bin, args) => {
    calls.push(args)
    if (args[1] === 'create' && args[0] === 'identity') return { ok: true, code: 0, stdout: '{"id":"idn_123","managed":false}', stderr: '' }
    if (args[1] === 'permission') return { ok: true, code: 0, stdout: '{}', stderr: '' }
    if (args[1] === 'token') return { ok: true, code: 0, stdout: '{"id":"tok_1","token":"secret-token_9"}', stderr: '' }
    return { ok: true, code: 0, stdout: '', stderr: '' }
  }
  rememberFound('freestyle', '/bin/freestyle', vms)
  const host = await hostFor('freestyle', 'vm-ea74', { dataDir: scratch, run })
  assert.deepEqual(calls.slice(0, 3), [
    ['identity', 'create', '--output', 'json'],
    ['identity', 'permission', 'grant', 'idn_123', 'vm-ea74', '--output', 'json'],
    ['identity', 'token', 'create', 'idn_123', '--output', 'json']
  ])
  assert.deepEqual([host.alias, host.providerRef, host.source], ['eaon-freestyle-vm-ea74', 'idn_123', 'config'])
  const config = readFileSync(host.configFile!, 'utf8')
  assert.match(config, /HostName vm-ea74\.beta-ssh\.freestyle\.sh/)
  assert.match(config, /User vm-ea74:secret-token_9/)
  assert.equal(statSync(host.configFile!).mode & 0o777, 0o600, 'the token’s file is the user’s alone')
  assert.ok(!sshArgv(host, { interactive: false }).some((arg) => arg.includes('secret-token')), 'the token is never on a command line')
  assert.equal((await hostFor('freestyle', 'vm-ea74', { dataDir: scratch, run, user: 'dev' })).alias, 'eaon-freestyle-vm-ea74')
  assert.match(readFileSync(host.configFile!, 'utf8'), /User vm-ea74\+dev:secret-token_9/)

  // A step that fails takes the identity back with it.
  calls.length = 0
  const failing: CliRunner = async (bin, args) => (args[1] === 'token' ? { ok: false, code: 1, stdout: '', stderr: 'quota reached' } : run(bin, args))
  await assert.rejects(hostFor('freestyle', 'vm-ea74', { dataDir: scratch, run: failing }), /quota reached/)
  assert.deepEqual(calls.at(-1), ['identity', 'delete', 'idn_123'])

  // Let go: the identity deleted at Freestyle (its token with it), the file gone.
  calls.length = 0
  await forgetHost(host, scratch, run).catch((error: Error) => assert.match(error.message, /CLI isn’t on this computer/))
  if (calls.length) assert.deepEqual(calls[0], ['identity', 'delete', 'idn_123'])
  if (calls.length) assert.ok(!existsSync(host.configFile!))
})
