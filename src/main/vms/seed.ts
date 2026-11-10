import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { LinuxImage, VmArch } from '@shared/vms'

/**
 * What a Linux VM is told on its first boot (cloud-init's NoCloud data): its
 * name, the account agents use with that VM's own SSH key, and — for a
 * desktop VM — Xfce that logs itself in and never locks, so the screen an
 * agent sees is always the desktop. Once it's all done the guest marks
 * itself ready (/run/eaon/ready), which is what Eaon waits for before
 * calling the VM ready.
 *
 * On a Mac the data goes in on a small ISO (the guest finds it by its
 * "cidata" label); under QEMU it's served over HTTP to the guest, which is
 * told where through the VM's SMBIOS serial number.
 */

export interface SeedOptions {
  id: string
  hostname: string
  user: string
  password: string
  publicKey: string
  distro: LinuxImage['distro']
  arch: VmArch
  desktop: boolean
  /** The Mac's helper reaches SSH over vsock: the guest listens there too. */
  vsock: boolean
}

/** The vsock port the guest's SSH listens on for the helper's bridge. */
export const VSOCK_SSH_PORT = 2222

/** Says the VM is ready once it's set up and booted; a desktop VM once its desktop has logged in, so an agent's first look finds it. */
const readyUnit = (desktop: boolean): string => `[Unit]
Description=Tells Eaon this VM is ready
After=${desktop ? 'graphical.target' : 'multi-user.target'}
ConditionPathExists=/var/lib/eaon/setup-done

[Service]
Type=oneshot
${desktop ? "ExecStartPre=/bin/sh -c 'for i in $(seq 1 90); do pgrep -x xfce4-session >/dev/null && sleep 3 && exit 0; sleep 1; done; exit 0'\n" : ''}ExecStart=/bin/sh -c 'mkdir -p /run/eaon && touch /run/eaon/ready'

[Install]
WantedBy=${desktop ? 'graphical.target' : 'multi-user.target'}
`

export function metaData(options: SeedOptions): string {
  return `instance-id: eaon-${options.id}\nlocal-hostname: ${options.hostname}\n`
}

/** The packages a VM needs beyond the cloud image, and whether they need a restart to take effect. */
export function setupPackages(options: Pick<SeedOptions, 'distro' | 'arch' | 'desktop'>): { packages: string[]; reboot: boolean } {
  const packages: string[] = []
  // Debian's cloud kernel has no graphics driver, so the screen would stay black: the standard kernel has one.
  const kernel = options.distro === 'debian'
  if (kernel) packages.push(`linux-image-${options.arch === 'arm64' ? 'arm64' : 'amd64'}`)
  if (options.desktop) {
    packages.push('xfce4', 'xfce4-terminal', 'lightdm', 'dbus-x11', 'xserver-xorg-core', 'xserver-xorg-input-libinput', 'xdotool')
    packages.push(options.distro === 'debian' ? 'firefox-esr' : 'lightdm-gtk-greeter')
  }
  return { packages, reboot: kernel || options.desktop }
}

