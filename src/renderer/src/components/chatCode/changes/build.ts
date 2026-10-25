import type { ChatMessage, ChatToolPart } from '@shared/types'
import type { ReviewFile } from '@shared/adeReview'
import { blocksFromHunks, diffLines, splitLines, toBlocks, unwindEdits, type DiffBlock, type DiffFileModel, type DiffRow, type EditStep } from '../diff/model'

/**
 * The Changes pane's files, kept free of React so the test harness can run
 * it: the agent's edits in a chat, and each file's diff for a scope — the
 * whole chat, one turn, or what git says is uncommitted.
 */

export type ReviewScope = { kind: 'chat' } | { kind: 'turn'; turn: number } | { kind: 'git' }

export const sameScope = (a: ReviewScope, b: ReviewScope): boolean => a.kind === b.kind && (a.kind !== 'turn' || (b.kind === 'turn' && a.turn === b.turn))

/** One file edit the agent made, and the turn it made it in (1-based, counting the chat's replies). */
export interface AgentEdit extends EditStep {
  path: string
  turn: number
}

/** A finished edit or write call as an edit; null for any other call, or one that didn't finish. */
export function partEdit(part: ChatToolPart, turn: number): AgentEdit | null {
  if (part.status !== 'done' || typeof part.input.path !== 'string') return null
  const path = part.input.path
  if (part.name === 'edit_file' && typeof part.input.old_text === 'string' && typeof part.input.new_text === 'string')
    return { path, turn, kind: 'edit', before: part.input.old_text, after: part.input.new_text, replaceAll: part.input.replace_all === true }
  if (part.name === 'write_file' && typeof part.input.content === 'string') return { path, turn, kind: 'write', before: '', after: part.input.content }
  return null
}

/** Every finished edit and write in a chat, in the order they ran. */
export function collectEdits(messages: ChatMessage[]): AgentEdit[] {
  const edits: AgentEdit[] = []
  let turn = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    turn++
    for (const part of message.parts) {
      const edit = part.type === 'tool' ? partEdit(part, turn) : null
      if (edit) edits.push(edit)
    }
  }
  return edits
}

/** A path the agent gave, relative to the chat's folder when it is inside it. */
export function relativePath(root: string | null, path: string): string {
  const clean = path.replace(/^\.[\\/]/, '')
  if (!root) return clean
  const base = root.replace(/[\\/]+$/, '')
  if (clean === base) return ''
  for (const sep of ['/', '\\']) if (clean.startsWith(base + sep)) return clean.slice(base.length + 1)
  return clean
}

/** The turns that changed files, oldest first. */
export const editTurns = (edits: AgentEdit[]): number[] => [...new Set(edits.map((e) => e.turn))].sort((a, b) => a - b)

const counts = (blocks: DiffBlock[]): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const block of blocks)
    if (block.type === 'rows')
      for (const row of block.rows) {
        if (row.kind === 'add') added++
        else if (row.kind === 'del') removed++
      }
  return { added, removed }
}

/**
 * Each edit on its own, for a file whose history can't be worked back from
 * what is on disk now: an edit's lines carry no numbers (where it landed in
 * the file isn't known), a write's are the file's own.
 */
function snippetBlocks(steps: EditStep[]): DiffBlock[] {
  const blocks: DiffBlock[] = []
  steps.forEach((step, i) => {
    const rows = diffLines(splitLines(step.before), splitLines(step.after))
    const shown: DiffRow[] = step.kind === 'write' ? rows : rows.map((r) => ({ ...r, old: null, cur: null }))
    if (i > 0) blocks.push({ type: 'break' })
    blocks.push(...toBlocks(shown).map((b) => (b.type === 'gap' ? ({ type: 'rows', rows: b.rows ?? [] } as DiffBlock) : b)))
  })
  return blocks
}

/**
 * The agent's changes in a scope, a file each, from the edits and each
 * file's text on disk now (null when it can't be read). A file's diff is from
 * how it was before the scope's first edit to how it was after its last, with
 * real line numbers, when the edits can be undone back to there; otherwise
 * each edit is shown on its own. A file the scope left as it found it is left
 * out.
 */
