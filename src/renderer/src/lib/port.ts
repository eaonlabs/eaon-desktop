/** Why a port typed into Settings → Local API Server can't be used, or null when it can. */
export function portProblem(draft: string): string | null {
  const text = draft.trim()
  if (!text) return 'Enter a port from 1024 to 65535.'
  const port = Number(text)
  if (!Number.isInteger(port)) return `“${text}” isn’t a port: use a whole number from 1024 to 65535.`
  if (port < 1024) return `Ports below 1024 need administrator rights. Use one from 1024 to 65535.`
  if (port > 65535) return `Ports only go up to 65535.`
  return null
}
