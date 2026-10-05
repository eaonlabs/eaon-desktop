/**
 * A minimal Chrome DevTools Protocol client over `ws` (already a dependency).
 *
 * The same protocol drives both ends of the app: a page's renderer (from the
 * `--remote-debugging-port` endpoint) and the main process (Node's inspector,
 * from `--inspect`). Every call has a timeout, so a page that stopped painting
 * or a process that died fails the test with a message instead of hanging it.
 */
import WebSocket from 'ws'
import { scaled } from './timing.mjs'

export class Cdp {
  /** @param {WebSocket} socket @param {string} label */
  constructor(socket, label) {
    this.label = label
    this.nextId = 1
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, method: string, timer: NodeJS.Timeout}>} */
    this.pending = new Map()
    /** @type {Map<string, Set<(params: any) => void>>} */
    this.listeners = new Map()
    this.closed = false
    /** Why the connection ended, for the error of whatever is sent next. */
    this.closedBecause = ''
    /**
     * Set for a page, whose connection is opened again when it dropped while
     * the window is still there. Returns the new socket or throws, saying why
     * the target is gone. The inspector of the main process has none: its
     * closing is the app's doing.
     * @type {(() => Promise<WebSocket>) | null}
     */
    this.reattach = null
    /** Called after a reattach, to enable the domains the page needs again. @type {(() => Promise<void>) | null} */
    this.afterReattach = null
    /** @type {Promise<void> | null} */
    this.reattaching = null
    this.reattached = 0
    this.bind(socket)
  }

  /** @param {WebSocket} socket */
  bind(socket) {
    this.socket = socket
    socket.on('message', (data) => {
      let message
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const call = this.pending.get(message.id)
        if (!call) return
        this.pending.delete(message.id)
        clearTimeout(call.timer)
        if (message.error) call.reject(new Error(`${this.label}: ${call.method} failed: ${message.error.message}`))
        else call.resolve(message.result)
        return
      }
      for (const handler of this.listeners.get(message.method) ?? []) handler(message.params)
    })
    let lastError = ''
    socket.on('error', (error) => {
      lastError = error.message
    })
    socket.on('close', (code, reason) => {
      if (socket !== this.socket) return
      this.dispose(`connection closed (code ${code}${reason?.length ? `, ${reason}` : ''}${lastError ? `, ${lastError}` : ''})`)
    })
  }

  /** @param {string} url @param {string} label */
  static connect(url, label, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      Cdp.open(url, label, timeout).then((socket) => resolve(new Cdp(socket, label)), reject)
    })
  }

  /** @param {string} url @param {string} label @returns {Promise<WebSocket>} */
  static open(url, label, timeout = 10_000) {
    timeout = scaled(timeout)
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error(`${label}: could not connect to ${url} within ${timeout} ms`))
      }, timeout)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`${label}: ${error.message}`))
      })
    })
  }

  /**
   * Opens the connection again if it dropped before this call was made (so
   * nothing was in flight) and the owner can say the window is still there.
   * Seen twice in sixty scenarios with the machine at a load average of 200:
   * the page's DevTools socket closed between two calls while the window
   * kept working.
   */
  async ensureOpen() {
    if (!this.closed || !this.reattach) return
    this.reattaching ??= (async () => {
      const reason = this.closedBecause
      const socket = await /** @type {() => Promise<WebSocket>} */ (this.reattach)()
      this.closed = false
      this.bind(socket)
      this.reattached += 1
      await this.afterReattach?.()
      this.lastReattach = reason
    })().finally(() => {
      this.reattaching = null
    })
    await this.reattaching
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ timeout?: number }} [options]
   * @returns {Promise<any>}
   */
  async send(method, params = {}, { timeout = 15_000 } = {}) {
    timeout = scaled(timeout)
    if (this.closed) await this.ensureOpen()
    if (this.closed) throw new Error(`${this.label}: ${method} after the ${this.closedBecause || 'connection closed'}`)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.label}: ${method} got no answer within ${timeout} ms`))
      }, timeout)
      this.pending.set(id, { resolve, reject, method, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** @param {string} event @param {(params: any) => void} handler */
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)?.add(handler)
    return () => this.listeners.get(event)?.delete(handler)
  }

  /** @param {string} reason */
  dispose(reason) {
    if (this.closed) return
    this.closed = true
    this.closedBecause = reason
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(new Error(`${this.label}: ${call.method} interrupted, ${reason}`))
    }
    this.pending.clear()
  }

  /** Ends the connection for good (the test is done with it). */
  close() {
    this.reattach = null
    this.dispose('connection closed by the test')
    try {
      this.socket.terminate()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Builds a `Runtime.evaluate` expression that calls `fn` with JSON arguments.
 * Functions run in another realm, so they must not close over test variables:
 * pass what they need as arguments.
 * @param {Function | string} fn
 * @param {unknown[]} args
 */
export function callExpression(fn, args) {
  if (typeof fn === 'string') return fn
  return `(${fn.toString()})(${args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ')})`
}

/**
 * Evaluates and returns the value, turning a thrown exception into an Error
 * that says what was thrown and where.
 * @param {Cdp} cdp
 * @param {string} expression
 * @param {{ timeout?: number, commandLineApi?: boolean }} [options]
 */
export async function evaluate(cdp, expression, { timeout = 15_000, commandLineApi = false, awaitPromise = true } = {}) {
  let result
  try {
    result = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, includeCommandLineAPI: commandLineApi, userGesture: true },
      { timeout }
    )
  } catch (error) {
    // Protocol-level failures ("Promise was collected", a timeout) don't say
    // what was being evaluated.
    throw new Error(`${error instanceof Error ? error.message : error}\n  in: ${expression.slice(0, 300)}`)
  }
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    const text = details.exception?.description ?? details.exception?.value ?? details.text
    throw new Error(`${cdp.label}: evaluation threw: ${text}\n  in: ${expression.slice(0, 300)}`)
  }
  return result.result?.value
}
