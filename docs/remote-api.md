# Eaon Remote API (v1)

How Eaon on the iPhone (and anything else on the user's own network) controls
the Workers running in Eaon Desktop, and uses the Mac's models. The contract
between `src/main/remote/` (server) and `ios/Eaon/Agents/Remote/` (client).

It is **off by default**. The user turns it on in Settings → Remote devices;
that starts a server on all interfaces, and every request needs the key.

## Transport and safety

- HTTP/1.1 and JSON (UTF-8). Base `http://<address>:<port>`. Default port **3266**.
- `Authorization: Bearer <key>`, always: there is no keyless mode. The key is
  `eaonr-` + 24 random bytes, base64url (`settings.remote.token`), made on first
  use and replaced by "Reset key". Compared in constant time. Unlike the Local
  API Server's key (`eaon-…`) it never works there, and that one never works here.
- Any request that carries an `Origin` header is refused (403): this is for the
  app, not web pages. No CORS headers are ever sent.
- Wrong or missing key → 401. More than 10 failures from one address in a
  minute → 429 with `Retry-After` for the next minute.
- Request bodies are capped at 256 KB (413); `POST /v1/chat/completions` may carry
  8 MB (images). Unknown routes → 404.
- Errors are `{"error": {"code": "<snake_case>", "message": "<for a person>"}}`.
  Codes: `unauthorized`, `forbidden`, `rate_limited`, `not_found`,
  `invalid_request`, `too_large`, `conflict`, `server_error`.
- The server never sends file paths, the key, API keys, or other workers'
  private mail. A worker's folder is not exposed.
- Bonjour (macOS): `_eaon._tcp`, instance name `Eaon (<computer name>)`, TXT
  `v=1`, `host=<hostname>.local`, `port=<port>` (the client reads host and port
  from the TXT record, without resolving the endpoint). The key is never
  advertised.
- Pairing link (shown as a QR code and copyable):
  `eaon://pair?v=1&host=<host>&port=<port>&key=<key>&name=<computer name>`
  (values percent-encoded).

## Reading

### `GET /remote/v1/hello`
```json
{ "app": "Eaon", "apiVersion": 1, "appVersion": "2026.6.1", "name": "Alex's MacBook Pro",
  "workers": 3, "running": 1 }
```
Used by the phone to check the key and the version. `apiVersion` bumps only on
breaking changes; fields may be added.

### `GET /remote/v1/workers` → `{ "workers": [RemoteWorker] }`
### `GET /remote/v1/workers/:id` → `{ "worker": RemoteWorker }`

```ts
interface RemoteWorker {
  id: string
  name: string
  color: string                       // CSS hex, "#3E86C6"
  purpose: string
  personality: string
  status: 'idle' | 'working' | 'asleep' | 'paused' | 'failed'
  mood: WorkerMood                    // shared/workers.ts workerMood()
  activity: string                    // the worker's own one-line status
  paused: boolean
  access: 'autonomous' | 'safe' | 'read-only'
  model: { providerId: string; modelId: string; label: string } | null   // null follows the app's model
  goal: string                        // what it is working towards
  goalRun: { text: string; status: 'active' | 'achieved' | 'blocked' | 'paused'; turns: number; summary?: string } | null
  asks: RemoteAsk[]                   // questions waiting on the user, oldest first
  unread: number
  lastRunAt: number | null            // ms since epoch
  lastOutcome: { at: number; ok: boolean } | null
  lastError: string | null
  nextWakeAt: number | null           // soonest heartbeat, routine or goal continuation
  routines: { id: string; name: string; task: string; everyMs: number | null; daily: string | null; nextAt: number }[]
  runningMessageId: string | null     // the message streaming right now
  createdAt: number
}

interface RemoteAsk {
  id: string
  question: string
  options: string[]                   // quick answers
  approve: { tool: string; summary: string } | null   // a specific action it may not take alone
  at: number
}
```

### `GET /remote/v1/workers/:id/thread?limit=40&before=<messageId>`
```json
{ "messages": [RemoteMessage], "hasMore": true }
```
Main thread, oldest first. `limit` 1…100 (default 40). `before` returns the page
ending just before that message.

```ts
interface RemoteMessage {
  id: string
  role: 'user' | 'assistant'
  at: number
  from?: { name: string; color?: string }   // user turns that were mail: who wrote it ("You" is omitted)
  parts: RemotePart[]                       // in order; assistant turns interleave text and tool steps
  error?: string
  heartbeat?: string                        // an assistant turn woken by its own schedule: its note
  streaming: boolean                        // id === worker.runningMessageId
}
type RemotePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; title: string; detail?: string;
      status: 'running' | 'done' | 'denied' | 'error'; output?: string }
```
Reasoning parts are never sent. A user turn's `parts` is one text part: the
mail text (several pieces of mail joined by blank lines, each prefixed with
`Name: ` unless it is from the user; a piece of mail that is only files reads
`[1 file attached]`, never a path). `title` is a short phrase ("Ran a
command", "Read a file", "Searched the web"); `detail` is one line, at most 120
characters (the command, path, URL or query); `output` at most 800 characters.

### `GET /remote/v1/models`
```json
{ "models": [{ "id": "anthropic/claude-sonnet-5-5", "name": "claude-sonnet-5-5", "provider": "Anthropic" }],
  "default": "anthropic/claude-sonnet-5-5" }
```
What a worker can be pinned to (`gatewayModels()`); `default` is the app's
selected model, or null.

## Commands

All answer `{ "ok": true }` unless noted, or the error shape above.

| Request | Body | Effect |
|---|---|---|
| `POST /remote/v1/workers` | `RemoteDraft` | Creates a worker (the phone's "spin up an agent on the Mac"). → `201 { "worker": RemoteWorker }` |
| `PATCH /remote/v1/workers/:id` | partial `RemoteDraft` | Edits it. → `{ "worker": RemoteWorker }` |
| `DELETE /remote/v1/workers/:id` | none | Stops and forgets the worker (its folder stays on disk). |
| `POST /remote/v1/workers/:id/send` | `{ "text": string, "goal"?: boolean }` | Mail from the user (`engine.send`); `goal` makes it the worker's goal. `text` 1…8000 chars. |
| `POST /remote/v1/workers/:id/stop` | none | Aborts the running turn only. |
| `POST /remote/v1/workers/:id/wake` | none | Runs a check-in turn when it is free. |
| `POST /remote/v1/workers/:id/pause` | `{ "paused": boolean }` | Pause or resume. → `{ "worker": RemoteWorker }` |
| `POST /remote/v1/workers/:id/goal` | `{ "status": "active" \| "paused" \| null }` | Pause, resume or clear the goal run. |
| `POST /remote/v1/workers/:id/answer` | `{ "askId": string, "text"?: string, "approved"?: boolean }` | Answers a question, or approves/declines the one action it asked about. 404 if the ask is gone. |
| `POST /remote/v1/workers/:id/clear` | none | Empties the thread (mail, schedule and settings stay). |
| `POST /remote/v1/workers/:id/read` | none | Marks it read. |

```ts
interface RemoteDraft {
  name: string                        // 1…40
  color?: string                      // "#RRGGBB"; one of WORKER_COLORS if omitted
  purpose: string                     // 1…2000
  personality?: string                // 0…600 (the engine keeps 600; more is a 400)
  access?: 'autonomous' | 'safe' | 'read-only'   // default autonomous, as on the desktop
  model?: { providerId: string; modelId: string } | null
}
```
Validation errors are `400 invalid_request` with the engine's own message
(`engine.save` rejects with user-facing text). The 16-worker cap gives `409 conflict`.
Sending to a paused worker is allowed: the engine holds it, as in the app.

## Live updates: `GET /remote/v1/events` (Server-Sent Events)

`Content-Type: text/event-stream`. Each event is `event: <name>\ndata: <json>\n\n`.
On connect the server first sends `workers` with the full list. A `: ping`
comment goes out every 20 seconds. The client reconnects (and re-reads) when
the stream drops.

| event | data |
|---|---|
| `workers` | `{ "workers": [RemoteWorker] }`: on connect and whenever anything but a token changes |
| `message` | `{ "workerId": string, "message": RemoteMessage }`: a message was added or replaced whole (turn start, turn end) |
| `delta` | `{ "workerId": string, "messageId": string, "text": string }`: assistant text, batched about 16 ms |
| `tool` | `{ "workerId": string, "messageId": string, "part": RemotePart }`: a tool step started or finished; upsert by `part.id` |

## The Mac's models (same key)

So one pairing covers chat too, the server also answers, with the same
`Authorization` header and no extra routes beyond these two:

- `GET /v1/models` and `POST /v1/chat/completions`: the Local API Server's
  OpenAI-compatible endpoints (`gateway/openaiChat.ts`), streaming included.

## Settings

`settings.remote = { enabled: boolean; port: number; token: string | null }`
(defaults `false`, `3266`, `null`). The server starts at launch when `enabled`,
and on the Settings switch. IPC `remote:*` is for Settings → Remote devices:
status (running, port, error), addresses (non-internal IPv4 addresses and the
`.local` name), the key, the pairing link and its QR code, "Reset key" (which
disconnects every phone: open streams are closed), and a note that this is for
networks the user trusts, or a private network such as Tailscale, because the
traffic is plain HTTP.

## What the server really does (deviations and clarifications)

Where the server differs from, or settles something in, the text above. The
text above has been brought in line; this is the list for the client.

- **Personality** is 0…600 characters, not 1000: the engine keeps 600, and a
  longer one is a `400` rather than quietly cut.
- **Chat body cap.** `POST /v1/chat/completions` accepts up to 8 MB (a chat may
  carry images); every other request is capped at 256 KB. A body over its cap
  is read and thrown away (up to 4 MB) before the `413` is sent, so a client
  still writing sees the `413`, not a reset.
- **Paths.** The spec says both "never file paths" and that `detail` may be a
  path. Resolved like this: in everything the model wrote or a tool touched
  (text parts, `delta`s, `detail`, `output`, `error`, `activity`, asks, goal
  text), the worker's own folder is shown as `.` (so `/Users/me/Eaon/Workers/Nova/a.md`
  is `./a.md`) and the user's home directory as `~`. Even a path split across
  two `delta`s is caught. A path elsewhere (`/etc/hosts`) is shown as written:
  there is no way to know what is private. A worker's `folder`, inbox, notes,
  attachment and mail file paths, and the arguments of a tool call or an
  approval (`approve.input`) are never sent. A browser step's `detail` is the
  action and the page, never what was typed.
- **Turns with no mail.** A heartbeat, a routine, "wake" and a goal
  continuation open a turn with no message from anyone. There is no user
  message for it in the thread or in a `message` event; its note is the
  assistant message's `heartbeat` (an empty string when the note was empty),
  on the first `message` event and on the replacing one at the end.
- **`nextWakeAt`** is `null` for a paused worker (it will not wake), and a goal
  run only counts while it is `active`.
- **`hello.running`** is the number of workers with `status: "working"`.
- **Status codes the spec left open.** Duplicate worker name: `400` with the
  engine's message. `wake` on a paused worker and `goal` on a worker with no
  goal: `409 conflict` with the engine's message. A `before` that is not in the
  thread: `404`. `limit` that is not an integer in 1…100: `400`. A wrong method
  on a known path: `404` (there is no `405`). Anything unexpected: `500
  server_error` with a fixed message, never the inside of the error.
- **Answering.** A plain question needs `text`; a question with `approve` needs
  a boolean `approved` (`text` is then an optional note). Anything else is a
  `400`. A question already answered is `404`.
- **Rate limit.** Ten wrong keys from one address inside a minute, then every
  request from it, even with the right key, is `429` until the oldest of the
  ten is a minute old; `Retry-After` is the seconds left. Requests with an
  `Origin` are refused first and do not count.
- **Key.** Only `Authorization: Bearer <key>` counts, also on `/v1/*` (no
  `x-api-key`). `Authorization` is read per request, so Reset key takes effect
  at once.
- **Errors on `/v1/*`.** The server's own refusals (`401`, `403`, `404`, `413`)
  use the error shape above; what the gateway itself says (a bad chat body, a
  model that failed) keeps the OpenAI shape, `{"error": {"message", "type"}}`.
  `GET /v1/models` is the OpenAI list; `GET /remote/v1/models` is the app's own
  (`name` is the model's label, `provider` the provider's display name;
  `default` is null unless the selected model is one the gateway serves).
- **Events.** `tool-progress` (live output of a running command) is not
  forwarded; a `tool` event is sent when a step starts and when it ends.
  `workers` is not sent again when the list a phone sees is unchanged, and
  moods that fade with time (happy → neutral) only show on the next change or
  re-read. Text before a tool step is sent before it.
- **Reset key / turning off** closes every open connection: event streams and
  chat streams alike.
- **Pairing link host** is the Mac's first non-internal IPv4 address (home and
  office ranges before Tailscale's `100.x`), or `<hostname>.local` when there
  is none. The link and the Bonjour record both carry the port.
- **Settings page extras.** The page can also change the port (IPC
  `remote:set-port`, 1024–65535); the server and the Bonjour record move with
  it and phones need the new link.
