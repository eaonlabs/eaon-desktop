// Ctrl+K command palette: one arrow-key list mixing chats (subsequence
// fuzzy match on title, recent first), commands (incl. every settings page),
// model switching, and theme changes. Empty query = recents + core commands.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Boxes, MessageSquare, PanelLeft, Search, Settings2, SquarePen, SunMoon,
} from "lucide-react";
import type { ThemeChoice } from "../../core/types";
import { dateBucket } from "../../core/utils";
import { useConversations } from "../../state/conversations";
import { useModels } from "../../state/models";
import { useSettings } from "../../state/settings";
import { EAON_PROVIDER_ID, useUi, type SettingsPage } from "../../state/ui";
import "./palette.css";

/** True when every char of `query` appears in order somewhere in `text`. */
function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  if (!q) return true;
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

const SETTINGS_PAGES: Array<{ page: SettingsPage; label: string }> = [
  { page: "general", label: "General" },
  { page: "appearance", label: "Appearance" },
  { page: "shortcuts", label: "Shortcuts" },
  { page: "instructions", label: "Custom Instructions" },
  { page: "params", label: "Model Parameters" },
  { page: "memory", label: "Memory" },
  { page: "skills", label: "Skills" },
  { page: "provider", label: "Eaon API" },
  { page: "local", label: "Local Models" },
  { page: "plugins", label: "Plugins" },
  { page: "images", label: "Image Generation" },
  { page: "server", label: "Local Server" },
  { page: "network", label: "Network" },
  { page: "privacy", label: "Privacy" },
  { page: "statistics", label: "Statistics" },
  { page: "hardware", label: "Hardware" },
];

const THEMES: ThemeChoice[] = ["Dark", "Light", "System"];

interface Row {
  id: string;
  icon: ReactNode;
  label: string;
  kind: string;
  run: () => void;
}

export default function SearchPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const close = () => setPaletteOpen(false);
  const ui = useUi.getState();
  const convos = useConversations.getState();
  const trimmed = query.trim();
  const rows: Row[] = [];

  // Chats — recent first, cap 8.
  const matchingChats = [...convos.conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((c) => fuzzyMatch(trimmed, c.title))
    .slice(0, 8);
  for (const c of matchingChats) {
    rows.push({
      id: `chat:${c.id}`,
      icon: <MessageSquare size={15} />,
      label: c.title,
      kind: dateBucket(c.updatedAt),
      run: () => {
        convos.select(c.id);
        ui.setSelection({ kind: "chat" });
      },
    });
  }

  // Commands.
  const commands: Array<{ id: string; icon: ReactNode; label: string; run: () => void }> = [
    {
      id: "cmd:new",
      icon: <SquarePen size={15} />,
      label: "New chat",
      run: () => {
        convos.newConversation();
        ui.setSelection({ kind: "chat" });
      },
    },
    {
      id: "cmd:sidebar",
      icon: <PanelLeft size={15} />,
      label: "Toggle sidebar",
      run: () => ui.toggleSidebar(),
    },
    { id: "cmd:settings", icon: <Settings2 size={15} />, label: "Open Settings", run: () => ui.openSettings() },
  ];
  if (trimmed) {
    for (const { page, label } of SETTINGS_PAGES) {
      commands.push({
        id: `cmd:settings:${page}`,
        icon: <Settings2 size={15} />,
        label: `Settings · ${label}`,
        run: () => ui.openSettings(page, page === "provider" ? EAON_PROVIDER_ID : undefined),
      });
    }
  }
  for (const cmd of commands) {
    if (fuzzyMatch(trimmed, cmd.label)) rows.push({ ...cmd, kind: "Command" });
  }

  // Model switching — only worth listing against a query, cap 6.
  if (trimmed) {
    const models = useModels.getState();
    const matches = models
      .entries()
      .filter((e) => fuzzyMatch(trimmed, e.display))
      .slice(0, 6);
    for (const entry of matches) {
      rows.push({
        id: `model:${entry.key}`,
        icon: <Boxes size={15} />,
        label: `Switch model → ${entry.display}`,
        kind: "Model",
        run: () => models.setSelected(entry.key),
      });
    }
    for (const theme of THEMES) {
      const label = `Theme: ${theme}`;
      if (!fuzzyMatch(trimmed, label)) continue;
      rows.push({
        id: `theme:${theme}`,
        icon: <SunMoon size={15} />,
        label,
        kind: "Appearance",
        run: () => useSettings.getState().update({ theme }),
      });
    }
  }

  const highlighted = Math.min(index, Math.max(0, rows.length - 1));
  const runRow = (row: Row) => {
    row.run();
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(rows.length ? (highlighted + 1) % rows.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(rows.length ? (highlighted - 1 + rows.length) % rows.length : 0);
    } else if (e.key === "Enter") {
      const row = rows[highlighted];
      if (row) runRow(row);
    } else if (e.key === "Escape") {
      close();
    }
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="palette-card" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-input-row">
          <Search size={16} className="palette-search-icon" />
          <input
            className="palette-input"
            placeholder="Search chats, commands, models…"
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {rows.map((row, i) => (
            <button
              key={row.id}
              className={i === highlighted ? "palette-row sel" : "palette-row"}
              onMouseEnter={() => setIndex(i)}
              onClick={() => runRow(row)}
            >
              <span className="palette-row-icon">{row.icon}</span>
              <span className="palette-row-label">{row.label}</span>
              <span className="palette-kind">{row.kind}</span>
            </button>
          ))}
          {rows.length === 0 && <div className="palette-empty">No results for “{trimmed}”</div>}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}
