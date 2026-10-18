import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ChatToolPart } from '@shared/types'
import { useApp } from '../../state/store'
import { diffStats } from '../agent/FileDiff'
import type { FileChange } from '../agent/FilesChanged'
import { toolPartChanges } from '../agent/ToolCall'

/** A chat's edits, as the code panel's Changes pane and the composer's Changes pill count them. */
export interface ChatChanges {
  changes: FileChange[]
  /** Which assistant turn each change came from, 1-based, in `changes` order. */
  turns: number[]
  files: number
  added: number
  removed: number
}

/**
 * The open chat's edit and write calls, shallow-compared so the list keeps its
 * identity while unrelated tokens stream in and the diffs aren't recounted.
 */
function useEditParts(): { part: ChatToolPart; turn: number }[] {
  const parts = useApp(
    useShallow((s) => {
      const out: (ChatToolPart | number)[] = []
      let turn = 0
      for (const m of s.activeChat()?.messages ?? []) {
        if (m.role !== 'assistant') continue
        turn++
        for (const p of m.parts) if (p.type === 'tool' && (p.name === 'edit_file' || p.name === 'write_file')) out.push(p, turn)
      }
      return out
    })
  )
  return useMemo(() => {
    const pairs: { part: ChatToolPart; turn: number }[] = []
    for (let i = 0; i < parts.length; i += 2) pairs.push({ part: parts[i] as ChatToolPart, turn: parts[i + 1] as number })
    return pairs
  }, [parts])
}

export function useChatChanges(): ChatChanges {
  const pairs = useEditParts()
  return useMemo(() => {
    const changes: FileChange[] = []
    const turns: number[] = []
    for (const { part, turn } of pairs) {
      for (const change of toolPartChanges([part])) {
        changes.push(change)
        turns.push(turn)
      }
    }
    let added = 0
    let removed = 0
    for (const change of changes) {
      const stats = diffStats(change.before, change.after)
      added += stats.added
      removed += stats.removed
    }
    return { changes, turns, files: new Set(changes.map((c) => c.file)).size, added, removed }
  }, [pairs])
}
