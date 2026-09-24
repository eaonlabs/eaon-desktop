/*
 * The WebSocket to the Eaon desktop app.
 *
 * Message shapes mirror src/shared/browserBridge.ts in the app; keep PROTOCOL
 * in step with BRIDGE_PROTOCOL there.
 *
 * Keeping the service worker alive: since Chrome 116, WebSocket traffic
 * resets the worker's idle timer, so a ping every 20 s (under the 30 s
 * cutoff) keeps it running for as long as the app is connected. While
 * disconnected the worker is allowed to sleep; a 30 s alarm wakes it to try
 * again, so the connection comes back on its own once the app is started.
 */

import { emit, getLocal, setLocal } from './state.js'

const PROTOCOL = 1
const PING_MS = 20_000
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 25000]
const PAIR_TIMEOUT_MS = 10_000

export const connection = {
  /** 'unpaired' | 'connecting' | 'connected' | 'offline' | 'error' */
  status: 'connecting',
  /** Human-readable reason for the current status, if any. */
  message: '',
  appVersion: null
}

let socket = null
let attempt = 0
let retryTimer = null
let pingTimer = null
let pairing = null
/** Set when the app refused us for a reason retrying cannot fix. */
let halted = false
/** A connect() is between reading storage and creating its socket. */
let starting = false
let handlers = { onCall: () => {}, onCancel: () => {}, onConnected: () => {}, onDisconnected: () => {} }

export function setConnectionHandlers(next) {
  handlers = { ...handlers, ...next }
}

function setStatus(status, message = '') {
  connection.status = status
  connection.message = message
  emit()
}

export function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
    return true
  }
  return false
}

export function isConnected() {
  return connection.status === 'connected' && socket !== null && socket.readyState === WebSocket.OPEN
}

async function browserName() {
  try {
    if (navigator.brave && (await navigator.brave.isBrave())) return 'Brave'
  } catch {
    /* not Brave */
  }
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || []
  const order = ['Microsoft Edge', 'Opera', 'Vivaldi', 'Google Chrome', 'Chromium']
  for (const wanted of order) {
    const brand = brands.find((b) => b.brand === wanted)
    if (brand) return `${wanted.replace('Google ', '').replace('Microsoft ', '')} ${brand.version}`
  }
  const match = navigator.userAgent.match(/Chrome\/(\d+)/)
  return match ? `Chrome ${match[1]}` : 'Chromium browser'
}

/**
 * Opens the connection if it is not already open. With a pairing code the
 * current socket (if any) is replaced, since the code must be the first thing
 * the app hears on a fresh connection.
 */
export async function connect({ pairingCode } = {}) {
  // Startup, the alarm and onStartup can all ask at once; without this each
  // would pass the "already connecting?" check below before any socket exists.
  if (!pairingCode && starting) return
  starting = true
  try {
    await open(pairingCode)
  } finally {
    starting = false
  }
}

async function open(pairingCode) {
  const { token, port } = await getLocal()
  if (!pairingCode) {
    if (!token) {
      setStatus('unpaired')
      return
    }
    if (halted) return
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  }
  halted = false
  clearTimeout(retryTimer)
  closeSocket()
  // Retries while the app is closed stay "offline" rather than flickering
  // through "connecting" once a second in an open popup.
  if (pairingCode || connection.status !== 'offline') setStatus('connecting', pairingCode ? 'Pairing…' : '')

  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
  } catch (error) {
    setStatus(token ? 'offline' : 'unpaired', String(error && error.message ? error.message : error))
    scheduleRetry()
    return
  }
  socket = ws
  ws.onopen = async () => {
    const hello = {
      type: 'hello',
      protocol: PROTOCOL,
      extensionVersion: chrome.runtime.getManifest().version,
      browser: await browserName()
    }
    if (pairingCode) hello.pairingCode = pairingCode
    else hello.token = token
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(hello))
  }
  ws.onmessage = (event) => onMessage(ws, event)
  ws.onclose = (event) => onClose(ws, event)
  ws.onerror = () => {
    /* onclose follows with the details */
  }
}

