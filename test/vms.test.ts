import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { desEncryptBlock, vncResponse } from '../src/main/vms/des'
import { encodePng } from '../src/main/vms/png'
import { charKeysym, forAppleVnc, needsShift, parseCombo } from '../src/main/vms/keys'
import { RfbClient } from '../src/main/vms/rfb'
import { metaData, setupPackages, userData, type SeedOptions } from '../src/main/vms/seed'
import { qemuArgs, qemuFix, type QemuSetup } from '../src/main/vms/qemu'
import { macFor } from '../src/main/vms/vz'
import { newSshKey, remoteCommand } from '../src/main/vms/ssh'
import { checksumFor } from '../src/main/vms/download'
import { qcow2ToRaw } from '../src/main/vms/qcow2'
import { vmTool, vmToolSource, type VmDirectory } from '../src/main/vms/tool'
import { createVmManager, setupStep } from '../src/main/vms/service'
import { registerVmIpc } from '../src/main/vms/ipc'
import type { BackendRun, VmBackendDriver, VmPaths } from '../src/main/vms/backend'
import { freeVmName, LINUX_IMAGES, vmLimits, vmPhaseLabel, vmSpaceNeededMB, type VmRecord, type VmStatus } from '@shared/vms'
import { hostForwardsEvent, hostServesChannel } from '@shared/workerHost'

const scratch = mkdtempSync(join(tmpdir(), 'eaon-vms-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const has = (command: string): boolean => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0

/* ------------------------------------------------------------ DES, VNC auth */

test('DES matches the textbook vector, and VNC answers with the password’s bits reversed', () => {
  assert.equal(desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex')).toString('hex'), '85e813540f0ab405')
  // The same challenge and password always give the same answer, and a different password a different one.
  const challenge = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const answer = vncResponse('secret12', challenge)
  assert.equal(answer.length, 16)
  assert.deepEqual(vncResponse('secret12', challenge), answer)
  assert.notDeepEqual(vncResponse('secret13', challenge), answer)
  // Only the first eight characters count, as in every VNC server.
  assert.deepEqual(vncResponse('secret12-and-more', challenge), answer)
})

/* ----------------------------------------------------------------- the VNC client */

/** A VNC server just big enough to test the client: VNC auth, a 4×2 screen, Raw updates, and what it was sent. */
function fakeVnc(password: string): Promise<{ port: number; got: Buffer[]; close: () => void }> {
  const got: Buffer[] = []
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0)
    let step = 0
    const challenge = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
    socket.write('RFB 003.008\n')
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (step === 0 && buffer.length >= 12) {
          buffer = buffer.subarray(12)
          socket.write(Buffer.from([1, 2]))
          step = 1
        } else if (step === 1 && buffer.length >= 1) {
          buffer = buffer.subarray(1)
          socket.write(challenge)
          step = 2
        } else if (step === 2 && buffer.length >= 16) {
          const ok = buffer.subarray(0, 16).equals(vncResponse(password, challenge))
          buffer = buffer.subarray(16)
          const result = Buffer.alloc(4)
          result.writeUInt32BE(ok ? 0 : 1)
          socket.write(result)
          if (!ok) {
            const reason = Buffer.from('wrong password')
            const length = Buffer.alloc(4)
            length.writeUInt32BE(reason.length)
            socket.end(Buffer.concat([length, reason]))
            return
          }
          step = 3
        } else if (step === 3 && buffer.length >= 1) {
          buffer = buffer.subarray(1)
          const init = Buffer.alloc(24 + 4)
          init.writeUInt16BE(4, 0)
          init.writeUInt16BE(2, 2)
          init.writeUInt32BE(4, 20)
          init.write('test', 24)
          socket.write(init)
          step = 4
        } else if (step === 4 && buffer.length >= 1) {
          const type = buffer[0]
          const size = type === 0 ? 20 : type === 2 ? 4 + buffer.readUInt16BE(2) * 4 : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : 1
          if (buffer.length < size) return
          const message = buffer.subarray(0, size)
          buffer = buffer.subarray(size)
          got.push(Buffer.from(message))
          // Only a request for the whole screen gets an answer: the screen never changes, so asks for changes wait.
          if (type === 3 && message[1] === 0) {
            // One Raw rectangle over the whole screen: pixel i is (i*10, i*20, i*30) as B, G, R, X.
            const head = Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 4, 0, 2, 0, 0, 0, 0])
            const pixels = Buffer.alloc(4 * 2 * 4)
            for (let i = 0; i < 8; i++) pixels.set([i * 30, i * 20, i * 10, 0], i * 4)
            socket.write(Buffer.concat([head, pixels]))
          }
        } else return
      }
    })
    socket.on('error', () => undefined)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, got, close: () => server.close() })))
}

