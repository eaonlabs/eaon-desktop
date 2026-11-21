import type { Session } from 'electron'
import { siteVerdict, type SiteRules } from '@shared/workerLimits'

/**
 * A worker's allowed and blocked sites (shared/workerLimits.ts), enforced
 * where its browser's traffic leaves: Electron's `webRequest`, which sees
 * every request of the browser's session. A link the page offers, a redirect,
 * an address typed by the user taking over, a frame, an image: all of them
 * pass here, so a rule holds however the page got there.
 *
 * The listener is on only while the worker has rules. A listener makes every
 * request wait on the main process, and most workers have none.
 */

/** Resource types that are a page going somewhere, as opposed to what a page loads. */
const NAVIGATIONS = new Set(['mainFrame', 'subFrame'])

const WEB_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']

export class SiteGuard {
  private on = false

  /** `rulesOf` is read on every request, so editing a worker's sites applies to a browser that is already open. */
  constructor(
    private readonly session: Pick<Session, 'webRequest'>,
    private readonly rulesOf: () => SiteRules | null | undefined
  ) {}

  /** Puts the listener on while there are rules, and takes it off when there are none. */
  sync(): void {
    const rules = Boolean(this.rulesOf())
    if (rules && !this.on) {
      this.session.webRequest.onBeforeRequest({ urls: WEB_URLS }, (details, callback) => {
        const verdict = siteVerdict(this.rulesOf(), details.url, { navigation: NAVIGATIONS.has(details.resourceType) })
        callback(verdict.allowed ? {} : { cancel: true })
      })
      this.on = true
    } else if (!rules && this.on) {
      this.session.webRequest.onBeforeRequest(null)
      this.on = false
    }
  }

  get active(): boolean {
    return this.on
  }
}
