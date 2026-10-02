import { createServer, type IncomingMessage, type Server } from 'node:http'

/**
 * Notices the Swift-era "Eaon Browser Control" extension.
 *
 * Before this app, Eaon was a Swift app whose browser bridge was plain HTTP:
 * its extension long-polls http://127.0.0.1:8823 (then 8824–8827) for
 * `/health`, `/poll` and `/result`. It has the same name as today's extension
 * and version 1.0.0 too, but it can never talk to this app's WebSocket — so a
 * user who still has it installed sees an extension that "is outdated and
 * won't connect", with nothing on the app's side saying why.
 *
 * This listens where the old extension looks first and records when it was
 * last heard from, so Settings can say exactly what to remove and what to
 * install instead. It answers 410 Gone and does nothing else.
 */

/** The first port the old extension polls; it tries it before every other. */
export const LEGACY_PORT = 8823
/** It polls every few seconds while it can't connect; a minute of silence means it is gone. */
const SEEN_FOR_MS = 60_000

const GONE = JSON.stringify({
  error: 'This Eaon extension is out of date. Remove it and install the new one from Eaon → Settings → Browser extension.'
})

/**
 * Only the old extension's own requests count. It sends its pairing token in
 * `x-eaon-token` from an extension context; a web page setting that header
 * would be a cross-origin request with an Origin of its own (and a CORS
 * preflight first), so pages cannot make the warning appear.
 */
function fromLegacyExtension(req: IncomingMessage): boolean {
  if (req.headers['x-eaon-token'] === undefined) return false
  const origin = req.headers.origin
  return origin === undefined || /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
}

export class LegacyExtensionDetector {
  private server: Server | null = null
  private lastSeenAt = 0
  private expiry: NodeJS.Timeout | null = null

  constructor(
    private readonly onChange: () => void,
    private readonly port = LEGACY_PORT
  ) {}

  /** When the old extension was last heard from, if within the last minute. */
  get seenAt(): number | null {
    return this.lastSeenAt && Date.now() - this.lastSeenAt < SEEN_FOR_MS ? this.lastSeenAt : null
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => {
      if (fromLegacyExtension(req)) this.heard()
      res.writeHead(fromLegacyExtension(req) ? 410 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(fromLegacyExtension(req) ? GONE : '{}')
    })
    // Another app on the port is fine: this is a courtesy, not a feature.
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(this.port, '127.0.0.1', () => resolve(true))
    })
    if (!listening) return
    server.on('error', () => undefined)
    this.server = server
  }

  async stop(): Promise<void> {
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (this.lastSeenAt) {
      this.lastSeenAt = 0
      this.onChange()
    }
  }

  private heard(): void {
    const wasSeen = this.seenAt !== null
    this.lastSeenAt = Date.now()
    if (this.expiry) clearTimeout(this.expiry)
    // Tell Settings once it has gone quiet, e.g. after the user removed it.
    this.expiry = setTimeout(() => {
      this.expiry = null
      this.onChange()
    }, SEEN_FOR_MS + 100)
    this.expiry.unref()
    if (!wasSeen) this.onChange()
  }
}
