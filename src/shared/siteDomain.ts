/**
 * The registrable part of a host — the part one owner holds — for matching a
 * saved login or a sign-in to its website: "secure.chase.com" is chase.com,
 * "online.santander.co.uk" is santander.co.uk, and "someone.github.io" is
 * someone.github.io, not github.io, since everyone's site lives there.
 *
 * Not the whole public-suffix list: the country second levels and shared
 * hosts a login is likely to meet. An unknown one errs toward the longer,
 * narrower name.
 */

/** Hosts where each subdomain is someone else's site. */
const SHARED_HOSTS = new Set([
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'myshopify.com',
  'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'blogspot.com',
  'wordpress.com', 'tumblr.com', 'wixsite.com', 'glitch.me', 'onrender.com', 'fly.dev', 'replit.app', 'repl.co',
  'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'trycloudflare.com', 'surge.sh', 'neocities.org', 'notion.site', 'framer.app',
  's3.amazonaws.com', 'webflow.io', 'carrd.co', 'substack.com', 'hashnode.dev', 'deno.dev', 'railway.app', 'up.railway.app', 'stackblitz.io'
])

/** Second levels under a country's domain that are suffixes themselves: co.uk, com.au, ne.jp. */
const COUNTRY_SECOND = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ne', 'or', 'go', 'gob', 'gouv', 'nic', 'mil', 'ltd', 'plc', 'sch', 'nhs', 'gv', 'lg', 'ed', 'in', 'id', 'nom', 'info', 'biz'])

export function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  for (const take of [3, 2]) {
    if (parts.length > take && SHARED_HOSTS.has(parts.slice(-take).join('.'))) return parts.slice(-(take + 1)).join('.')
  }
  if (SHARED_HOSTS.has(parts.slice(-2).join('.'))) return parts.join('.')
  const [second, last] = parts.slice(-2)
  const countrySuffix = last.length === 2 && COUNTRY_SECOND.has(second)
  return parts.slice(countrySuffix ? -3 : -2).join('.')
}
