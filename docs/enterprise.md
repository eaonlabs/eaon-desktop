# Eaon for organizations

This guide is for IT and security teams deploying Eaon Desktop to managed computers. It covers:

- the **managed policy**, which locks settings and turns features off on every device;
- the **audit log**, a tamper-evident record of security-relevant activity;
- the **security model**, meaning what Eaon protects and how;
- how these features support a **SOC 2** program, and what stays your organization's job.

Eaon is a desktop app that runs on the user's computer, using the user's own model-provider keys. Prompts and responses go straight from the device to the providers you allow. They do not pass through Eaon servers, and Eaon sends no telemetry.

---

## 1. Managed policy

A policy is a JSON file (or, on macOS, a configuration profile) placed where only an administrator can write it. Eaon reads it once at launch, so changes take effect on the next restart. A device with no policy file behaves exactly like a personal install.

### Where the policy goes

| Platform | Location | Deploy with |
|---|---|---|
| macOS | `/Library/Managed Preferences/dev.eaon.desktop.plist` | An MDM configuration profile (Jamf, Kandji, Intune, Mosyle) for the preference domain `dev.eaon.desktop` |
| macOS | `/Library/Application Support/Eaon/policy.json` | A script or package, owned by `root`, mode `644` |
| Windows | `%ProgramData%\Eaon\policy.json` | Intune, GPO file deployment or SCCM. **Restrict the folder's ACL** so only Administrators and SYSTEM can write: `ProgramData` subfolders are writable by every user by default. |
| Linux | `/etc/eaon/policy.json` | Ansible, Puppet, Chef or a package, owned by `root`, mode `644` |

On macOS and Linux, Eaon reports a warning in **Settings → Security** and in the audit log when the policy file is owned by someone other than root or can be written by group/other. A policy that the user can edit is not a control.

**If the file can't be parsed, Eaon fails closed.** Remote access, the Local API Server, computer use, trading, payments, chat apps, browser control, Discord status and beta updates are turned off, and the agent is held to "Ask before every change", until the file is fixed. The error is shown in Settings → Security and written to the audit log as `policy.loaded` with outcome `failure`.

### Policy reference

Every field is optional. Anything you leave out stays under the user's control.

```json
{
  "organization": "Acme Corp",

  "features": {
    "remoteAccess": false,
    "localApiServer": false,
    "computerUse": false,
    "trading": false,
    "payments": false,
    "channels": false,
    "email": true,
    "browserUse": true,
    "plugins": true,
    "scheduler": true,
    "discordPresence": false,
    "betaUpdates": false,
    "starPrompt": false
  },

  "agent": {
    "maxApprovalMode": "auto",
    "allowFullDiskAccess": false,
    "allowBlanketMcpApproval": false
  },

  "providers": {
    "allow": ["anthropic", "openai", "azure", "amazon-bedrock", "eaon-local"],
    "deny": []
  },

  "localApi": {
    "requireKey": true
  },

  "mcp": {
    "allowCommands": ["npx", "uvx", "/opt/acme/mcp/approved-server"]
  },

  "audit": {
    "enabled": true,
    "directory": "/var/log/eaon",
    "retentionDays": 365,
    "includeToolInputs": false
  }
}
```

#### `organization`
Shown to users on the Security page, for example "Managed by Acme Corp". It is also used in messages such as "Trading is turned off by Acme Corp's policy."

#### `features`
Setting a feature to `false` turns it off. Features with their own background service (remote access, trading, payments, chat apps, email, scheduler, Discord status) are never started: there is no server, no schedule and no IPC handler. Their Settings pages are hidden.

| Key | What it turns off |
|---|---|
| `remoteAccess` | Phones on the network controlling Workers. This is the only listener that is not loopback-only. |
| `localApiServer` | The OpenAI/Anthropic-compatible server on `127.0.0.1`, and the control API that Eaon CLI uses. |
| `computerUse` | The agent operating the mouse, keyboard and screen. |
| `trading` | The Trading desk and broker connections. |
| `payments` | Agent purchases with a saved card. |
| `channels` | WhatsApp, Telegram, Discord and other chat apps that reach an agent. |
| `email` | The agent's mailbox. |
| `browserUse` | Browser control (Browser Use), which lets the agent use the user's own signed-in browser. |
| `plugins` | Plugins and MCP servers from the directory. |
| `scheduler` | Scheduled tasks that run unattended. |
| `discordPresence` | Showing Eaon activity as a Discord status. |
| `betaUpdates` | Beta update notifications. Stable updates are unaffected. |
| `starPrompt` | The "star Eaon on GitHub" prompt. |

