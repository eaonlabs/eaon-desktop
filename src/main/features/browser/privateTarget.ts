import { isPrivateHostname } from '../../netGuard'

/**
 * Whether a URL (or something typed like one: "localhost:3000",
 * "192.168.1.1/admin") points at this computer or the local network by its
 * spelling alone. A page the agent browses can ask for
 * `http://localhost:8080/admin` or the router's address; those services often
 * trust everything that reaches them, so the agent's browser asks the user
 * before going there. The rules themselves are `isPrivateHostname` in
 * `netGuard.ts`, shared with the web fetch tool.
 */
export function opensPrivateNetwork(url: unknown): boolean {
  let host: string
  try {
    let raw = String(url ?? '').trim()
    // Typed like an address, not a URL ("localhost:3000", "192.168.1.1/admin").
    if (raw && !/^[a-z][\w+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
    host = new URL(raw).hostname
  } catch {
    return false
  }
  return isPrivateHostname(host)
}
