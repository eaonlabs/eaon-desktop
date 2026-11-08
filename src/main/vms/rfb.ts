import type { Duplex } from 'node:stream'
import { vncResponse } from './des'

/**
 * A small VNC (RFB 3.8) client: how agents see a VM's screen and use its
 * mouse and keyboard. The person watching uses noVNC in the window; this is
 * the agent's own connection, on the computer that runs the VM, so a
 * screenshot crosses the link to the desktop once, as a PNG, rather than as
 * a stream of raw pixels.
 *
 * It asks for 32-bit pixels and only the plainest encodings (Raw and
 * CopyRect, plus being told when the screen changes size), which every
 * server speaks and which cost nothing over a local socket.
 *
 * It keeps its own copy of the screen current, the way VNC viewers do: one
 * request for changes is always outstanding, and each update brings the
 * next. Some servers (Apple's) answer only when something changed, even when
 * asked for the whole screen, so a screenshot is that copy, taken once
 * updates have settled, rather than a fresh request.
 */

class ByteReader {
  private chunks: Buffer[] = []
  private length = 0
  private waiting: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null
  private failure: Error | null = null

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.length += chunk.length
    this.serve()
  }

  fail(error: Error): void {
    this.failure ??= error
    if (this.waiting) {
      const { reject } = this.waiting
      this.waiting = null
      reject(error)
    }
  }

  read(n: number): Promise<Buffer> {
    if (this.length >= n) return Promise.resolve(this.take(n))
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiting = { n, resolve, reject }
    })
  }

  private serve(): void {
    if (this.waiting && this.length >= this.waiting.n) {
      const { n, resolve } = this.waiting
      this.waiting = null
      resolve(this.take(n))
    }
  }

  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0)
    let out: Buffer
    if (this.chunks[0].length >= n) {
      out = this.chunks[0].subarray(0, n)
      this.chunks[0] = this.chunks[0].subarray(n)
      if (this.chunks[0].length === 0) this.chunks.shift()
    } else {
      out = Buffer.alloc(n)
      let at = 0
      while (at < n) {
        const head = this.chunks[0]
        const used = Math.min(head.length, n - at)
        head.copy(out, at, 0, used)
        at += used
        if (used === head.length) this.chunks.shift()
        else this.chunks[0] = head.subarray(used)
      }
    }
    this.length -= n
    return out
  }
}

const ENC_RAW = 0
const ENC_COPYRECT = 1
const ENC_LASTRECT = -224
const ENC_DESKTOPSIZE = -223

export interface Screenshot {
  width: number
  height: number
  /** RGBA, row by row. */
  rgba: Buffer
}

export class RfbClient {
  width = 0
  height = 0
  name = ''
  private framebuffer = Buffer.alloc(0)
  private readonly reader = new ByteReader()
  /** Waiting for the first whole picture. */
  private readonly updateWaiters: Array<() => void> = []
  private framed = false
  private lastUpdate = 0
  private closed = false
  private closeReason: Error | null = null

  private constructor(private readonly socket: Duplex) {
    socket.on('data', (chunk: Buffer) => this.reader.push(chunk))
    const end = (error?: Error): void => {
      if (this.closed) return
      this.closed = true
      this.closeReason = error ?? new Error('The VM’s screen closed.')
      this.reader.fail(this.closeReason)
      for (const waiter of this.updateWaiters.splice(0)) waiter()
    }
    socket.on('close', () => end())
    socket.on('error', (error) => end(error))
  }

  /** Connects over `socket` (already open), logs in and starts reading. */
  static async connect(socket: Duplex, password: string | null, timeoutMs = 10_000): Promise<RfbClient> {
    const client = new RfbClient(socket)
    const timer = setTimeout(() => socket.destroy(new Error('The VM’s screen didn’t answer.')), timeoutMs)
    try {
      await client.handshake(password)
    } catch (error) {
      socket.destroy()
      throw error
    } finally {
      clearTimeout(timer)
    }
    void client.readLoop().catch((error: Error) => socket.destroy(error))
    return client
  }

  get isOpen(): boolean {
    return !this.closed
  }

  private send(bytes: Buffer): void {
    if (!this.closed) this.socket.write(bytes)
  }

