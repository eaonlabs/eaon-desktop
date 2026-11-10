import type { ChatToolPart } from '@shared/types'
import type { FileChange } from '../../agent/FilesChanged'

/**
 * File changes from the calls that aren't Eaon's own edit_file and
 * write_file but say what they changed: a Codex patch (`apply_patch`, a
 * unified diff per file) and a Claude multi-edit (`edit_file` with a list of
 * edits). Kept free of React so the test harness can run it.
 */

/** A unified diff's hunks as edits: each hunk's old lines (context and removed) become its new ones. */
export function hunkChanges(file: string, diff: string): FileChange[] {
  const changes: FileChange[] = []
  let before: string[] | null = null
  let after: string[] = []
  const close = (): void => {
    if (before && (before.length || after.length)) changes.push({ file, before: before.map((l) => `${l}\n`).join(''), after: after.map((l) => `${l}\n`).join('') })
    before = null
    after = []
  }
  // A blank context line can come without its leading space; the diff's own last newline isn't one.
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('@@')) {
      close()
      before = []
      continue
    }
    // Lines before the first hunk are its file headers; "\ No newline at end of file" is a note, not a line.
    if (!before || line.startsWith('\\')) continue
    if (line.startsWith('-')) before.push(line.slice(1))
    else if (line.startsWith('+')) after.push(line.slice(1))
    else if (line.startsWith(' ') || line === '') {
      before.push(line.slice(1))
      after.push(line.slice(1))
    }
  }
  close()
  return changes
}

/** One file of a Codex patch: added (its text), deleted (what was there), or updated (a unified diff). */
interface PatchFile {
  path: string
  kind: string
  diff: string
}

const patchFiles = (input: Record<string, unknown>): PatchFile[] =>
  Array.isArray(input.changes)
    ? input.changes.flatMap((c: unknown) => {
        const change = c as Partial<PatchFile> | null
        return change && typeof change.path === 'string' && change.path ? [{ path: change.path, kind: typeof change.kind === 'string' ? change.kind : 'update', diff: typeof change.diff === 'string' ? change.diff : '' }] : []
      })
    : []

/** A file's whole text, from an add or delete that may come as a diff of only added or removed lines. */
function wholeText(diff: string, mark: '+' | '-'): string {
  if (!/^@@/m.test(diff)) return diff
  const lines = diff.split('\n').filter((l) => l.startsWith(mark) && !l.startsWith(`${mark}${mark}${mark} `))
  return lines.map((l) => `${l.slice(1)}\n`).join('')
}

/** What a finished `apply_patch` or multi-edit call changed; empty for any other call. */
export function patchChanges(part: ChatToolPart): FileChange[] {
  if (part.status !== 'done') return []
  if (part.name === 'apply_patch') {
    return patchFiles(part.input).flatMap((f): FileChange[] => {
      if (f.kind === 'add') return [{ file: f.path, before: '', after: wholeText(f.diff, '+'), write: true, created: true }]
      if (f.kind === 'delete') return [{ file: f.path, before: wholeText(f.diff, '-'), after: '', write: true }]
      return hunkChanges(f.path, f.diff)
    })
  }
  if (part.name === 'edit_file' && typeof part.input.path === 'string' && Array.isArray(part.input.edits)) {
    const file = part.input.path
    return part.input.edits.flatMap((e: unknown): FileChange[] => {
      const edit = e as { old_string?: unknown; new_string?: unknown; replace_all?: unknown } | null
      if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') return []
      return [{ file, before: edit.old_string, after: edit.new_string, ...(edit.replace_all === true ? { replaceAll: true } : {}) }]
    })
  }
  return []
}

/** Calls whose changes `patchChanges` reads. */
export const isPatchCall = (part: ChatToolPart): boolean => part.name === 'apply_patch' || (part.name === 'edit_file' && Array.isArray(part.input.edits))
