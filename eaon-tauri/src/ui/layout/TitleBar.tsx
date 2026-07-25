// The frameless window's top bar: drag region, brand mark, and the
// minimize/maximize/close controls (Windows/Linux put them on the right).

import { PanelLeft } from "lucide-react";
import { useUi } from "../../state/ui";
import WindowControls from "./WindowControls";

/** The Eaon brand mark — the one place the brand orange appears. A peak
 *  rising from a wave (reads as both "A" and water), on a rounded-square
 *  tile — the exact geometry as the Mac app's AquaGlyph/AquaMark
 *  (SidebarView.swift) and the app icon (installer/make-icon.swift), so the
 *  in-app mark and the taskbar/dock icon are the same shape. */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <rect width="100" height="100" rx="28" ry="28" fill="var(--brand)" />
      <path d="M50 32.24 L68.72 67.6 C59.36 58.24 40.64 58.24 31.28 67.6 Z" fill="#fff" />
    </svg>
  );
}

export default function TitleBar() {
  const toggleSidebar = useUi((s) => s.toggleSidebar);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <button
          className="titlebar-button"
          onClick={toggleSidebar}
          title="Toggle sidebar (Ctrl+\)"
          aria-label="Toggle sidebar"
        >
          <PanelLeft size={16} />
        </button>
        <BrandMark />
        <span className="titlebar-name">Eaon</span>
      </div>
      <WindowControls />
    </header>
  );
}