const socketTo = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })

test('the VNC client logs in, takes a screenshot as RGBA, and sends the mouse and keys', async () => {
  const server = await fakeVnc('pw123456')
  try {
    const client = await RfbClient.connect(await socketTo(server.port), 'pw123456')
    assert.equal(client.width, 4)
    assert.equal(client.height, 2)
    assert.equal(client.name, 'test')
    const shot = await client.screenshot()
    assert.deepEqual([...shot.rgba.subarray(0, 4)], [0, 0, 0, 255])
    assert.deepEqual([...shot.rgba.subarray(3 * 4, 3 * 4 + 4)], [30, 60, 90, 255])
    client.pointer(3, 1, 1)
    client.key(0xff0d, true)
    await new Promise((r) => setTimeout(r, 100))
    const pointer = server.got.find((m) => m[0] === 5)!
    assert.deepEqual([...pointer], [5, 1, 0, 3, 0, 1])
    const key = server.got.find((m) => m[0] === 4)!
    assert.equal(key.readUInt32BE(4), 0xff0d)
    // It asked for 32-bit pixels, and only for encodings it can read.
    const format = server.got.find((m) => m[0] === 0)!
    assert.equal(format[4], 32)
    const encodings = server.got.find((m) => m[0] === 2)!
    const asked = Array.from({ length: encodings.readUInt16BE(2) }, (_, i) => encodings.readInt32BE(4 + i * 4))
    assert.deepEqual(asked.sort(), [-224, -223, 0, 1].sort())
    client.close()
  } finally {
    server.close()
  }
})

test('a wrong VNC password is refused with the server’s reason', async () => {
  const server = await fakeVnc('right-pw')
  try {
    await assert.rejects(RfbClient.connect(await socketTo(server.port), 'wrong-pw'), /didn’t accept the login: wrong password/)
  } finally {
    server.close()
  }
})

/* -------------------------------------------------------------------- PNG */

test('a screenshot becomes a PNG that decodes back to its pixels', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255])
  const png = encodePng(2, 2, rgba)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 2)
  assert.equal(png.readUInt32BE(20), 2)
  // IDAT holds filtered rows: undo filter 2 (Up) and the pixels come back.
  const idatAt = png.indexOf('IDAT')
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + png.readUInt32BE(idatAt - 4)))
  const rows: number[][] = []
  for (let y = 0; y < 2; y++) {
    assert.equal(raw[y * 7], 2)
    const row = [...raw.subarray(y * 7 + 1, y * 7 + 7)].map((byte, i) => (byte + (y > 0 ? rows[y - 1][i] : 0)) & 0xff)
    rows.push(row)
  }
  assert.deepEqual(rows, [
    [255, 0, 0, 0, 255, 0],
    [0, 0, 255, 10, 20, 30]
  ])
})

/* ------------------------------------------------------------------- keys */

test('keys: combinations put modifiers first, text maps to keysyms, and an unknown name says what to use', () => {
  assert.deepEqual(parseCombo('ctrl+shift+t'), [0xffe3, 0xffe1, 't'.charCodeAt(0)])
  assert.deepEqual(parseCombo('T+cmd'), [0xffeb, 't'.charCodeAt(0)])
  assert.deepEqual(parseCombo('enter'), [0xff0d])
  assert.deepEqual(parseCombo('F5'), [0xffc2])
  assert.throws(() => parseCombo('hyper+x'), /“hyper” isn’t a key/)
  assert.equal(charKeysym('a'), 0x61)
  assert.equal(charKeysym('\n'), 0xff0d)
  assert.equal(charKeysym('é'), 0xe9)
  assert.equal(charKeysym('€'), 0x01000000 + 0x20ac)
  assert.ok(needsShift('A') && needsShift('?') && !needsShift('a') && !needsShift('/'))
  // A Mac's VMs read Meta as Alt; everything else passes through.
  assert.deepEqual(parseCombo('ctrl+alt+t').map(forAppleVnc), [0xffe3, 0xffe7, 0x74])
  assert.equal(forAppleVnc(0xffea), 0xffe8)
  assert.equal(forAppleVnc(0xffe3), 0xffe3)
})

