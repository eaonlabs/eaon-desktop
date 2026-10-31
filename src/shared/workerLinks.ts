/**
 * Links that open an app with everything filled in, for the user to confirm
 * with one tap: a Venmo payment to a person for an amount, a Cash App
 * payment, an Uber to an address, directions in Google Maps or Waze. No
 * account or key is needed, and nothing happens until the user taps —
 * which makes them the safe way for a worker to set up something that
 * moves money or sends a car.
 *
 * Formats: Venmo's payment links (venmo.com/<user>?txn=pay|charge&amount&note),
 * Cash App's ($cashtag/amount), Uber's universal link (m.uber.com/looking,
 * places as JSON), Lyft's ride link (needs coordinates), Google Maps URLs
 * (api=1) and Waze's (waze.com/ul).
 */

export interface LatLng {
  latitude: number
  longitude: number
}

const amountText = (amount: number): string => (Math.round(amount * 100) / 100).toFixed(2)

export function venmoLink(input: { to: string; amount: number; note?: string; request?: boolean }): string {
  const user = input.to.trim().replace(/^@/, '')
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(user)) throw new Error('A Venmo username has only letters, numbers, - and _ (like @sam-lee).')
  if (!(input.amount > 0) || input.amount > 5000) throw new Error('Give an amount between $0.01 and $5,000.')
  const params = new URLSearchParams({ txn: input.request ? 'charge' : 'pay', amount: amountText(input.amount) })
  if (input.note?.trim()) params.set('note', input.note.trim().slice(0, 280))
  return `https://venmo.com/${encodeURIComponent(user)}?${params.toString()}`
}

export function cashAppLink(input: { to: string; amount?: number }): string {
  const tag = input.to.trim().replace(/^\$/, '')
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(tag)) throw new Error('A $Cashtag starts with a letter and has up to 20 letters and numbers (like $samlee).')
  if (input.amount !== undefined && (!(input.amount > 0) || input.amount > 5000)) throw new Error('Give an amount between $0.01 and $5,000.')
  return `https://cash.app/$${encodeURIComponent(tag)}${input.amount ? `/${amountText(input.amount)}` : ''}`
}

/**
 * An Uber to `to` from where the user is (or `from`), as Uber's universal
 * link: m.uber.com/looking, with each place a JSON Location (latitude,
 * longitude, addressLine1). It opens the Uber app on a phone and Uber's own
 * booking page on a computer, the place filled in either way. The older
 * m.uber.com/ul/?action=setPickup link only works where the app is: on a Mac
 * it ends on uber.com's front page with the destination gone. Without
 * coordinates the place goes by its address alone; the pickup is left to
 * Uber (where the user is) unless `from` has coordinates.
 */
export function uberLink(input: { to: string; toAt?: LatLng | null; from?: string; fromAt?: LatLng | null }): string {
  const place = (address: string | undefined, at: LatLng | null | undefined): string =>
    JSON.stringify({ ...(at ? { latitude: at.latitude, longitude: at.longitude } : {}), ...(address?.trim() ? { addressLine1: address.trim() } : {}) })
  const parts: [string, string][] = []
  if (input.fromAt) parts.push(['pickup', place(input.from, input.fromAt)])
  parts.push(['drop[0]', place(input.to, input.toAt)])
  return `https://m.uber.com/looking?${parts.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
}

/** Lyft's ride link wants coordinates; without them it opens Lyft to choose the destination there. */
export function lyftLink(input: { toAt?: LatLng | null }): string {
  if (!input.toAt) return 'https://ride.lyft.com/'
  return `https://lyft.com/ride?id=lyft&destination[latitude]=${input.toAt.latitude}&destination[longitude]=${input.toAt.longitude}`
}

export function googleMapsLink(input: { to: string; from?: string; mode?: 'drive' | 'walk' | 'transit' | 'bike' }): string {
  const travel = { drive: 'driving', walk: 'walking', transit: 'transit', bike: 'bicycling' }[input.mode ?? 'drive']
  const origin = input.from?.trim() ? `&origin=${encodeURIComponent(input.from.trim())}` : ''
  return `https://www.google.com/maps/dir/?api=1${origin}&destination=${encodeURIComponent(input.to.trim())}&travelmode=${travel}`
}

export function wazeLink(input: { to: string; toAt?: LatLng | null }): string {
  return input.toAt ? `https://waze.com/ul?ll=${input.toAt.latitude},${input.toAt.longitude}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(input.to.trim())}&navigate=yes`
}