#### `agent`
- `maxApprovalMode` is the most autonomy any agent may be given:
  - `ask`: every change is approved by the user.
  - `auto`: only risky changes are asked about.
  - `full`: only irreversible actions are asked about.

  It applies to chats, and to unattended agents (Workers, trading sessions): below `full`, an autonomous worker is held to "safe", where anything risky needs a person's approval. It also turns off "Allow full autonomy from phones".
- `allowFullDiskAccess: false` keeps the agent's file changes inside the work folder.
- `allowBlanketMcpApproval: false` stops users from pre-approving every plugin (MCP) tool call.

#### `providers`
Lists the model providers a user may use, by id. `deny` wins over `allow`. Providers that are not allowed disappear from the app, and no chat, worker, Local API request or embedding can reach them. Common ids:

- `anthropic`, `openai`, `azure`, `amazon-bedrock`, `gemini`, `openrouter`, `xai`, `ollama`
- `chatgpt`, `github-copilot` (subscription sign-ins)
- `eaon-local` (Eaon's own on-device models)

The full list is in `src/main/providers/catalog.ts`. Custom endpoints use the id shown in Settings → Model providers.

#### `localApi`
`requireKey: true` makes the Local API Server refuse requests that send no key. This applies to apps on the same computer as well as browser pages. Browser pages always need the key, whatever this setting says.

#### `mcp`
`allowCommands` lists the programs allowed to start as local (stdio) MCP servers. Each entry is a base name (`npx`) or a full path. A server whose command isn't on the list is refused, and the refusal is audited.

#### `audit`
See section 2.

### Example macOS configuration profile

Upload this to your MDM as a custom settings payload for the domain `dev.eaon.desktop`. The keys mirror the JSON above.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>organization</key><string>Acme Corp</string>
  <key>features</key>
  <dict>
    <key>remoteAccess</key><false/>
    <key>trading</key><false/>
    <key>payments</key><false/>
    <key>computerUse</key><false/>
  </dict>
  <key>agent</key>
  <dict>
    <key>maxApprovalMode</key><string>auto</string>
    <key>allowFullDiskAccess</key><false/>
    <key>allowBlanketMcpApproval</key><false/>
  </dict>
  <key>localApi</key>
  <dict>
    <key>requireKey</key><true/>
  </dict>
  <key>audit</key>
  <dict>
    <key>retentionDays</key><integer>365</integer>
  </dict>
</dict>
</plist>
```

### Checking a device
**Settings → Security** shows:
- whether the device is managed, and by whom;
- which features are off, and the other limits in force;
- any warnings about the policy file.

---

## 2. Audit log

Eaon writes an audit record for security-relevant events. It is on by default, on managed and unmanaged installs alike.

**Where:**
- By default, `<user data>/audit/audit-YYYY-MM-DD.jsonl`. User data is:
  - `~/Library/Application Support/Eaon` on macOS;
  - `%APPDATA%\Eaon` on Windows;
  - `~/.config/Eaon` on Linux.
- With `audit.directory` set, the log goes to that folder instead. Point your log shipper (Splunk Universal Forwarder, Elastic Agent, Datadog Agent, Fluent Bit) at it.

**Format:** one JSON object per line.

```json
{"ts":"2026-10-15T13:58:02.114Z","seq":6,"event":"settings.changed","outcome":"denied",
 "actor":{"user":"jdoe","host":"JDOE-MBP","via":"ui"},
 "app":{"version":"2026.6.1","platform":"darwin"},
 "details":{"settings":["approvalMode"],"approvalMode":"ask","refusedByPolicy":["approvalMode=full"]},
 "prev":"9f2c…","hash":"41ab…"}
```

| Field | Meaning |
|---|---|
| `seq` | Increases by one for every record. A gap means a record was removed. |
| `outcome` | `success`, `failure` (for example a wrong key) or `denied` (refused by policy, by the user, or by a guard). |
| `actor.via` | `ui`, `agent`, `agent:<unattended policy>`, `control-api`, `local-api`, `remote` or `system`. |
| `prev`, `hash` | SHA-256 hash chain. Editing, deleting or reordering any record breaks it. |

**Integrity:** Settings → Security → **Verify** recomputes the whole chain and reports the first record that doesn't match. Files are created with mode `0600` in a `0700` folder. Retention defaults to 365 days (`audit.retentionDays`, from 1 to 3650). Older daily files are deleted at launch.

**What is never recorded:** API keys, tokens, passwords, card data or message text. Details are redacted both by field name and by pattern (provider key formats, bearer tokens, JWTs, private keys, card-like numbers, OAuth query parameters) before they are written. Agent tool *inputs* (commands and arguments) are left out unless `audit.includeToolInputs` is `true`. Turn that on only if your log store is cleared for that content.

### Events

| Event | When |
|---|---|
| `app.started`, `app.stopped` | Launch and quit |
| `policy.loaded` | At launch: managed or not, source, problems, whether it failed closed |
| `feature.blocked` | A feature the policy turned off was not started |
| `settings.changed` | A security-relevant setting changed: approval mode, file access, MCP pre-approval, Local API, remote, computer use, background, updates. Shows the value in force, and `denied` with `refusedByPolicy` when the policy held the request back. |
| `credential.set`, `credential.cleared`, `credential.revealed`, `credential.fallbacks_set` | A provider key was saved, removed, shown or changed. Only the provider id is recorded. |
| `provider.changed` | A provider was enabled or disabled, or its endpoint changed |
| `mcp.server_added`, `mcp.server_changed`, `mcp.server_removed`, `mcp.server_blocked` | MCP server configuration changed, or a server was refused by `mcp.allowCommands` |
| `agent.tool` | An agent ran a tool that changes something (file write, command, message, order…), or any tool call was refused. Records the tool, outcome and chat id. |
| `local_server.start_requested`, `local_server.stop_requested`, `local_server.auth_failed` | The Local API Server started or stopped, or a request had a wrong or missing key |
| `control.tool`, `control.auth_failed` | The control API (Eaon CLI) changed something, or a request had the wrong key |
| `remote.request`, `remote.auth_failed`, `remote.refused` | A phone changed something, a wrong key was sent, or a request came from outside the local network |
| `ipc.refused` | Something other than Eaon's own page tried to call the app's internal API |
| `background.changed`, `update.install_requested` | Running in the background was turned on or off; an update was installed |
| `audit.verified` | Someone ran the integrity check, and its result |

---

## 3. Security model

### Data and credentials
- **Provider keys** are encrypted with the operating system's keychain (macOS Keychain, Windows DPAPI, libsecret on Linux) using Electron `safeStorage`. They never reach the app's renderer process, apart from an explicit "reveal" click, which is audited.
- The **control API key** (used only by Eaon CLI) is kept in the encrypted vault. It is separate from the model key that Connect Apps writes into other tools' configs.
- **App data** (settings, chats, vault, audit log) is written owner-only: `0600` files in `0700` folders.
- **No telemetry.** Native crash dumps are kept locally and never uploaded. The crash log is scrubbed of credentials.

### Process isolation
- The app's page runs in **Chromium's sandbox**, with context isolation and no Node.js access. It talks to the main process only through a fixed list of typed calls.
- The main process **only answers Eaon's own page**: a frame, a web page or anything loaded in its place is refused (`ipc.refused`).
- **Navigation guard:** an Eaon window can't be navigated away from Eaon. Links open in the user's browser, and only as `http`, `https` or `mailto`.
- **Content-Security-Policy:** no inline or remote scripts, no plugins, no `<base>` and no form posts.
- **Permissions:** web pages in the in-app or agent browsers get no microphone, camera, location, notifications or clipboard reads, and can't hand a URL scheme to the operating system. The app's own page can use the microphone (dictation) only.
- **In-app browser:** each tab is a sandboxed `<webview>` in its own session, separate from the app's.
- **Packaged builds** disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and verify the integrity of `app.asar` (Electron fuses). DevTools are not in the menu. macOS builds are signed with a Developer ID, notarized and use the hardened runtime.

### AI agents
- **Approvals are decided in the main process.** The default is to ask before every change. A command only skips approval when it is provably read-only: a fixed list of programs, no redirection, no substitution, and no environment variables that change behaviour.
- **File tools** refuse:
  - credential stores: `~/.ssh`, `~/.aws`, `~/.kube`, `~/.config/gcloud`, `~/.npmrc`, `~/.git-credentials`, Keychains, other AI tools' sign-ins, and others;
  - Eaon's own data, apart from attachments;
  - anything outside the home folder.

  Symlinks are resolved before these checks.
- **web_fetch** follows redirects one hop at a time, and refuses one that leads from a public site into the local network or to cloud metadata.
- **Guests** (people a user lets talk to a worker from a chat app) can't use the user's browsers, screen, mail, broker, connected plugins, card or local network. They can't leave anything behind for later turns, or hand work to other workers.
- **Irreversible actions** (real-money orders, destructive plugin calls, and typing a card into an app that can't be verified) always wait for the user, in every approval mode.

### Network
- **Local API Server:** off by default and loopback-only. It checks Host and Origin against DNS rebinding, requires the key from any browser origin, caps request bodies at 32 MB, and compares keys in constant time.
- **Remote devices:** off by default.
  - It only answers devices on the local network: private, link-local, loopback and CGNAT/Tailscale ranges.
  - It locks out an address after repeated wrong keys.
  - Phones can't grant full autonomy unless the user allows it.
  - Traffic is **plain HTTP on the LAN**. For managed fleets, either turn it off (`features.remoteAccess: false`) or allow it only over a private overlay network such as Tailscale.
- **TLS verification** is never disabled.

---

## 4. SOC 2 (AICPA Trust Services Criteria)

SOC 2 is an attestation, by an independent CPA firm, of **your organization's** controls over a period of time. No software product is "SOC 2 compliant" on its own. What Eaon provides is a set of technical controls your auditors can rely on, plus the evidence they produce. The table maps them to the 2017 Trust Services Criteria (revised points of focus, 2022).

| Criteria | What Eaon provides | Evidence |
|---|---|---|
| **CC6.1** Logical access: restricting access to information assets | Credentials encrypted by the OS keychain. Owner-only app data. Process sandbox and IPC sender validation. Agent file guards. Keys required on local and remote servers. | This document. Settings → Security. `ipc.refused` and `*.auth_failed` events. |
| **CC6.2 / CC6.3** Provisioning and removing access, least privilege | Policy locks features and the most agent autonomy. Provider allow-list. MCP command allow-list. Separate model and control keys. | Policy file under configuration management. `policy.loaded` and `feature.blocked` events. |
| **CC6.6** Protection from threats outside system boundaries | Loopback-only servers with DNS-rebinding and Origin checks. LAN-only remote access. SSRF guard on web_fetch. Permission handlers for web content. | Policy `features.remoteAccess`, `localApi.requireKey`. `remote.refused` events. |
| **CC6.7** Restricting transmission of data | Provider allow-list keeps prompts to approved vendors. TLS to providers is always verified. | `providers.allow` in policy. `provider.changed` events. |
| **CC6.8** Preventing unauthorized or malicious software | Signed and notarized macOS builds. Electron fuses and asar integrity. MCP command allow-list. Plugin allow/deny through `features.plugins`. Dependency audit (`npm audit --omit=dev` is clean). | Build configuration (`electron-builder.yml`). `mcp.server_blocked` events. |
| **CC7.2** Monitoring for anomalies and security events | Tamper-evident audit log, forwardable to your SIEM. | `audit.directory` set to a collected location. Settings → Security → Verify. |
| **CC7.3 / CC7.4** Evaluating and responding to security events | Records carry actor, host, channel, outcome and a sequence number for investigations. | Audit records. `audit.verified` events. |
| **CC8.1** Change management | Security-relevant setting changes are recorded with the value in force and refused attempts. The policy pins configuration across the fleet. | `settings.changed`, `mcp.server_*` and `provider.changed` events. |
| **C1.1 / C1.2** Confidentiality: identifying, protecting and disposing of confidential information | No telemetry. Data stays on the device and with approved providers. Redaction in logs. Retention limits on audit logs. | This document. `audit.retentionDays`. |
| **PI1** Processing integrity (where in scope) | Approval gates on agent actions. Irreversible actions always confirmed. Unattended runs held to policy. | `agent.tool` events with `denied` outcomes. |

### Your organization's responsibilities

These are outside any desktop app, and an auditor will look for them:

- **Policies and procedures:** information-security policy, acceptable use of AI tools, data classification (what may be sent to which provider), incident response, vendor management.
- **Vendor due diligence** for each model provider you allow (their SOC 2 report, DPA and data-retention terms), and for Eaon as a software vendor.
- **Endpoint controls:** MDM enrollment, full-disk encryption (FileVault, BitLocker), OS patching, screen lock, EDR/antivirus.
- **Identity:** SSO and MFA for the provider accounts whose keys users enter. Rotate those keys when people leave. Prefer organization-issued keys with spend limits over personal ones.
- **Log management:** ship the audit directory to your SIEM, alert on `*.auth_failed`, `ipc.refused`, `remote.refused` and policy failures, and keep logs for your retention period.
- **Configuration management:** keep the policy file in version control, review changes, and deploy through MDM.
- **Access reviews:** periodically review who has which features enabled, and which providers are in use.
- **Software updates:** deploy Eaon updates promptly. Windows and Linux builds are not yet code-signed (see below).

### Known limitations

- **Windows builds are not Authenticode-signed yet**, and Linux `.deb` updates are verified by checksum only. Distribute those builds through your own software-distribution channel, and pin versions until signing is in place.
- **Remote devices use plain HTTP** on the local network (see section 3). Turn the feature off, or restrict it to an encrypted overlay network.
- **The audit log is tamper-evident, not tamper-proof.** A local administrator, or malware running as the user, can delete the folder. That shows up as a gap in your SIEM, which is why forwarding matters.
- **The read-only command classifier is a heuristic.** For untrusted repositories, keep `maxApprovalMode` at `ask` or `auto`.