export function userData(options: SeedOptions): string {
  const { packages, reboot } = setupPackages(options)
  const files: Array<{ path: string; content: string; permissions?: string }> = [{ path: '/etc/systemd/system/eaon-ready.service', content: readyUnit(options.desktop) }]
  const run: string[] = ['systemctl daemon-reload', 'systemctl enable eaon-ready.service']

  const early: string[] = []
  if (options.vsock) {
    // From the first seconds of the first boot (bootcmd runs before everything else, write_files
    // included), so Eaon can follow the setup and agents can get in while packages install.
    const socket = `[Unit]\nDescription=SSH for Eaon over vsock\n\n[Socket]\nListenStream=vsock::${VSOCK_SSH_PORT}\nAccept=yes\n\n[Install]\nWantedBy=sockets.target\n`
    // sshd needs its privilege separation folder, which Ubuntu (whose own sshd starts on demand) has
    // only once someone has connected over TCP.
    const service = '[Unit]\nDescription=SSH for Eaon over vsock\n\n[Service]\nExecStartPre=-/bin/mkdir -p -m 0755 /run/sshd\nExecStart=-/usr/sbin/sshd -i\nStandardInput=socket\n'
    const write = (path: string, content: string): string => `echo ${Buffer.from(content).toString('base64')} | base64 -d > ${path}`
    // --no-block: this runs before the system has finished starting, and waiting for the socket to
    // start here would wait for the very start-up that's waiting for this.
    early.push(
      `${write('/etc/systemd/system/eaon-ssh.socket', socket)} && ${write('/etc/systemd/system/eaon-ssh@.service', service)} && systemctl daemon-reload && systemctl enable eaon-ssh.socket && systemctl start --no-block eaon-ssh.socket`
    )
  }

  if (options.distro === 'debian') {
    // GRUB would pick the cloud kernel (it sorts after the standard one): boot the standard one by name.
    files.push({ path: '/etc/default/grub.d/99-eaon.cfg', content: 'GRUB_DEFAULT=saved\nGRUB_DISABLE_SUBMENU=y\n' })
    run.push(
      `K=$(ls /boot/vmlinuz-* | sed 's#/boot/vmlinuz-##' | grep -v cloud | sort -V | tail -1); if [ -n "$K" ]; then update-grub && grub-set-default "Debian GNU/Linux, with Linux $K"; fi`
    )
  }

  if (options.desktop) {
    files.push(
      // A boot splash nobody sees, whose initramfs hook fails mid-install (it wants fontconfig's
      // configuration before that's set up), leaving apt reporting an error. It's only recommended: skip it.
      { path: '/etc/apt/preferences.d/eaon-no-plymouth', content: 'Package: plymouth plymouth-label plymouth-themes\nPin: release *\nPin-Priority: -1\n' },
      {
        path: '/etc/lightdm/lightdm.conf.d/50-eaon.conf',
        content: `[Seat:*]\nautologin-user=${options.user}\nautologin-user-timeout=0\nautologin-session=xfce\nuser-session=xfce\n`
      },
      // The screen an agent reads must never go blank or lock.
      { path: '/etc/xdg/autostart/eaon-awake.desktop', content: '[Desktop Entry]\nType=Application\nName=Keep the screen on\nExec=sh -c "xset s off; xset s noblank; xset -dpms"\nNoDisplay=true\n' }
    )
    run.push(
      'apt-get purge -y light-locker xfce4-screensaver xscreensaver || true',
      ...(options.distro === 'ubuntu' ? ['snap install firefox || true'] : []),
      'systemctl set-default graphical.target'
    )
  }

  run.push('mkdir -p /var/lib/eaon && date > /var/lib/eaon/setup-done')
  // Without a restart to come, it's ready now; with one, eaon-ready.service says so when it comes back.
  if (!reboot) run.push('systemctl start eaon-ready.service')

  const config: Record<string, unknown> = {
    hostname: options.hostname,
    manage_etc_hosts: true,
    users: [
      {
        name: options.user,
        groups: ['sudo'],
        shell: '/bin/bash',
        sudo: 'ALL=(ALL) NOPASSWD:ALL',
        lock_passwd: false,
        plain_text_passwd: options.password,
        ssh_authorized_keys: [options.publicKey]
      }
    ],
    ssh_pwauth: false,
    // What the setup says also goes to the VM's second serial port, which the computer running it keeps
    // as setup.log: a setup that went wrong can be read without getting in. Never the console (a login
    // prompt there hangs up other writers), and a port that won't take it is only warned about.
    ...(options.vsock ? { output: { all: '| tee --output-error=warn -a /var/log/cloud-init-output.log /dev/hvc1 > /dev/null' } } : {}),
    ...(early.length > 0 ? { bootcmd: early.map((command) => ['sh', '-c', command]) } : {}),
    write_files: files,
    runcmd: run.map((command) => ['sh', '-c', command])
  }
  if (packages.length > 0) {
    config.package_update = true
    config.packages = packages
  }
  if (reboot) config.power_state = { mode: 'reboot', condition: true, timeout: 60, message: 'Eaon: restarting into the finished setup' }
  // JSON is YAML, and it quotes everything that needs quoting.
  return `#cloud-config\n${JSON.stringify(config, null, 2)}\n`
}

const run = promisify(execFile)

/** The NoCloud ISO for a Mac VM, made with the system's own hdiutil. */
export async function writeSeedIso(file: string, options: SeedOptions): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-seed-'))
  try {
    writeFileSync(join(dir, 'meta-data'), metaData(options))
    writeFileSync(join(dir, 'user-data'), userData(options))
    rmSync(file, { force: true })
    await run('hdiutil', ['makehybrid', '-quiet', '-iso', '-joliet', '-default-volume-name', 'cidata', '-o', file, dir])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
