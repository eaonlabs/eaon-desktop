import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ChatToolPart } from '@shared/types'
import { codeFolder, useApp } from '../../state/store'
import { changeCounts, relativePath } from '../chatCode/changes/build'
import { useChatDiskChanges } from '../chatCode/diskChanges'
import type { FileChange } from '../agent/FilesChanged'
import { toolPartChanges } from '../agent/ToolCall'

/** A chat's edits, as the code panel's Changes pane and the composer's Changes pill count them. */
export interface ChatChanges {
  /** The edit calls' changes, from the replies the checkpoints don't cover. */
  changes: FileChange[]
  /** Which assistant turn each change came from, 1-based, in `changes` order. */
  turns: number[]
  files: number
  added: number
  removed: number
}

/** Calls that say what they changed. Anything else (a shell command) is seen only by the checkpoints. */
const isEditCall = (p: ChatToolPart): boolean => p.name === 'edit_file' || p.name === 'write_file' || p.name === 'apply_patch'

/**
 * The open chat's edit and write calls, shallow-compared so the list keeps its
 * identity while unrelated tokens stream in and the diffs aren't recounted.
 */
function useEditParts(): { part: ChatToolPart; turn: number; reply: string }[] {
  const parts = useApp(
    useShallow((s) => {
      const out: (ChatToolPart | number | string)[] = []
      let turn = 0
      for (const m of s.activeChat()?.messages ?? []) {
        if (m.role !== 'assistant') continue
        turn++
        // A reply whose changes were undone no longer counts; Redo brings it back.
        if (m.undone) continue
        for (const p of m.parts) if (p.type === 'tool' && isEditCall(p)) out.push(p, turn, m.id)
      }
      return out
    })
  )
  return useMemo(() => {
    const triples: { part: ChatToolPart; turn: number; reply: string }[] = []
    for (let i = 0; i < parts.length; i += 3) triples.push({ part: parts[i] as ChatToolPart, turn: parts[i + 1] as number, reply: parts[i + 2] as string })
    return triples
  }, [parts])
}

/**
 * What the chat changed: by the checkpoints for the replies that have them,
 * which see every change however it was made (a patch, a shell command, a
 * script), and by the edit calls for the rest.
 */
export function useChatChanges(): ChatChanges {
  const triples = useEditParts()
  const disk = useChatDiskChanges()
  const folder = useApp(codeFolder)
  return useMemo(() => {
    const covered = new Set(disk?.covered ?? [])
    const changes: FileChange[] = []
    const turns: number[] = []
    for (const { part, turn, reply } of triples) {
      if (covered.has(reply)) continue
      for (const change of toolPartChanges([part])) {
        changes.push(change)
        turns.push(turn)
      }
    }
    // Each file counted once, however many times it was written.
    const byFile = new Map<string, FileChange[]>()
    for (const change of changes) {
      const path = relativePath(folder, change.file)
      byFile.set(path, [...(byFile.get(path) ?? []), change])
    }
    let added = 0
    let removed = 0
    for (const list of byFile.values()) {
      const stats = changeCounts(list)
      added += stats.added
      removed += stats.removed
    }
    const files = new Set(byFile.keys())
    for (const file of disk?.files ?? []) {
      files.add(relativePath(folder, file.path))
      added += file.added
      removed += file.removed
    }
    return { changes, turns, files: files.size, added, removed }
  }, [triples, disk, folder])
}
