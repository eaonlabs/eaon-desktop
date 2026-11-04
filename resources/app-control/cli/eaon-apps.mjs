// eaon-apps: app control from an Eaon ADE terminal.
//
// Reads and operates desktop apps through their accessibility tree, for the
// coding agent (or person) in the terminal. This file only carries the
// arguments to Eaon, which parses and runs them (src/main/features/
// appControl), and prints the one JSON envelope it answers with:
// {"version": 1, "ok": true, "command": "...", "data": ...} or
// {"version": 1, "ok": false, "command": "...", "error": {"code", "message", "hint"}}.
// Exit status 0 when ok, 1 when not.
//
// Run by the launcher Eaon writes on the terminal's PATH, on Eaon's own Node
// (ELECTRON_RUN_AS_NODE). EAON_APPS_URL and EAON_APPS_KEY come from the
// terminal's environment.

const argv = process.argv.slice(2)
const command = argv[0] ?? 'guide'
const pretty = process.stdout.isTTY

function print(envelope) {
  if (pretty && envelope.ok && typeof envelope.data?.guide === 'string') {
    process.stdout.write(`${envelope.data.guide}\n`)
    return
  }
  process.stdout.write(`${pretty ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope)}\n`)
}

function fail(code, message, hint) {
  print({ version: 1, ok: false, command, error: { code, message, ...(hint ? { hint } : {}) } })
  process.exit(1)
}

const url = process.env.EAON_APPS_URL
const key = process.env.EAON_APPS_KEY
if (!url || !key) {
  fail('DISABLED', 'eaon-apps works in Eaon’s ADE terminals while coding agents may use app control.', 'Turn it on in Eaon → Settings → App control → Coding agents in the ADE, then open a new terminal.')
}

let response
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ argv })
  })
} catch {
  fail('ENGINE_UNAVAILABLE', 'Couldn’t reach Eaon. Is it still open?')
}
const body = await response.json().catch(() => null)
const envelope = body && typeof body === 'object' ? body.result : null
if (!envelope || typeof envelope !== 'object') {
  fail(response.status === 401 ? 'DISABLED' : 'INTERNAL', body?.error?.message ?? `Eaon answered with HTTP ${response.status}.`, response.status === 401 ? 'Open a new ADE terminal: this one has an old key.' : undefined)
}
print(envelope)
process.exit(envelope.ok ? 0 : 1)
