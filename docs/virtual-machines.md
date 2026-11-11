# Virtual machines (Computers)

Whole computers that Eaon runs for the user and for agents: Linux on any
computer that can run VMs, macOS on a Mac with Apple silicon. They run on this
computer or on the linked worker computer (docs/worker-computer.md), a
Raspberry Pi among them. The user watches and uses a VM's screen live on the
Computers page; agents get the `vm` tool for VMs marked "Agents can use it".

## Pieces

| Where | What |
|---|---|
| `src/shared/vms.ts` | The types, the OS catalog (Ubuntu and Debian cloud images, macOS), sizing for a device, labels. |
| `src/main/vms/service.ts` | The manager one computer runs: VM folders, making VMs, starting and stopping, watching them come up, snapshots, and agents' commands, screenshots and input. Plain Node, so the worker host runs it too. |
| `src/main/vms/vz.ts` | A Mac: Apple's Virtualization framework through the `eaon-vm` helper. |
| `src/main/vms/qemu.ts` | Linux: QEMU, with KVM where there is one. |
| `native/vm-mac/main.swift` | The `eaon-vm` helper, built by `scripts/build-vm-helper.mjs` into `resources/vm/darwin/`. |
| `src/main/vms/seed.ts` | What a Linux VM is told on first boot (cloud-init). |
| `src/main/vms/qcow2.ts` | qcow2 → raw, for the Mac (cloud images are qcow2; the framework boots raw). |
| `src/main/vms/rfb.ts`, `des.ts`, `keys.ts`, `png.ts` | The agent's own VNC connection: screenshots as PNG, mouse and keys. |
| `src/main/vms/ssh.ts` | Running commands in a VM over SSH, with a key made for that VM. |
| `src/main/vms/tool.ts` | The `vm` tool. |
| `src/main/vms/ipc.ts` | The worker host's `vms:*` channels, and the live view's relayed screen. |
| `src/main/features/vms.ts` | The desktop: its own manager, the worker computer's through the link, the live view, the tool for both. |
| `src/renderer/src/components/computers/` | The Computers page, New VM, a VM's live screen (noVNC). |

## Making a VM

Linux: the cloud image for the computer's CPU (arm64 or x64; nothing is
emulated across architectures) is downloaded once into `<root>/images`, checked
against the publisher's SHA256SUMS/SHA512SUMS, and the VM's disk is made from
it: a raw sparse file on a Mac (`qcow2.ts`), a qcow2 overlay on the image under
QEMU. cloud-init's first boot (`seed.ts`) makes the account `eaon` (passwordless
sudo, the VM's own SSH key, a random password for its lock screen) and, for a
desktop VM, Xfce that logs itself in and never blanks or locks. Debian also
gets its standard kernel: the cloud kernel has no graphics driver, so the
screen would stay black. Desktop and Debian VMs restart once at the end; the
guest marks itself ready (`/run/eaon/ready`, from `eaon-ready.service`), which
is what "Ready" waits for. Until then the list shows what the setup is doing
(the package being installed, read over SSH), and a setup that fails says why
(the last error in cloud-init's output). Debian's desktop setup pins plymouth
out: its initramfs hook fails mid-install and leaves apt reporting an error.

macOS: the restore image Apple lists for this Mac (`eaon-vm macos-latest`), or
one the user has, installed with `VZMacOSInstaller` onto a sparse disk. The
user finishes Setup Assistant on the live screen. Agents use a macOS VM's
screen; it has no SSH Eaon can reach until the user turns on Remote Login.

## Running

A Mac: `eaon-vm run <dir>/config.json`, detached, so a VM outlives an Eaon
restart. It writes `run.json` (pid, state, VNC port, why it stopped) and takes
SIGTERM (shut down, forced after 30 s) and SIGINT (stop now). Eaon quitting
asks its VMs to shut down; the helper finishes that on its own.

- **Screen:** the framework's own VNC server (`_VZVNCServer`, private, reached
  through the Objective-C runtime and checked at every step), with a new random
  password each start. It listens on every interface, which can't be changed,
  but the password never crosses the network: only Eaon connects, from the same
  Mac. The helper is Developer ID signed, so macOS's firewall doesn't ask about
  it.
- **SSH:** over vsock, not the network: the guest listens on vsock port 2222
  (`eaon-ssh.socket`, `sshd -i` per connection), and the helper bridges a Unix
  socket in a short private folder to it. No IP address to find, and no Local
  Network permission (macOS refuses connections to the VM's NAT address from
  apps without it). The socket is set up in cloud-init's `bootcmd`, the first
  thing a first boot runs, so the setup can be followed and agents can get in
  while packages install; it's started with `--no-block` (waiting would
  deadlock the boot it's part of), and its service makes `/run/sshd` first
  (Ubuntu's own sshd starts on demand, so the folder may not exist yet).
- **Setup log:** a second serial port (the guest's `/dev/hvc1`), kept as
  `setup.log` in the VM's folder, gets everything cloud-init prints. Never the
  console: a login prompt there hangs up other writers mid-setup.
- **Disk:** a raw file with the host's cache (`.cached`) for Linux guests. With
  `.automatic`, Ubuntu's kernel got I/O errors under the heavy writes of
  installing a desktop, and its filesystem went read-only; Debian's didn't.

Linux: QEMU, detached, with its screen on a Unix socket (VNC, no password, only
this user can reach it), its control on another (QMP: `system_powerdown`,
`quit`), and SSH forwarded from a free port on 127.0.0.1. cloud-init's data is
served over HTTP on 127.0.0.1 (the guest's 10.0.2.2), its path carrying a
random token, and the guest is told where through the SMBIOS serial. The
service manager ends QEMU with the host app, so the host shuts its VMs down
properly when it stops and starts them again after (an update restarts the
VMs). VMs marked "Keep it running" start when the host does.

Snapshots are taken while a VM is off: APFS clones of the disk on a Mac (instant,
free until the VM writes), qcow2 internal snapshots under QEMU.

## What a computer can run

| Computer | Linux | macOS | Windows |
|---|---|---|---|
| Mac with Apple silicon (macOS 13+) | yes | yes, up to 2 at once | later |
| Intel Mac (macOS 13+) | yes | no | later |
| Linux, 64-bit, with KVM (a Pi 4 or 5) | yes | no | later |
| Linux without KVM | slowly | no | later |
| Windows (this computer) | not yet; use a worker computer | no | later |

macOS only runs on Apple hardware (Apple's licence, and its VMs need its chips).
A Linux computer without QEMU gets an Install button (`sudo apt-get install …`
when sudo needs no password, else the command to run), and one where the host
can't open `/dev/kvm` gets added to the `kvm` group.

## Agents

The `vm` tool is offered in Work mode, to the main agent, while at least one VM
is open to agents: `list`, `start`, `stop`, `run` (Linux, over SSH), `screenshot`
and `click`/`type`/`key`/`scroll`/`drag`, each screen action followed by a new
screenshot. Screenshots are taken on the computer that runs the VM (`rfb.ts`) and
cross the link once as a PNG. While an agent works, the VM shows "An agent is
using it" on the page and in its live view, where the user can watch or take
over.