/* --------------------------------------------------------------- first boot */

const seed = (over: Partial<SeedOptions> = {}): SeedOptions => ({
  id: 'abcd1234',
  hostname: 'ubuntu',
  user: 'eaon',
  password: 'pw',
  publicKey: 'ssh-ed25519 AAAA test',
  distro: 'ubuntu',
  arch: 'arm64',
  desktop: false,
  vsock: false,
  ...over
})
const config = (text: string): Record<string, unknown> => {
  assert.ok(text.startsWith('#cloud-config\n'))
  return JSON.parse(text.slice('#cloud-config\n'.length)) as Record<string, unknown>
}

test('first boot: an Ubuntu terminal VM gets the account and key, needs no packages, and is ready at once', () => {
  const c = config(userData(seed()))
  const users = c.users as Array<Record<string, unknown>>
  assert.equal(users[0].name, 'eaon')
  assert.deepEqual(users[0].ssh_authorized_keys, ['ssh-ed25519 AAAA test'])
  assert.equal(users[0].sudo, 'ALL=(ALL) NOPASSWD:ALL')
  assert.equal(c.packages, undefined)
  assert.equal(c.power_state, undefined)
  const run = JSON.stringify(c.runcmd)
  assert.match(run, /systemctl start eaon-ready.service/)
  assert.doesNotMatch(run, /eaon-ssh.socket/)
  assert.equal(c.bootcmd, undefined)
  assert.equal(metaData(seed()), 'instance-id: eaon-abcd1234\nlocal-hostname: ubuntu\n')
})

test('first boot: a Debian desktop VM on a Mac gets the standard kernel, Xfce that logs in by itself, SSH over vsock, and a restart', () => {
  const c = config(userData(seed({ distro: 'debian', desktop: true, vsock: true, arch: 'x64' })))
  const packages = c.packages as string[]
  assert.ok(packages.includes('linux-image-amd64'))
  assert.ok(packages.includes('xfce4') && packages.includes('lightdm') && packages.includes('firefox-esr'))
  assert.ok(c.power_state)
  const files = c.write_files as Array<{ path: string; content: string }>
  assert.match(files.find((f) => f.path === '/etc/lightdm/lightdm.conf.d/50-eaon.conf')!.content, /autologin-user=eaon/)
  // Ready once the desktop has logged in, so an agent's first screenshot finds it.
  const ready = files.find((f) => f.path === '/etc/systemd/system/eaon-ready.service')!.content
  assert.match(ready, /After=graphical.target/)
  assert.match(ready, /pgrep -x xfce4-session/)
  // SSH over vsock starts in bootcmd, before the packages, so the setup can be followed.
  const boot = (c.bootcmd as string[][])[0][2]
  const unit = Buffer.from(/echo (\S+) \| base64 -d > \/etc\/systemd\/system\/eaon-ssh.socket/.exec(boot)![1], 'base64').toString()
  assert.match(unit, /ListenStream=vsock::2222/)
  const service = Buffer.from(/echo (\S+) \| base64 -d > \/etc\/systemd\/system\/eaon-ssh@.service/.exec(boot)![1], 'base64').toString()
  assert.match(service, /ExecStartPre=-\/bin\/mkdir -p -m 0755 \/run\/sshd/)
  // Never waited for: bootcmd runs before start-up has finished, and waiting would deadlock it.
  assert.match(boot, /systemctl start --no-block eaon-ssh.socket/)
  assert.doesNotMatch(boot, /--now/)
  const run = JSON.stringify(c.runcmd)
  assert.match(run, /grub-set-default/)
  assert.match(files.find((f) => f.path === '/etc/apt/preferences.d/eaon-no-plymouth')!.content, /Pin-Priority: -1/)
  assert.match(run, /light-locker/)
  // Ready only after the restart, when eaon-ready.service runs.
  assert.doesNotMatch(run, /systemctl start eaon-ready/)
  assert.deepEqual(setupPackages({ distro: 'ubuntu', arch: 'arm64', desktop: false }), { packages: [], reboot: false })
})

