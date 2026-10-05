import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/**
 * Which addresses are "this computer or the local network" for the agent's
 * web tools. Reading a public page is research; reading a page on the
 * user's own machine or LAN (a dev server's admin route, the router, a
 * service bound to localhost because it trusts everything that reaches it)
 * is not, and a page the agent reads can try to send it there — by naming
 * the address, by redirecting to it, or by a DNS name that resolves to it.
 */

const PRIVATE = new BlockList()
for (const [network, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, Tailscale
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking, some VPNs
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, broadcast
] as const) {
  PRIVATE.addSubnet(network, bits, 'ipv4')
}
// IPv6: unspecified, loopback, unique-local, link-local, multicast. IPv4-mapped
// addresses (::ffff:127.0.0.1) are checked against the IPv4 rules by BlockList.
for (const [network, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  PRIVATE.addSubnet(network, bits, 'ipv6')
}

/** An IP address on this computer or a private network. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '')
  const type = isIP(ip)
  if (!type) return false
  return PRIVATE.check(ip, type === 4 ? 'ipv4' : 'ipv6')
}

/** Names that only mean something on this computer or the local network. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|home\.arpa)$/

/**
 * A hostname (as `URL.hostname` gives it) that is this computer or the local
 * network by its spelling alone: an address in a private range, `localhost`,
 * `.local`/`.internal`/`.lan` names, or a bare name with no dot, which only
 * resolves on the local network.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return true
  if (isIP(host)) return isPrivateAddress(host)
  return LOCAL_NAME.test(host) || !host.includes('.')
}

/** A URL whose host is this computer or the local network by its spelling. Not a URL at all reads as false. */
export function targetsPrivateNetwork(url: unknown): boolean {
  try {
    return isPrivateHostname(new URL(String(url ?? '').trim()).hostname)
  } catch {
    return false
  }
}

export type Resolver = (hostname: string) => Promise<string[]>

export const resolveAll: Resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address)

/**
 * The private address a public-looking hostname resolves to, or null. A
 * name that doesn't resolve is left to fail in the request itself.
 */
export async function privateAddressOf(hostname: string, resolve: Resolver = resolveAll): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return isPrivateAddress(host) ? host : null
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    return null
  }
  return addresses.find(isPrivateAddress) ?? null
}
