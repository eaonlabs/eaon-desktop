/**
 * Copies text and says whether it worked. The clipboard API refuses when the
 * window isn't focused (a copy button clicked while another app has focus,
 * a shortcut fired from a menu), and every "Copied" check drew itself
 * regardless. Callers show their check only on `true`, and a short error
 * otherwise (CLIPBOARD_FAILED).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Falls back to the older route, which works without the Clipboard API's focus rule.
  }
  try {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
    document.body.appendChild(field)
    field.select()
    const ok = document.execCommand('copy')
    field.remove()
    return ok
  } catch {
    return false
  }
}

export const CLIPBOARD_FAILED = "Couldn't copy. Click in the Eaon window and try again."