/* ------------------------------------------------------------------- sizes */

test('sizes: a Raspberry Pi 5 gets a 4 GB desktop VM, a 24 GB Mac an 8 GB macOS one, and nothing goes under a minimum', () => {
  const pi = vmLimits({ cpus: 4, memoryMB: 8 * 1024, diskFreeMB: 60 * 1024 }, 'linux', true)
  assert.deepEqual([pi.cpus.value, pi.memoryMB.value, pi.diskGB.value], [2, 4096, 32])
  assert.ok(pi.memoryMB.max <= 6 * 1024)
  const mac = vmLimits({ cpus: 10, memoryMB: 24 * 1024, diskFreeMB: 300 * 1024 }, 'macos', true)
  assert.deepEqual([mac.cpus.value, mac.memoryMB.value, mac.diskGB.value], [4, 8192, 80])
  const tiny = vmLimits({ cpus: 1, memoryMB: 1024, diskFreeMB: 4 * 1024 }, 'linux', false)
  assert.ok(tiny.memoryMB.value >= tiny.memoryMB.min && tiny.diskGB.value >= tiny.diskGB.min)
  // The space that has to be free: 21 GB is enough for a Linux desktop, not for Apple's download plus macOS.
  assert.ok(vmSpaceNeededMB('linux', 'ubuntu-24.04', true) < 21 * 1024)
  assert.ok(vmSpaceNeededMB('macos', 'macos-latest', true) > 21 * 1024)
  assert.ok(vmSpaceNeededMB('macos', 'macos-file', true) < vmSpaceNeededMB('macos', 'macos-latest', true))
  assert.equal(freeVmName('Ubuntu', ['ubuntu', 'Ubuntu 2']), 'Ubuntu 3')
  assert.equal(vmPhaseLabel({ phase: 'preparing', progress: { step: 'Downloading Debian 13', fraction: 0.42 }, error: null }), 'Downloading Debian 13 42%')
})

test('every Linux image has a download for both CPU types and a checksums file', () => {
  for (const image of LINUX_IMAGES) {
    assert.match(image.urls.arm64, /^https:\/\/.+arm64/)
    assert.match(image.urls.x64, /^https:\/\/.+amd64/)
    assert.match(image.sums.url, /SHA(256|512)SUMS$/)
  }
  assert.equal(checksumFor('abc0' + '0'.repeat(60) + ' *ubuntu.img\n', 'ubuntu.img'), 'abc0' + '0'.repeat(60))
  assert.equal(checksumFor('f'.repeat(128) + '  debian-13-genericcloud-arm64.qcow2\n', 'debian-13-genericcloud-arm64.qcow2'), 'f'.repeat(128))
  assert.equal(checksumFor('f'.repeat(64) + '  other.img\n', 'ubuntu.img'), null)
})

/* -------------------------------------------------------------------- QEMU */

const vmRecord = (over: Partial<VmRecord> = {}): VmRecord => ({
  id: 'a1b2c3d4',
  name: 'Ubuntu',
  os: 'linux',
  image: 'ubuntu-24.04',
  version: 'Ubuntu 24.04 LTS',
  desktop: true,
  cpus: 2,
  memoryMB: 4096,
  diskGB: 32,
  agents: true,
  backend: 'qemu',
  arch: 'arm64',
  createdAt: 1,
  user: 'eaon',
  snapshots: [],
  keepRunning: false,
  ...over
})
const vmPaths = (dir: string): VmPaths => ({
  dir,
  disk: join(dir, 'disk.qcow2'),
  seed: join(dir, 'seed.iso'),
  console: join(dir, 'console.log'),
  runFile: join(dir, 'run.json'),
  snapshots: join(dir, 'snapshots'),
  sshSocket: '/run/eaon/a.ssh',
  vncSocket: '/run/eaon/a.vnc',
  qmpSocket: '/run/eaon/a.qmp'
})

