import type { Feature } from './types'

/**
 * Browser control through the Eaon Chrome extension, which connects to a
 * loopback WebSocket this module serves. (Registration seam.)
 */
export const browserBridgeFeature: Feature = {
  id: 'browser-bridge',
  register: () => {}
}
