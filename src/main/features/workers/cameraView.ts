import { protocol } from 'electron'
import type { Connectors } from './connectors'

/**
 * `eaon-camera://`: a Home Assistant camera on a worker's camera card (labs),
 * fetched here with the connection's token so the page never holds it.
 *
 *   eaon-camera://still/camera.front_door   its picture now (camera_proxy)
 *   eaon-camera://live/camera.front_door    its live view, as Home Assistant
 *                                           streams it (camera_proxy_stream:
 *                                           MJPEG, which an <img> plays)
 *
 * A Ring doorbell in Home Assistant is a camera like any other. One that
 * can't stream answers `live` with an error, and the card falls back to a
 * fresh picture every couple of seconds. The stream ends when the card stops
 * showing it: the page's request is cancelled, and Home Assistant's with it.
 */
export const CAMERA_SCHEME = 'eaon-camera'
const ENTITY = /^camera\.[a-z0-9_]+$/
/** A live view this long ends by itself; Watch live starts it again. */
export const LIVE_MAX_MS = 5 * 60_000

export function cameraRequest(connectors: Connectors, url: string, signal?: AbortSignal, http: typeof fetch = fetch): Promise<Response> | Response {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const view = parsed.host
  const entity = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  if ((view !== 'live' && view !== 'still') || !ENTITY.test(entity)) return new Response('Not found', { status: 404 })
  // Workers on a worker computer keep their connections there: there is nothing here to ask.
  if (!connectors.connected('home-assistant')) return new Response('Home Assistant isn’t connected on this computer.', { status: 409 })
  const { url: base, headers } = connectors.ha.base()
  const path = view === 'live' ? `/api/camera_proxy_stream/${entity}` : `/api/camera_proxy/${entity}`
  // Ours to end: the page going away cancels the body below, which ends Home Assistant's
  // stream too. Electron doesn't pass the page's cancel on through `signal`, so this is
  // what does; a live view also ends by itself after LIVE_MAX_MS, should nothing else.
  const upstream = new AbortController()
  signal?.addEventListener('abort', () => upstream.abort(), { once: true })
  const cap = view === 'live' ? setTimeout(() => upstream.abort(), LIVE_MAX_MS) : null
  cap?.unref?.()
  const done = (): void => {
    if (cap) clearTimeout(cap)
    upstream.abort()
  }
  return http(`${base}${path}`, { headers, signal: upstream.signal })
    .then((reply) => {
      const headersOut = { 'content-type': reply.headers.get('content-type') ?? 'image/jpeg', 'cache-control': 'no-store' }
      if (!reply.ok || !reply.body) {
        done()
        return new Response(null, { status: reply.ok ? 502 : reply.status, headers: headersOut })
      }
      const reader = reply.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done: ended, value } = await reader.read()
            if (ended) {
              done()
              controller.close()
            } else controller.enqueue(value)
          } catch {
            done()
            controller.close()
          }
        },
        cancel() {
          done()
          void reader.cancel().catch(() => undefined)
        }
      })
      return new Response(body, { status: 200, headers: headersOut })
    })
    .catch(() => {
      done()
      return new Response('Couldn’t reach Home Assistant.', { status: 502 })
    })
}

/** Serves the scheme (once a run: a worker computer handing the workers back registers the IPC again). */
export function serveCameras(connectors: Connectors): void {
  // Not in the tests' stand-in for Electron, nor in the worker computer's Node runtime.
  if (typeof protocol?.handle !== 'function' || typeof protocol.isProtocolHandled !== 'function') return
  if (protocol.isProtocolHandled(CAMERA_SCHEME)) protocol.unhandle(CAMERA_SCHEME)
  protocol.handle(CAMERA_SCHEME, (request) => cameraRequest(connectors, request.url, request.signal))
}