test('QEMU on a Pi with KVM: the host CPU, a tablet for VNC, SSH on 127.0.0.1, the screen on a socket, cloud-init over SMBIOS', () => {
  const setup: QemuSetup = { arch: 'arm64', binary: '/usr/bin/qemu-system-aarch64', img: '/usr/bin/qemu-img', firmware: { bios: '/usr/share/qemu-efi-aarch64/QEMU_EFI.fd' }, kvm: 'ok' }
  const args = qemuArgs(vmRecord(), vmPaths('/vms/a'), setup, { sshPort: 40022, seedUrl: 'http://10.0.2.2:5555/a1b2c3d4/token/' }).join(' ')
  assert.match(args, /-machine virt,gic-version=host -cpu host/)
  assert.match(args, /-accel kvm/)
  assert.match(args, /-bios \/usr\/share\/qemu-efi-aarch64\/QEMU_EFI.fd/)
  assert.match(args, /hostfwd=tcp:127.0.0.1:40022-:22/)
  assert.match(args, /-device usb-tablet/)
  assert.match(args, /-vnc unix:\/run\/eaon\/a.vnc/)
  assert.match(args, /type=1,serial=ds=nocloud;s=http:\/\/10.0.2.2:5555\/a1b2c3d4\/token\//)
  assert.match(args, /romfile=/)
  assert.match(args, /mac=52:54:00:a1:b2:c3/)
  assert.doesNotMatch(args, /-display/)
  // Without KVM it still runs, emulated.
  const slow = qemuArgs(vmRecord(), vmPaths('/vms/a'), { ...setup, kvm: 'missing' }, { sshPort: 1 }).join(' ')
  assert.match(slow, /-cpu max/)
  assert.match(slow, /-accel tcg/)
  assert.equal(macFor('a1b2c3d4'), '52:54:00:a1:b2:c3')
})

test('QEMU missing says what to install; KVM it can’t open says how to allow it', () => {
  const none: QemuSetup = { arch: 'arm64', binary: null, img: null, firmware: null, kvm: 'no-access' }
  const fix = qemuFix(none, 'pi')
  assert.ok(fix)
  assert.match(fix.command, /usermod -aG kvm pi/)
  assert.equal(qemuFix({ arch: 'x64', binary: '/q', img: '/i', firmware: null, kvm: 'ok' }, 'pi'), null)
})

/* --------------------------------------------------------------------- SSH */

test('a VM’s SSH key is written in OpenSSH’s own format, and ssh-keygen agrees on its public half', { skip: !has('ssh-keygen') }, () => {
  const key = newSshKey('eaon-test')
  assert.match(key.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/)
  const file = join(scratch, 'key')
  writeFileSync(file, key.privateKey, { mode: 0o600 })
  const derived = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim()
  assert.equal(derived.split(' ').slice(0, 2).join(' '), key.publicKey.split(' ').slice(0, 2).join(' '))
  assert.equal(remoteCommand(`echo 'hi'`), `bash -lc 'echo '\\''hi'\\'''`)
})

/* ------------------------------------------------------------------- qcow2 */

test('a compressed qcow2 image becomes the same raw disk qemu-img makes, sparse and grown to size', { skip: !has('qemu-img') }, async () => {
  const raw = join(scratch, 'source.raw')
  // Some data, some zeros, a block of text: enough to cover data, zero and compressed clusters.
  const disk = Buffer.alloc(8 * 1024 * 1024)
  for (let i = 0; i < 1024 * 1024; i++) disk[i] = (i * 31) & 0xff
  disk.write('Eaon VM test '.repeat(5000), 5 * 1024 * 1024)
  writeFileSync(raw, disk)
  const qcow = join(scratch, 'source.qcow2')
  execFileSync('qemu-img', ['convert', '-c', '-O', 'qcow2', raw, qcow])
  const out = join(scratch, 'out.raw')
  const info = await qcow2ToRaw(qcow, out, { minSize: 16 * 1024 * 1024 })
  assert.equal(info.virtualSize, disk.length)
  const back = readFileSync(out)
  assert.equal(back.length, 16 * 1024 * 1024)
  assert.ok(back.subarray(0, disk.length).equals(disk))
  assert.ok(back.subarray(disk.length).every((b) => b === 0))
})

test('anything but a qcow2 image is refused by name', async () => {
  const notQcow = join(scratch, 'plain.img')
  writeFileSync(notQcow, Buffer.alloc(4096))
  await assert.rejects(qcow2ToRaw(notQcow, join(scratch, 'x.raw')), /isn’t a qcow2 disk image/)
})

/* ------------------------------------------------------------------- the tool */

const status = (over: Partial<VmStatus> = {}): VmStatus => ({ ...vmRecord(), device: 'local', phase: 'running', progress: null, error: null, ready: true, screen: true, agentActive: false, ...over })

function directory(vms: VmStatus[]): VmDirectory & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    cached: () => vms,
    start: async (_d, id) => (calls.push(`start ${id}`), status()),
    stop: async (_d, id) => (calls.push(`stop ${id}`), status()),
    exec: async (_d, id, command) => (calls.push(`exec ${id} ${command}`), { exitCode: 0, stdout: 'Linux\n', stderr: '', timedOut: false }),
    screenshot: async (_d, id) => (calls.push(`shot ${id}`), { png: 'iVBOR', width: 1280, height: 800 }),
    input: async (_d, id, actions) => void calls.push(`input ${id} ${JSON.stringify(actions)}`),
    setActive: (_d, id, active) => void calls.push(`active ${id} ${active}`)
  }
}

