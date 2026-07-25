// Sandboxed-mode gate: the Agent wants to run a real action on this PC and
// waits here for a verdict. Deny / Allow Once / Allow for This Chat, with
// Esc (and a scrim click) counting as a deny — never a silent allow.

import { useCallback, useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { useGeneration } from "../../state/generation";
import Button from "../common/Button";

export default function ToolConfirmDialog() {
  const pending = useGeneration((s) => s.pendingConfirm);

  const decide = useCallback(
    (decision: "once" | "always" | "deny") => {
      if (!pending) return;
      pending.resolve(decision);
      useGeneration.getState().setPendingConfirm(null);
    },
    [pending],
  );

  // Esc = deny, captured ahead of the app-level Escape handling.
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        decide("deny");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, decide]);

  if (!pending) return null;

  return (
    <div
      className="chat-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) decide("deny");
      }}
    >
      <div className="chat-dialog" role="dialog" aria-modal="true" aria-label="Allow this action?">
        <h2 className="dialog-title">
          <TriangleAlert size={16} aria-hidden />
          Allow this action?
        </h2>
        <p className="dialog-summary">{pending.summary}</p>
        {pending.detail && (
          <pre className="dialog-detail" data-selectable>
            {pending.detail}
          </pre>
        )}
        <p className="dialog-note">
          This runs on your computer with your permissions. “Allow for This Chat” stops
          asking for the rest of this conversation.
        </p>
        <div className="dialog-actions">
          <Button onClick={() => decide("deny")}>Deny</Button>
          <span className="dialog-spacer" />
          <Button onClick={() => decide("once")}>Allow Once</Button>
          <Button variant="primary" onClick={() => decide("always")}>
            Allow for This Chat
          </Button>
        </div>
      </div>
    </div>
  );
}
