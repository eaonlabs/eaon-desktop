/**
 * Turning errors into something a person can act on. The raw text still
 * matters (it is what a bug report needs), so callers show the plain sentence
 * and keep the original behind a "Details" disclosure.
 */

/** An IPC rejection's own message, without Electron's "Error invoking remote method 'x': Error:" wrapper. */
export const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '')

export interface ExplainedError {
  /** One sentence: what happened and what to do. */
  message: string
  /** Offer the releases page as the way out (a manual download). */
  offerDownload: boolean
}

/**
 * What an electron-updater failure means for the user. Its messages are
 * written for developers ("Cannot find latest-mac.yml in the latest release
 * artifacts (https://…): HttpError: 404 …" followed by the response headers),
 * so the common causes are named here and anything else gets a generic line
 * with the original kept as detail.
 */
export function explainUpdateError(raw: string): ExplainedError {
  const text = raw.toLowerCase()
  if (/err_internet_disconnected|err_name_not_resolved|enotfound|eai_again|err_network_changed|err_address_unreachable/.test(text)) {
    return { message: "Couldn't reach GitHub to check for updates. Check your internet connection and try again.", offerDownload: false }
  }
  if (/etimedout|err_timed_out|err_connection_timed_out|econnreset|err_connection_reset|err_connection_closed|socket hang up/.test(text)) {
    return { message: 'The connection to GitHub dropped while checking for updates. Try again in a minute.', offerDownload: false }
  }
  if (/rate limit|httperror: 403|status(?: code)? 403/.test(text)) {
    return { message: 'GitHub is limiting update checks from this network right now. Try again in an hour, or download the update yourself.', offerDownload: true }
  }
  if (/cannot find latest[\w.-]*\.yml|latest[\w.-]*\.yml.*404|no published versions|unable to find latest version/.test(text)) {
    return { message: "The newest release doesn't have an update for this system yet. Try again later, or download it from the releases page.", offerDownload: true }
  }
  if (/read-only volume|translocat/.test(text)) {
    return { message: 'Eaon is running from a disk image or a read-only folder, so it can’t update itself. Move it to Applications and open it from there.', offerDownload: false }
  }
  if (/code signature|did not pass validation|could not get code signature|signature verification/.test(text)) {
    return { message: "The downloaded update couldn't be verified, so it wasn't installed. Download the latest version from the releases page instead.", offerDownload: true }
  }
  if (/sha512 checksum mismatch|checksum mismatch/.test(text)) {
    return { message: 'The update download was damaged on the way, so it wasn’t installed. Check for updates again to retry it.', offerDownload: false }
  }
  if (/enospc|no space left/.test(text)) {
    return { message: 'There isn’t enough disk space to download the update. Free some space and try again.', offerDownload: false }
  }
  if (/development builds/.test(text)) {
    return { message: 'This is a development build, which doesn’t update itself. Build or download a release to get updates.', offerDownload: true }
  }
  return { message: "Eaon couldn't finish updating. Try again, or download the latest version from the releases page.", offerDownload: true }
}