const query = (mode: 'chat' | 'work', depth = 0) => ({ mode, depth, cwd: null, readOnly: false, settings: {} as never, request: {} as never })

test('the vm tool is offered in Work only when a VM is open to agents, and only to the main agent', () => {
  assert.equal(vmToolSource(directory([status({ agents: false })])).tools(query('work')).length, 0)
  const source = vmToolSource(directory([status()]))
  assert.equal(source.tools(query('work')).length, 1)
  assert.equal(source.tools(query('chat')).length, 0)
  assert.equal(source.tools(query('work', 1)).length, 0)
  assert.match(source.guidance!(query('work')) ?? '', /Ubuntu \(Ubuntu 24.04 LTS\)/)
})

test('the vm tool runs commands, clicks then looks, and picks the VM by name', async () => {
  const dir = directory([status(), status({ id: 'b', name: 'Debian box', version: 'Debian 13' }), status({ id: 'c', name: 'Private', agents: false })])
  const tool = vmTool(dir)
  const listed = String(await tool.run({ action: 'list' }, {} as never))
  assert.match(listed, /Ubuntu/)
  assert.match(listed, /Debian box/)
  assert.doesNotMatch(listed, /Private/)
  const ambiguous = (await tool.run({ action: 'run', command: 'uname' }, {} as never)) as { text: string; isError: boolean }
  assert.ok(ambiguous.isError)
  assert.match(ambiguous.text, /Say which VM/)
  const ran = String(await tool.run({ action: 'run', vm: 'debian', command: 'uname' }, {} as never))
  assert.match(ran, /Linux\n\[exit code 0\]/)
  const clicked = (await tool.run({ action: 'double_click', vm: 'Ubuntu', x: 10, y: 20 }, {} as never)) as { images: unknown[] }
  assert.equal(clicked.images.length, 1)
  assert.ok(dir.calls.includes(`input a1b2c3d4 ${JSON.stringify([{ type: 'click', x: 10, y: 20, button: 'left', count: 2 }])}`))
  assert.deepEqual(
    dir.calls.filter((c) => c.startsWith('active')),
    ['active b true', 'active b false', 'active a1b2c3d4 true', 'active a1b2c3d4 false']
  )
  const hidden = (await tool.run({ action: 'screenshot', vm: 'Private' }, {} as never)) as { isError: boolean }
  assert.ok(hidden.isError)
  assert.equal(typeof tool.mutating === 'function' && tool.mutating({ action: 'screenshot' }, {} as never), false)
})

test('the first boot’s progress reads as what it’s installing, a restart, or a setup that failed', () => {
  assert.deepEqual(setupStep('ready\n', true), { ready: true, step: '', failed: false })
  assert.equal(setupStep('status: running\nSetting up xfce4-panel (4.20.4-1) ...\n', true).step, 'Setting up the desktop: installing xfce4-panel')
  assert.equal(setupStep('status: running\nGet:42 http://deb.debian.org/debian trixie/main arm64 firefox-esr\n', true).step, 'Setting up the desktop: downloading packages')
  assert.equal(setupStep('status: done\n', false).step, 'Restarting into the finished setup')
  const failed = setupStep('status: error\nwhy: E: Sub-process /usr/bin/dpkg returned an error code (1)\n', true)
  assert.ok(failed.failed)
  assert.equal(failed.step, 'Setting up the desktop didn’t finish: E: Sub-process /usr/bin/dpkg returned an error code (1)')
  // SSH not answering yet: the plain step.
  assert.equal(setupStep('', false).step, 'Setting up Linux')
})

