import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  FileArchive,
  FileAudio,
  FileCode2,
  FileText,
  File as FileIcon,
  FolderOpen,
  LibraryBig,
  MessageSquare,
  Play
} from 'lucide-react'
import { useApp } from '../state/store'
import { TopBar } from './TopBar'
import { SearchField, Segmented } from './ui'
import { fileKind, fileName, fileUrl, formatBytes, type FileKind } from '../lib/files'
import type { LibraryFileStat } from '@shared/library'

/**
 * Everything the user has added to a chat — photos, videos, documents — in
 * one place, newest first. Built from the transcripts themselves (each user
 * message keeps its attachment paths), so there is no second index to keep
 * in sync; main only reports which files still exist.
 */

interface LibraryItem {
  path: string
  kind: FileKind
  chatId: string
  chatTitle: string
  at: number
}

type Filter = 'all' | 'media' | 'files'

export function LibraryPage(): JSX.Element {
  const { chats, openChat, newChat } = useApp(useShallow((s) => ({ chats: s.chats, openChat: s.openChat, newChat: s.newChat })))
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [stats, setStats] = useState<Record<string, LibraryFileStat>>({})

  // Newest mention of each file wins, so a photo sent twice appears once,
  // under the chat it was last used in.
  const items = useMemo(() => {
    const byPath = new Map<string, LibraryItem>()
    for (const chat of chats) {
      for (const message of chat.messages) {
        if (message.role !== 'user' || !message.attachments?.length) continue
        for (const path of message.attachments) {
          const known = byPath.get(path)
          if (known && known.at >= message.createdAt) continue
          byPath.set(path, { path, kind: fileKind(path), chatId: chat.id, chatTitle: chat.title, at: message.createdAt })
        }
      }
    }
    return [...byPath.values()].sort((a, b) => b.at - a.at)
  }, [chats])

  const pathsKey = items.map((i) => i.path).join('\n')
  useEffect(() => {
    if (!pathsKey) return
    let live = true
    void window.api.library.stat(pathsKey.split('\n')).then((list) => {
      if (live) setStats(Object.fromEntries(list.map((s) => [s.path, s])))
    })
    return () => {
      live = false
    }
  }, [pathsKey])

  const q = query.trim().toLowerCase()
  const shown = items.filter((item) => {
    const media = item.kind === 'image' || item.kind === 'video'
    if (filter === 'media' && !media) return false
    if (filter === 'files' && media) return false
    return !q || fileName(item.path).toLowerCase().includes(q) || item.chatTitle.toLowerCase().includes(q)
  })
  const groups = groupByDate(shown)
  const mediaCount = items.filter((i) => i.kind === 'image' || i.kind === 'video').length

  return (
    <div className="page">
      <TopBar variant="page__bar" />
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--wide library">
          <h1 className="page__title">Library</h1>
          <p className="page__subtitle">Photos, videos and files you have added to your chats.</p>

          {items.length === 0 ? (
            <div className="library-empty">
              <LibraryBig size={40} strokeWidth={1.3} />
              <h2>Nothing here yet</h2>
              <p>Attach something with the + button in a chat, or drop a file onto it. It will show up here.</p>
              <button className="btn btn--primary" onClick={() => newChat()}>
                Start a chat
              </button>
            </div>
          ) : (
            <>
              <div className="library__controls">
                <Segmented
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all', label: `All · ${items.length}` },
                    { value: 'media', label: `Photos & videos · ${mediaCount}` },
                    { value: 'files', label: `Files · ${items.length - mediaCount}` }
                  ]}
                />
                <div className="library__search">
                  <SearchField value={query} onChange={setQuery} placeholder="Search by name or chat" variant="sm" />
                </div>
              </div>

              {shown.length === 0 && <div className="library-none">Nothing matches “{query.trim()}”.</div>}

              {groups.map(([label, group]) => (
                <section key={label} className="library__group">
                  <h2 className="library__group-title">{label}</h2>
                  <div className="library__grid">
                    {group.map((item) => (
                      <LibraryCard key={item.path} item={item} stat={stats[item.path]} onOpenChat={() => openChat(item.chatId)} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function LibraryCard({ item, stat, onOpenChat }: { item: LibraryItem; stat?: LibraryFileStat; onOpenChat: () => void }): JSX.Element {
  const missing = stat ? !stat.exists : false
  const name = fileName(item.path)
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase().slice(0, 5) : 'FILE'
  const media = item.kind === 'image' || item.kind === 'video'

  return (
    <div className="library-card" data-missing={missing || undefined} data-kind={item.kind}>
      <button
        className="library-card__preview"
        onClick={() => (missing ? onOpenChat() : void window.api.library.open(item.path))}
        title={missing ? 'This file has moved or been deleted — open the chat instead' : `Open ${name}`}
      >
        {media && !missing ? (
          item.kind === 'image' ? (
            <img src={fileUrl(item.path)} alt={name} loading="lazy" />
          ) : (
            <>
              <video src={fileUrl(item.path)} preload="metadata" muted />
              <span className="library-card__play">
                <Play size={16} strokeWidth={0} fill="currentColor" />
              </span>
            </>
          )
        ) : (
          <span className="library-card__file">
            <KindIcon kind={item.kind} />
            <span className="library-card__ext">{missing ? 'Missing' : ext}</span>
          </span>
        )}
      </button>
      <div className="library-card__meta">
        <span className="library-card__name" title={item.path}>
          {name}
        </span>
        <span className="library-card__sub">
          {stat?.exists ? `${formatBytes(stat.size)} · ` : ''}
          {item.chatTitle}
        </span>
      </div>
      <div className="library-card__actions">
        <button className="icon-btn" onClick={onOpenChat} aria-label="Open chat" title={`Open “${item.chatTitle}”`}>
          <MessageSquare size={14} strokeWidth={1.9} />
        </button>
        {!missing && (
          <button className="icon-btn" onClick={() => void window.api.library.reveal(item.path)} aria-label="Show in folder" title="Show in folder">
            <FolderOpen size={14} strokeWidth={1.9} />
          </button>
        )}
      </div>
    </div>
  )
}

function KindIcon({ kind }: { kind: FileKind }): JSX.Element {
  const props = { size: 26, strokeWidth: 1.5 }
  if (kind === 'document') return <FileText {...props} />
  if (kind === 'code') return <FileCode2 {...props} />
  if (kind === 'archive') return <FileArchive {...props} />
  if (kind === 'audio') return <FileAudio {...props} />
  return <FileIcon {...props} />
}

/** Today / Yesterday / This week / This month / by month, newest first. */
function groupByDate(items: LibraryItem[]): [string, LibraryItem[]][] {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const label = (at: number): string => {
    if (at >= startOfDay) return 'Today'
    if (at >= startOfDay - day) return 'Yesterday'
    if (at >= startOfDay - 6 * day) return 'Previous 7 days'
    if (at >= startOfDay - 29 * day) return 'Previous 30 days'
    return new Date(at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }
  const groups: [string, LibraryItem[]][] = []
  for (const item of items) {
    const name = label(item.at)
    const last = groups[groups.length - 1]
    if (last && last[0] === name) last[1].push(item)
    else groups.push([name, [item]])
  }
  return groups
}