  private async reason(): Promise<string> {
    const length = (await this.reader.read(4)).readUInt32BE(0)
    return (await this.reader.read(Math.min(length, 4096))).toString('utf8')
  }

  private async handshake(password: string | null): Promise<void> {
    const version = (await this.reader.read(12)).toString('latin1')
    const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(version)
    if (!match) throw new Error('That isn’t a VNC server.')
    const minor = Number(match[1]) > 3 ? 8 : Math.min(8, Number(match[2]))
    if (minor < 7) throw new Error('The VM’s screen speaks an older VNC than this supports.')
    this.send(Buffer.from(`RFB 003.00${minor}\n`, 'latin1'))

    const count = (await this.reader.read(1))[0]
    if (count === 0) throw new Error(`The VM’s screen refused the connection: ${await this.reason()}`)
    const types = [...(await this.reader.read(count))]
    const type = password !== null && types.includes(2) ? 2 : types.includes(1) ? 1 : types.includes(2) ? 2 : null
    if (type === null) throw new Error('The VM’s screen asks for a kind of login this doesn’t support.')
    this.send(Buffer.from([type]))
    if (type === 2) {
      const challenge = await this.reader.read(16)
      this.send(vncResponse(password ?? '', challenge))
    }
    if (type === 2 || minor >= 8) {
      const result = (await this.reader.read(4)).readUInt32BE(0)
      if (result !== 0) {
        const why = minor >= 8 ? await this.reason().catch(() => '') : ''
        throw new Error(`The VM’s screen didn’t accept the login${why ? `: ${why}` : '.'}`)
      }
    }

    // Shared, so the person watching and the agent can both be connected.
    this.send(Buffer.from([1]))
    const init = await this.reader.read(24)
    this.resize(init.readUInt16BE(0), init.readUInt16BE(2))
    const nameLength = init.readUInt32BE(20)
    this.name = (await this.reader.read(nameLength)).toString('utf8')

    // 32-bit little-endian pixels, red in the third byte: B, G, R, X in memory.
    const format = Buffer.alloc(20)
    format[0] = 0
    format[4] = 32
    format[5] = 24
    format[6] = 0
    format[7] = 1
    format.writeUInt16BE(255, 8)
    format.writeUInt16BE(255, 10)
    format.writeUInt16BE(255, 12)
    format[14] = 16
    format[15] = 8
    format[16] = 0
    this.send(format)

    const encodings = [ENC_COPYRECT, ENC_RAW, ENC_DESKTOPSIZE, ENC_LASTRECT]
    const setEncodings = Buffer.alloc(4 + encodings.length * 4)
    setEncodings[0] = 2
    setEncodings.writeUInt16BE(encodings.length, 2)
    encodings.forEach((encoding, i) => setEncodings.writeInt32BE(encoding, 4 + i * 4))
    this.send(setEncodings)
    this.requestUpdate(false)
  }

  private resize(width: number, height: number): void {
    const next = Buffer.alloc(width * height * 4)
    // Keep what overlaps, so a resize mid-update doesn't blank the picture.
    const w = Math.min(width, this.width)
    for (let y = 0; y < Math.min(height, this.height); y++) this.framebuffer.copy(next, y * width * 4, y * this.width * 4, y * this.width * 4 + w * 4)
    this.framebuffer = next
    this.width = width
    this.height = height
  }

  private async readLoop(): Promise<void> {
    while (!this.closed) {
      const type = (await this.reader.read(1))[0]
      switch (type) {
        case 0: {
          const update = await this.readUpdate()
          this.lastUpdate = Date.now()
          // A new screen size comes on its own, with no pixels: ask for the whole picture at that size.
          if (update.resized && !update.pixels) {
            this.requestUpdate(false)
            break
          }
          if (update.pixels && !this.framed) {
            this.framed = true
            for (const waiter of this.updateWaiters.splice(0)) waiter()
          }
          // And the next change, whenever it comes.
          this.requestUpdate(true)
          break
        }
        case 1: {
          const head = await this.reader.read(5)
          await this.reader.read(head.readUInt16BE(3) * 6)
          break
        }
        case 2:
          break
        case 3: {
          const head = await this.reader.read(7)
          await this.reader.read(head.readUInt32BE(3))
          break
        }
        default:
          throw new Error(`The VM’s screen sent message ${type}, which this doesn’t know.`)
      }
    }
  }