/* --------------------------------------------------------------- the manager */

function fakeDriver(): VmBackendDriver & { running: Set<string>; log: string[] } {
  const running = new Set<string>()
  const log: string[] = []
  return {
    running,
    log,
    kind: 'qemu',
    diskFormat: 'qcow2',
    prepareDisk: async () => undefined,
    start: async (vm) => void (running.add(vm.id), log.push(`start ${vm.id}`)),
    stop: async (vm, _p, force) => void (running.delete(vm.id), log.push(`stop ${vm.id}${force ? ' force' : ''}`)),
    status: (vm): BackendRun => ({ running: running.has(vm.id), stopping: false, error: null, vnc: null }),
    ssh: () => null,
    snapshot: async (vm, _p, id) => void log.push(`snapshot ${vm.id} ${id}`),
    restore: async (vm, _p, id) => void log.push(`restore ${vm.id} ${id}`),
    deleteSnapshot: async (vm, _p, id) => void log.push(`delete-snapshot ${vm.id} ${id}`)
  }
}

test('the manager loads its VMs, never shows their passwords, and won’t snapshot one that’s running', async () => {
  const root = join(scratch, 'manager')
  mkdirSync(join(root, 'f00dbabe'), { recursive: true })
  writeFileSync(join(root, 'f00dbabe', 'vm.json'), JSON.stringify({ ...vmRecord({ id: 'f00dbabe', name: 'Box' }), password: 'hunter2', setUp: true, seedToken: 't', hostname: 'box' }))
  const driver = fakeDriver()
  const changes: VmStatus[][] = []
  const manager = createVmManager({ root, socketDir: join(scratch, 's'), helper: null, device: 'host', name: () => 'pi', onChange: (vms) => changes.push(vms), driver })
  try {
    const [vm] = manager.list()
    assert.equal(vm.name, 'Box')
    assert.equal(vm.device, 'host')
    assert.equal(vm.phase, 'stopped')
    assert.doesNotMatch(JSON.stringify(manager.list()), /hunter2/)
    assert.deepEqual(manager.login('f00dbabe'), { user: 'eaon', password: 'hunter2' })

    await manager.start('f00dbabe')
    assert.ok(driver.running.has('f00dbabe'))
    await assert.rejects(manager.snapshot('f00dbabe'), /Turn Box off to take a snapshot/)
    await manager.stop('f00dbabe', true)
    const after = await manager.snapshot('f00dbabe', 'Clean')
    assert.equal(after.snapshots[0].name, 'Clean')
    await manager.restore('f00dbabe', after.snapshots[0].id)
    await manager.update('f00dbabe', { name: 'Renamed', agents: false })
    assert.equal(manager.list()[0].name, 'Renamed')
    assert.equal(JSON.parse(readFileSync(join(root, 'f00dbabe', 'vm.json'), 'utf8')).name, 'Renamed')
    await assert.rejects(manager.exec('f00dbabe', 'true'), /Renamed is off/)
    await manager.remove('f00dbabe')
    assert.equal(manager.list().length, 0)
    assert.ok(changes.length > 0)
    assert.deepEqual(driver.log.slice(0, 2), ['start f00dbabe', 'stop f00dbabe force'])
  } finally {
    await manager.shutdown({ stopVms: false, resumeLater: false })
  }
})

test('the worker computer serves VM calls whether or not workers run there, and sends only VM list changes on its own', () => {
  assert.ok(hostServesChannel('vms:list', []))
  assert.ok(hostServesChannel('vms:vncOpen', ['x']))
  assert.ok(hostForwardsEvent('vms:changed'))
  // Screen bytes go only to the desktop that opened the screen, never to every linked one.
  assert.ok(!hostForwardsEvent('vms:vncData'))
})

