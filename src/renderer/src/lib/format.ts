/** Shared formatting helpers for anything showing a Hugging Face repo or a byte size. */

export function repoName(repoId: string): string {
  return repoId.includes('/') ? repoId.slice(repoId.indexOf('/') + 1) : repoId
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

export function downloadPercent(p: { receivedBytes: number; totalBytes: number }): number {
  return Math.min(100, Math.round((p.receivedBytes / (p.totalBytes || 1)) * 100))
}