export function agentFiles(edits: AgentEdit[], root: string | null, disk: Map<string, string | null>, scope: ReviewScope): DiffFileModel[] {
  const byPath = new Map<string, AgentEdit[]>()
  for (const edit of edits) {
    const path = relativePath(root, edit.path)
    const list = byPath.get(path)
    if (list) list.push(edit)
    else byPath.set(path, [edit])
  }
  const files: DiffFileModel[] = []
  for (const [path, steps] of byPath) {
    const inScope = steps.map((s, i) => (scope.kind === 'turn' ? (s.turn === scope.turn ? i : -1) : i)).filter((i) => i >= 0)
    if (inScope.length === 0) continue
    const first = inScope[0]
    const last = inScope[inScope.length - 1]
    const now = disk.get(path)
    const states = typeof now === 'string' ? unwindEdits(now, steps) : null
    const before = states?.[first] ?? null
    const after = states?.[last + 1] ?? null
    let blocks: DiffBlock[]
    let status: DiffFileModel['status'] = 'modified'
    if (before !== null && after !== null) {
      if (before === after) continue
      blocks = toBlocks(diffLines(splitLines(before), splitLines(after)))
      if (before === '') status = 'added'
    } else {
      blocks = snippetBlocks(inScope.map((i) => steps[i]))
      if (first === 0 && steps[0].kind === 'write') status = 'added'
    }
    files.push({ key: `agent:${path}`, path, status, ...counts(blocks), blocks })
  }
  return files.sort((a, b) => comparePaths(a.path, b.path))
}

/** A file from git's diff, its folds opening from the file's lines on disk when they were read. */
export function gitFile(file: ReviewFile, newText: string | null): DiffFileModel {
  return {
    key: `git:${file.path}`,
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    blocks: blocksFromHunks(file.hunks, newText === null ? null : splitLines(newText))
  }
}

let collator: Intl.Collator | null = null
/** Paths in the order a person sorts them: numbers by value, case aside. */
export function comparePaths(a: string, b: string): number {
  collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return collator.compare(a, b)
}

/** A diff as a patch, for the clipboard: what `git diff` would print for these files. */
export function toPatch(files: DiffFileModel[]): string {
  const out: string[] = []
  for (const file of files) {
    const from = file.status === 'added' ? '/dev/null' : `a/${file.oldPath ?? file.path}`
    const to = file.status === 'deleted' ? '/dev/null' : `b/${file.path}`
    out.push(`diff --git a/${file.oldPath ?? file.path} b/${file.path}`, `--- ${from}`, `+++ ${to}`)
    for (const block of file.blocks) {
      if (block.type !== 'rows' || block.rows.length === 0) continue
      const oldStart = block.rows.find((r) => r.old !== null)?.old ?? 0
      const curStart = block.rows.find((r) => r.cur !== null)?.cur ?? 0
      const oldCount = block.rows.filter((r) => r.kind !== 'add').length
      const curCount = block.rows.filter((r) => r.kind !== 'del').length
      out.push(`@@ -${oldStart},${oldCount} +${curStart},${curCount} @@`)
      for (const row of block.rows) out.push(`${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`)
    }
  }
  return out.join('\n') + '\n'
}

/** A folder or file in a tree of changed files, with the lines its files added and removed. */
export interface FileTreeNode<T> {
  name: string
  path: string
  file?: T
  children: FileTreeNode<T>[]
  added: number
  removed: number
}

/**
 * Changed files as folders and files: a folder holding only one folder is one
 * row ("src/components"), folders come before files, and each folder counts
 * its files' lines.
 */
export function fileTree<T extends { path: string; added: number; removed: number }>(files: T[]): FileTreeNode<T>[] {
  const root: FileTreeNode<T> = { name: '', path: '', children: [], added: 0, removed: 0 }
  for (const file of files) {
    const parts = file.path.split(/[\\/]/).filter(Boolean)
    let node = root
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1
      const path = parts.slice(0, i + 1).join('/')
      let child = node.children.find((c) => c.name === part && Boolean(c.file) === leaf)
      if (!child) {
        child = { name: part, path, children: [], added: 0, removed: 0, ...(leaf ? { file } : {}) }
        node.children.push(child)
      }
      child.added += file.added
      child.removed += file.removed
      node = child
    })
  }
  const order = (a: FileTreeNode<T>, b: FileTreeNode<T>): number => Number(Boolean(a.file)) - Number(Boolean(b.file)) || comparePaths(a.name, b.name)
  const squash = (node: FileTreeNode<T>): FileTreeNode<T> => {
    let n = node
    while (!n.file && n.children.length === 1 && !n.children[0].file) n = { ...n.children[0], name: `${n.name}/${n.children[0].name}` }
    return { ...n, children: n.children.map(squash).sort(order) }
  }
  return root.children.map(squash).sort(order)
}