  private async readUpdate(): Promise<{ resized: boolean; pixels: boolean }> {
    const head = await this.reader.read(3)
    const rects = head.readUInt16BE(1)
    const seen = { resized: false, pixels: false }
    for (let i = 0; i < rects; i++) {
      const rect = await this.reader.read(12)
      const x = rect.readUInt16BE(0)
      const y = rect.readUInt16BE(2)
      const w = rect.readUInt16BE(4)
      const h = rect.readUInt16BE(6)
      const encoding = rect.readInt32BE(8)
      if (encoding === ENC_LASTRECT) return seen
      if (encoding === ENC_DESKTOPSIZE) {
        this.resize(w, h)
        seen.resized = true
        continue
      }
      seen.pixels = true
      if (encoding === ENC_RAW) {
        const pixels = await this.reader.read(w * h * 4)
        for (let row = 0; row < h; row++) {
          const ty = y + row
          if (ty >= this.height) break
          for (let col = 0; col < w; col++) {
            const tx = x + col
            if (tx >= this.width) break
            const from = (row * w + col) * 4
            const to = (ty * this.width + tx) * 4
            this.framebuffer[to] = pixels[from + 2]
            this.framebuffer[to + 1] = pixels[from + 1]
            this.framebuffer[to + 2] = pixels[from]
            this.framebuffer[to + 3] = 255
          }
        }
        continue
      }
      if (encoding === ENC_COPYRECT) {
        const source = await this.reader.read(4)
        const sx = source.readUInt16BE(0)
        const sy = source.readUInt16BE(2)
        const copy = Buffer.alloc(w * h * 4)
        for (let row = 0; row < h; row++) this.framebuffer.copy(copy, row * w * 4, ((sy + row) * this.width + sx) * 4, ((sy + row) * this.width + sx + w) * 4)
        for (let row = 0; row < h; row++) copy.copy(this.framebuffer, ((y + row) * this.width + x) * 4, row * w * 4, (row + 1) * w * 4)
        continue
      }
      throw new Error(`The VM’s screen used encoding ${encoding}, which wasn’t asked for.`)
    }
    return seen
  }

  private requestUpdate(incremental: boolean): void {
    const request = Buffer.alloc(10)
    request[0] = 3
    request[1] = incremental ? 1 : 0
    request.writeUInt16BE(this.width, 6)
    request.writeUInt16BE(this.height, 8)
    this.send(request)
  }

  /** The whole screen as it is now: once the first picture is in, and changes have stopped coming for a moment. */
  async screenshot(timeoutMs = 10_000): Promise<Screenshot> {
    if (this.closed) throw this.closeReason ?? new Error('The VM’s screen is closed.')
    if (!this.framed) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The VM’s screen didn’t send a picture in time.')), timeoutMs)
        this.updateWaiters.push(() => {
          clearTimeout(timer)
          if (this.closed) reject(this.closeReason ?? new Error('The VM’s screen closed.'))
          else resolve()
        })
      })
    }
    const until = Date.now() + 1000
    while (Date.now() - this.lastUpdate < 150 && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    if (this.closed) throw this.closeReason ?? new Error('The VM’s screen closed.')
    return { width: this.width, height: this.height, rgba: Buffer.from(this.framebuffer) }
  }

  /** Moves the pointer to (x, y) with these buttons held (1 left, 2 middle, 4 right, 8/16 wheel up/down). */
  pointer(x: number, y: number, buttons: number): void {
    const message = Buffer.alloc(6)
    message[0] = 5
    message[1] = buttons
    message.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2)
    message.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4)
    this.send(message)
  }

  key(keysym: number, down: boolean): void {
    const message = Buffer.alloc(8)
    message[0] = 4
    message[1] = down ? 1 : 0
    message.writeUInt32BE(keysym >>> 0, 4)
    this.send(message)
  }

  close(): void {
    this.socket.destroy()
  }
}
