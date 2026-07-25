// The left rail: one nav list, top to bottom — New chat / New project /
// Search / Models / Settings (matching the Mac app's sidebar exactly, shortcut
// hints included), then conversations grouped by pinned → projects → date
// buckets. Nothing is pinned to the bottom edge, so a short history just
// leaves empty space below the list instead of stranding the nav rows apart
// from it. The row "⋯" menu is a custom popover (position: fixed so the
// scrolling list never clips it), with rename inline in the row itself.

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Boxes, Check, ChevronRight, Folder, FolderInput, FolderPlus, Loader2, MoreHorizontal,
  Pencil, Pin, PinOff, Search, Settings, SquarePen, Trash2,
} from "lucide-react";
import type { Conversation } from "../../core/types";
import { dateBucket, shortcutLabel } from "../../core/utils";
import { useConversations } from "../../state/conversations";
import { useGeneration } from "../../state/generation";
import { useUi } from "../../state/ui";
import Button from "../common/Button";
import Dialog from "../common/Dialog";
import "./sidebar.css";

const MENU_WIDTH = 180;
const MENU_HEIGHT = 148; // estimate for flip-up placement near the bottom edge

interface MenuState {
  id: string;
  x: number;
  y: number;
}

export default function Sidebar() {
  const conversations = useConversations((s) => s.conversations);
  const projects = useConversations((s) => s.projects);
  const currentId = useConversations((s) => s.currentId);
  const select = useConversations((s) => s.select);
  const newConversation = useConversations((s) => s.newConversation);
  const rename = useConversations((s) => s.rename);
  const remove = useConversations((s) => s.remove);
  const setPinned = useConversations((s) => s.setPinned);
  const setProject = useConversations((s) => s.setProject);
  const sessions = useGeneration((s) => s.sessions);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const selection = useUi((s) => s.selection);
  const setSelection = useUi((s) => s.setSelection);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const openSettings = useUi((s) => s.openSettings);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = () => {
    setMenu(null);
    setMoveOpen(false);
  };

  // Close the popover on any outside press, Esc, or list scroll.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const openChat = (id: string) => {
    select(id);
    setSelection({ kind: "chat" });
  };

  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>, id: string) => {
    e.stopPropagation();
    if (menu?.id === id) return closeMenu();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    const y =
      rect.bottom + MENU_HEIGHT > window.innerHeight - 8
        ? rect.top - MENU_HEIGHT - 4
        : rect.bottom + 4;
    setMoveOpen(false);
    setMenu({ id, x, y });
  };

  const commitRename = () => {
    if (renamingId) {
      const title = draft.trim();
      if (title) rename(renamingId, title);
    }
    setRenamingId(null);
  };

  // Grouping: pinned first; filed chats live under their project disclosure;
  // the rest bucket by recency. All groups sort newest-first.
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const projectIds = new Set(projects.map((p) => p.id));
  const pinned = sorted.filter((c) => c.isPinned);
  const filed = new Map<string, Conversation[]>();
  const buckets: Array<{ label: string; items: Conversation[] }> = [];
  for (const c of sorted) {
    if (c.isPinned) continue;
    if (c.projectId && projectIds.has(c.projectId)) {
      const list = filed.get(c.projectId) ?? [];
      list.push(c);
      filed.set(c.projectId, list);
    } else {
      const label = dateBucket(c.updatedAt);
      const last = buckets[buckets.length - 1];
      if (last && last.label === label) last.items.push(c);
      else buckets.push({ label, items: [c] });
    }
  }

  const renderRow = (c: Conversation) => {
    const active = selection.kind === "chat" && currentId === c.id;
    const streamingElsewhere = sessions[c.id]?.streaming === true && currentId !== c.id;
    return (
      <div
        key={c.id}
        role="button"
        tabIndex={0}
        className={active ? "convo-row active" : "convo-row"}
        onClick={() => openChat(c.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") openChat(c.id);
        }}
      >
        {renamingId === c.id ? (
          <input
            className="convo-rename"
            value={draft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setRenamingId(null);
            }}
          />
        ) : (
          <>
            <span className="convo-title">{c.title}</span>
            {streamingElsewhere && <Loader2 size={12} className="convo-spin" aria-label="Responding" />}
            {c.hasUnread && <span className="convo-unread" aria-label="Unread" />}
            <button
              className={menu?.id === c.id ? "convo-menu-btn open" : "convo-menu-btn"}
              onClick={(e) => openMenu(e, c.id)}
              aria-label="Chat options"
            >
              <MoreHorizontal size={14} />
            </button>
          </>
        )}
      </div>
    );
  };

  const menuTarget = menu ? conversations.find((c) => c.id === menu.id) : undefined;
  const deleteTarget = deleteId ? conversations.find((c) => c.id === deleteId) : undefined;

  // `inert` isn't in this TS lib's HTMLAttributes yet (DOM/React support it
  // regardless) — while closed, it drops the whole collapsed-but-still-
  // mounted sidebar out of focus and screen-reader reach, the same as the
  // old conditional-unmount did, so the width/opacity transition doesn't
  // introduce an invisible tab stop.
  const inertProps: { inert?: string } = sidebarOpen ? {} : { inert: "" };

  return (
    <aside
      className={sidebarOpen ? "sidebar" : "sidebar closed"}
      aria-hidden={!sidebarOpen}
      {...inertProps}
    >
      <nav className="sidebar-list" onScroll={() => menu && closeMenu()}>
        <section className="sidebar-section nav-section">
          <button
            className="convo-row nav-row"
            onClick={() => {
              newConversation();
              setSelection({ kind: "chat" });
            }}
          >
            <SquarePen size={15} className="row-icon" />
            <span className="convo-title">New chat</span>
            <span className="nav-shortcut">{shortcutLabel("N")}</span>
          </button>
          <button
            className={
              selection.kind === "projects" || selection.kind === "project"
                ? "convo-row nav-row active"
                : "convo-row nav-row"
            }
            onClick={() => setSelection({ kind: "projects" })}
          >
            <FolderPlus size={15} className="row-icon" />
            <span className="convo-title">New project</span>
            <span className="nav-shortcut">{shortcutLabel("P")}</span>
          </button>
          <button className="convo-row nav-row" onClick={() => setPaletteOpen(true)}>
            <Search size={15} className="row-icon" />
            <span className="convo-title">Search</span>
            <span className="nav-shortcut">{shortcutLabel("K")}</span>
          </button>
          <button
            className={selection.kind === "models" ? "convo-row nav-row active" : "convo-row nav-row"}
            onClick={() => setSelection({ kind: "models" })}
          >
            <Boxes size={15} className="row-icon" />
            <span className="convo-title">Models</span>
          </button>
          <button className="convo-row nav-row" onClick={() => openSettings()}>
            <Settings size={15} className="row-icon" />
            <span className="convo-title">Settings</span>
          </button>
        </section>

        {pinned.length > 0 && (
          <section className="sidebar-section">
            <div className="sidebar-label">
              <Pin size={11} />
              Pinned
            </div>
            {pinned.map(renderRow)}
          </section>
        )}

        {projects.length > 0 && (
          <section className="sidebar-section">
            <div className="sidebar-label">Projects</div>
            {projects.map((p) => {
              const open = openProjects[p.id] === true;
              const chats = filed.get(p.id) ?? [];
              return (
                <div key={p.id}>
                  <button
                    className="convo-row project-row"
                    aria-expanded={open}
                    onClick={() => setOpenProjects((s) => ({ ...s, [p.id]: !open }))}
                  >
                    <Folder size={14} className="row-icon" />
                    <span className="convo-title">{p.name}</span>
                    <ChevronRight size={14} className={open ? "project-chevron rot" : "project-chevron"} />
                  </button>
                  {open && (
                    <div className="project-chats">
                      {chats.length > 0 ? (
                        chats.map(renderRow)
                      ) : (
                        <div className="sidebar-hint">No chats yet</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {buckets.map((bucket) => (
          <section key={bucket.label} className="sidebar-section">
            <div className="sidebar-label">{bucket.label}</div>
            {bucket.items.map(renderRow)}
          </section>
        ))}
      </nav>

      {menu && menuTarget && (
        <div ref={menuRef} className="convo-menu" style={{ top: menu.y, left: menu.x }} role="menu">
          <button
            className="menu-item"
            onClick={() => {
              setRenamingId(menuTarget.id);
              setDraft(menuTarget.title);
              closeMenu();
            }}
          >
            <Pencil size={13} /> Rename
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setPinned(menuTarget.id, !menuTarget.isPinned);
              closeMenu();
            }}
          >
            {menuTarget.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
            {menuTarget.isPinned ? "Unpin" : "Pin"}
          </button>
          <div className="menu-sub-wrap">
            <button className="menu-item" onClick={() => setMoveOpen((o) => !o)}>
              <FolderInput size={13} /> Move to project
              <ChevronRight size={13} className="menu-chevron" />
            </button>
            {moveOpen && (
              <div className="convo-menu submenu">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    className="menu-item"
                    onClick={() => {
                      setProject(menuTarget.id, p.id);
                      closeMenu();
                    }}
                  >
                    <span className="menu-check">{menuTarget.projectId === p.id && <Check size={12} />}</span>
                    <span className="convo-title">{p.name}</span>
                  </button>
                ))}
                {projects.length === 0 && <div className="sidebar-hint">No projects yet</div>}
                <button
                  className="menu-item"
                  onClick={() => {
                    setProject(menuTarget.id, null);
                    closeMenu();
                  }}
                >
                  <span className="menu-check">{!menuTarget.projectId && <Check size={12} />}</span>
                  No project
                </button>
              </div>
            )}
          </div>
          <div className="menu-sep" />
          <button
            className="menu-item danger"
            onClick={() => {
              setDeleteId(menuTarget.id);
              closeMenu();
            }}
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}

      <Dialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title="Delete chat?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleteId) remove(deleteId);
                setDeleteId(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>“{deleteTarget?.title ?? "This chat"}” will be permanently removed from this device.</p>
      </Dialog>
    </aside>
  );
}
