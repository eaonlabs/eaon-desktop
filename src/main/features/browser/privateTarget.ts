import { BlockList, isIP } from 'node:net'

/**
 * Whether a URL points at this computer or the local network by its
 * spelling alone: loopback, a private or link-local range, `localhost`,
 * `.local`/`.internal`/`.lan` names, or a bare name with no dot. A page the
 * agent browses can ask for `http://localhost:8080/admin` or the router's
 * address; those services often trust everything that reaches them, so the
 * agent's browser asks the user before going there.
 *
 * TODO(merge): the security branch adds the same rules, with DNS resolution,
 * as `targetsPrivateNetwork` in src/main/netGuard.ts. Replace this file's
 * export with that import when the branches meet.
 */

const PRIVATE = new BlockList()
for (const [network, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  PRIVATE.addSubnet(network, bits, 'ipv4')
}
for (const [network, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  PRIVATE.addSubnet(network, bits, 'ipv6')
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|home\.arpa)$/

export function opensPrivateNetwork(url: unknown): boolean {
  let host: string
  try {
    let raw = String(url ?? '').trim()
    // Typed like an address, not a URL ("localhost:3000", "192.168.1.1/admin").
    if (raw && !/^[a-z][\w+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  } catch {
    return false
  }
  if (!host) return true
  const type = isIP(host)
  if (type) return PRIVATE.check(host, type === 4 ? 'ipv4' : 'ipv6')
  return LOCAL_NAME.test(host) || !host.includes('.')
}
