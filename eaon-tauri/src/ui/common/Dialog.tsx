// Modal primitive — every confirm flow goes through this so scrim, Esc, and
// focus behavior stay consistent. The Esc listener runs in the capture phase
// and stops propagation so App's global Esc handling (settings, palette)
// never fires underneath an open dialog.

import { useEffect, useId, useRef, type ReactNode } from "react";
import "./common.css";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Overrides the default 400px panel width for content-heavy dialogs. */
  width?: number;
}

export default function Dialog({ open, onClose, title, children, footer, width }: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Move focus into the dialog — unless a child (an autoFocus input, say)
  // already claimed it during mount.
  useEffect(() => {
    if (open && panelRef.current && !panelRef.current.contains(document.activeElement)) {
      panelRef.current.focus();
    }
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="dialog-card"
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