async function onMessage(ws, event) {
  if (ws !== socket) return
  let message
  try {
    message = JSON.parse(event.data)
  } catch {
    return
  }
  switch (message.type) {
    case 'welcome':
      if (message.token) await setLocal({ token: message.token })
      attempt = 0
      connection.appVersion = message.appVersion || null
      setStatus('connected')
      startPing()
      settlePairing({ ok: true })
      handlers.onConnected()
      return
    case 'rejected':
      await onRejected(message)
      return
    case 'call':
      handlers.onCall(message)
      return
    case 'cancel':
      handlers.onCancel(message.id)
      return
    default:
      return
  }
}

async function onRejected(message) {
  const text = message.message || 'The Eaon app refused the connection.'
  switch (message.reason) {
    case 'bad-token':
    case 'unpaired':
      // The app no longer knows this token; retrying with it can never work.
      await setLocal({ token: null })
      halted = true
      setStatus('unpaired', text)
      break
    case 'bad-code':
      settlePairing({ ok: false, error: text })
      break
    case 'protocol':
      halted = true
      setStatus('error', text)
      break
    case 'replaced':
      // Another connection from this extension won; let it be.
      halted = true
      setStatus('offline', text)
      setTimeout(() => {
        halted = false
      }, 60_000)
      break
    default:
      break
  }
  settlePairing({ ok: false, error: text })
}

function onClose(ws) {
  if (ws !== socket) return
  socket = null
  stopPing()
  const wasConnected = connection.status === 'connected'
  settlePairing({ ok: false, error: 'Could not reach the Eaon app. Make sure it is running and Browser extension is turned on in its Settings.' })
  handlers.onDisconnected()
  if (halted) return
  getLocal().then(({ token }) => {
    if (!token) {
      setStatus('unpaired')
      return
    }
    if (wasConnected) attempt = 0
    setStatus('offline', 'The Eaon app is not running, or Browser extension is turned off in its Settings.')
    scheduleRetry()
  })
}

function scheduleRetry() {
  clearTimeout(retryTimer)
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
  attempt++
  retryTimer = setTimeout(() => connect(), delay)
}

function startPing() {
  stopPing()
  pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS)
}

function stopPing() {
  clearInterval(pingTimer)
  pingTimer = null
}

function closeSocket() {
  if (!socket) return
  const old = socket
  socket = null
  stopPing()
  try {
    old.close()
  } catch {
    /* already closed */
  }
}

function settlePairing(result) {
  if (!pairing) return
  const { resolve, timer } = pairing
  pairing = null
  clearTimeout(timer)
  resolve(result)
}

/** Exchanges a pairing code for a token. Resolves `{ ok }` or `{ ok: false, error }`. */
export async function pair(code, port) {
  const cleaned = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (cleaned.length !== 6) return { ok: false, error: 'Pairing codes are 6 letters and numbers, like K7Q-M4P.' }
  if (port) await setLocal({ port })
  settlePairing({ ok: false, error: 'Superseded by a new pairing attempt.' })
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => settlePairing({ ok: false, error: 'The Eaon app did not answer. Is it running?' }), PAIR_TIMEOUT_MS)
    pairing = { resolve, timer }
  })
  await connect({ pairingCode: cleaned })
  const outcome = await result
  // A failed code leaves the previous pairing (if any) in place; reconnect with it.
  if (!outcome.ok) connect()
  return outcome
}

/** Forgets the token here, and tells the app to forget it too if it is listening. */
export async function unpair() {
  halted = true
  clearTimeout(retryTimer)
  send({ type: 'unpair' })
  closeSocket()
  await setLocal({ token: null })
  setStatus('unpaired')
  halted = false
}

/** Called by the wake-up alarm and on browser start: reconnect if we should be connected. */
export function ensureConnected() {
  if (connection.status === 'connected' || (socket && socket.readyState === WebSocket.CONNECTING)) return
  attempt = Math.min(attempt, 2)
  connect()
}

/** "Retry now" from the popup: forget the backoff and any temporary halt. */
export function retryNow() {
  halted = false
  attempt = 0
  connect()
}
