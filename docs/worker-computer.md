# Worker computer

Workers can run on another computer the user leaves on (a Raspberry Pi, a
spare Mac, a home server) instead of on the computer running Eaon Desktop.
They keep working, with their own browsers, while the desktop sleeps; the
desktop still shows them in the Workers tab and can watch and take over their
browsers.

## Pieces

| Where | What |
|---|---|
| `src/host/` | The host app: the desktop's main process with no window, running the workers service (and, under Electron, each worker's browser). `main.ts` is the entry, `boot.ts` starts it, `host.ts` answers the desktop, `sync.ts` applies keys and settings, `install.sh` installs, updates and removes it. |
| `scripts/build-host.mjs` | Builds `out/host/eaon-host.tgz` (both bundles, BetterWright's `node_modules`, `install.sh`) and `out/host/eaon-host.json` (build id, Electron version, hash). Part of `npm run build` and every release script; the app ships both files. |
| `src/main/workerHost/` | `channel.ts` (the encrypted link and its RPC), `client.ts` (the desktop's connection, reconnecting), `install.ts` (SSH install and the one-line install), `move.ts` (workers' files moving between computers). |
| `src/main/features/workerHost.ts` | The desktop side: linking, keeping the host synced and updated, moving workers, and answering the Workers tab's IPC from the host while they run there. |
| `src/renderer/.../settings/pages/WorkerComputer.tsx` | Settings → Workers → Worker computer. |

## The host

`install.sh` puts everything in `~/.eaon-host`: `app/` (the package),
`runtime/` (Electron for that computer, downloaded from GitHub once per
version), `data/` (the profile: workers, keys), `host.json` (port, link
secret, name), `run.sh` and `host.log`. Workers' folders go in `~/Eaon/Workers`.

- **Linux**: Electron needs a display; with none it runs under `xvfb-run`.
  Missing libraries (and Xvfb) are installed with apt or dnf when the account
  can use sudo (passwordless, or with the password given for the SSH install).
  `--ozone-platform=headless` was tried and crashes Electron 43 when a window
  opens. Chromium's sandbox stays on; only where user namespaces are blocked
  (Ubuntu 24.04) does it fall back to `--no-sandbox`.
- **Service**: a system systemd unit when sudo works, else a user unit with
  linger, else `nohup` plus an `@reboot` cron entry; a LaunchAgent on macOS.
- **No browser**: if Electron can't open a window (`--smoke` fails), it runs
  the Node bundle with `ELECTRON_RUN_AS_NODE=1`; workers work without a browser
  and Settings says why.
- **Updates**: on every connect the desktop compares the host's build id with
  its own package and, if they differ, sends the package; the host runs the new
  `install.sh --update`, which swaps the app in and restarts the service. A host
  that doesn't come back within five minutes shows an error. Settings →
  Worker computer reinstalls it, keeping the link key and the workers there:
  over SSH for an SSH-linked host, or with a fresh one-line command for one
  linked with a command.
- **Firewall**: the installer opens the host's port in ufw or firewalld (and
  lets the app through the macOS firewall) when sudo works, and says which
  command to run when it doesn't. A port that never answers is reported as a
  likely firewall, with that command.

## The link

WebSocket on port 3268, path `/eaon-host/v1`. Both sides prove they hold the
32-byte secret with HMACs over fresh nonces from each side (so the desktop never
talks to an impostor, and a recorded handshake is useless), then every frame is
AES-256-GCM with a per-direction key from HKDF and a counter that must climb by
one. The secret is made by the desktop, kept in its key vault
(`worker-host:secret`) and reaches the host over SSH's stdin, or once inside the
one-line install command. Ten wrong secrets from one address in a minute and
that address is turned away; requests with an `Origin` are refused.

Calls: `hello`, `sync`, `tokens`, `ipc` (any `workers:*` channel, and the live-view
`agent-browser:*` channels for `worker:` targets only), `workers.import` /
`.export` / `.release` / `.resume`, `files.*` (only inside the workers'
folders, uploads and skills), `update.put` / `.apply`, `uninstall`. Events:
everything the workers service sends its window, plus `host:notify`, which the
desktop shows as its own notification, and `host:tokens` (below). `hello`
reports free memory and disk; Settings warns when the disk is nearly full.

## What moves, and what doesn't

Moving workers there takes `workers.json`, each thread, the group chats and
each worker's folder (up to 512 MB each; `node_modules`, `.git`, virtualenvs and
build folders stay behind), rewriting paths into the folder. The desktop keeps
a copy (`worker-host-backup.json`) and empties its own list. Bringing them
back reverses it, to the folders they came from. If the host is gone, they can
come back from that copy; the host is told to stop its copy when it next
connects.

Synced to the host: every key in the vault except the link secret and chat-app
bot tokens, provider settings, MCP servers you added, personal skills
(`~/.eaon/skills`), and model and agent settings (never the desktop's folders).
The vault goes over within seconds of a change, and every ten minutes anyway.

Sign-ins (ChatGPT, Copilot, Hugging Face, MCP servers' OAuth) hand out a new
refresh token each time they refresh, and the old one stops working, so the two
computers keep the newer copy, by its expiry: a sync never replaces a sign-in
the host refreshed since, the host sends one it refreshed to the desktop at once
(`host:tokens`), and after each sync the desktop takes any newer ones it missed
while asleep (`tokens`). Cached tokens are read again whenever the vault
changes.

Chat apps go with the workers: their links, bot tokens and WhatsApp sessions
move to the host (`channels.import`; a WhatsApp session is decrypted here and
sealed again with the host's own key), the bots stop here and answer from the
host, and Settings → Workers → Chat apps is answered by the host. The
tokens are the host's own from then on: a sync never sends or removes
`channel:` entries.
Moving the workers back brings the chat apps back the same way
(`channels.export`). Workers moved before chat apps could go with them take
theirs over the next time the host connects.

Not on the host (yet): agent email, the trading desk, and the phone remote
(pair the phone with the desktop; it sees no workers while they are on the
host). The Workers tab hides "Open its folder" while workers are on the host. While the host can't be reached, the
tab shows what it last saw: reading works, changes are refused with a message,
and for the first seconds after this app starts a change waits for the link.