test('a terminal reaches the VM’s SSH as raw bytes, here or relayed by the worker computer, and only while it runs', async () => {
  // An SSH server stand-in: answers each line with it upper-cased.
  const sshd = createServer((socket) => socket.on('data', (chunk) => socket.write(chunk.toString().toUpperCase())))
  await new Promise<void>((resolve) => sshd.listen(0, '127.0.0.1', resolve))
  const port = (sshd.address() as AddressInfo).port
  const root = join(scratch, 'terminal')
  mkdirSync(join(root, 'cafe0001'), { recursive: true })
  writeFileSync(join(root, 'cafe0001', 'vm.json'), JSON.stringify({ ...vmRecord({ id: 'cafe0001', name: 'Pi box' }), password: 'pw', setUp: true, seedToken: 't', hostname: 'pibox' }))
  writeFileSync(join(root, 'cafe0001', 'ssh-key'), 'PRIVATE KEY\n')
  const driver = { ...fakeDriver(), ssh: () => ({ port }) }
  const manager = createVmManager({ root, socketDir: join(scratch, 's'), helper: null, device: 'host', name: () => 'pi', onChange: () => undefined, driver })
  const read = (socket: Socket): Promise<string> => new Promise((resolve) => socket.once('data', (chunk) => resolve(chunk.toString())))
  try {
    await assert.rejects(manager.openSsh('cafe0001'), /Pi box is off/)
    assert.deepEqual(await manager.sshKey('cafe0001'), { user: 'eaon', privateKey: 'PRIVATE KEY\n' })
    await manager.start('cafe0001')
    const direct = await manager.openSsh('cafe0001')
    direct.write('hello')
    assert.equal(await read(direct), 'HELLO')
    direct.destroy()

    // The worker host's side: the desktop's bytes come in base64 and go back the same way.
    const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
    const sent: [string, unknown[]][] = []
    const sender = { send: (channel: string, ...args: unknown[]) => sent.push([channel, args]), isDestroyed: () => false, once: () => undefined }
    const off = registerVmIpc({ handle: (channel, handler) => void handlers.set(channel, handler as never) }, manager)
    const { session } = (await handlers.get('vms:sshOpen')!({ sender }, 'cafe0001')) as { session: string }
    await handlers.get('vms:vncSend')!({ sender }, session, Buffer.from('relayed').toString('base64'))
    for (let i = 0; i < 50 && !sent.some(([channel]) => channel === 'vms:vncData'); i++) await new Promise((r) => setTimeout(r, 10))
    const [, [from, data]] = sent.find(([channel]) => channel === 'vms:vncData')!
    assert.equal(from, session)
    assert.equal(Buffer.from(String(data), 'base64').toString(), 'RELAYED')
    await handlers.get('vms:vncClose')!({ sender }, session)
    off()
  } finally {
    await manager.shutdown({ stopVms: false, resumeLater: false })
    sshd.close()
  }
})

test('a macOS VM has no terminal to open', async () => {
  const root = join(scratch, 'terminal-mac')
  mkdirSync(join(root, 'cafe0002'), { recursive: true })
  writeFileSync(join(root, 'cafe0002', 'vm.json'), JSON.stringify({ ...vmRecord({ id: 'cafe0002', name: 'Mac box', os: 'macos' }), password: 'pw', setUp: true, seedToken: 't', hostname: 'mac' }))
  const manager = createVmManager({ root, socketDir: join(scratch, 's'), helper: null, device: 'local', name: () => 'mac', onChange: () => undefined, driver: fakeDriver() })
  try {
    await assert.rejects(manager.sshKey('cafe0002'), /it’s a macOS VM/)
  } finally {
    await manager.shutdown({ stopVms: false, resumeLater: false })
  }
})

test('installing QEMU that adds the kvm group restarts the worker computer’s Eaon, where a service will start it again', async () => {
  const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, handler: unknown) => void handlers.set(channel, handler as never) }
  const manager = { installTools: async () => ({ ok: true, command: 'sudo usermod -aG kvm pi', output: '', restartNeeded: true }) } as unknown as Parameters<typeof registerVmIpc>[1]
  let restarted = 0
  registerVmIpc(ipc, manager, { restart: () => restarted++ })
  const sender = { send: () => undefined, isDestroyed: () => false, once: () => undefined }
  assert.equal(((await handlers.get('vms:installTools')!({ sender })) as { restarting?: boolean }).restarting, true)
  await new Promise((r) => setTimeout(r, 1600))
  assert.equal(restarted, 1)
  // Without a service to start it again (run by hand), it says to restart instead.
  handlers.clear()
  registerVmIpc(ipc, manager)
  const plain = (await handlers.get('vms:installTools')!({ sender })) as { restarting?: boolean; restartNeeded?: boolean }
  assert.equal(plain.restarting, undefined)
  assert.equal(plain.restartNeeded, true)
})
