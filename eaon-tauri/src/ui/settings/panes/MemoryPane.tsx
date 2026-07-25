// Memory: the auto-learn toggle plus direct edit of what Eaon has learned.
// Memories are plain local data — adding and removing here is exactly as
// authoritative as anything the model learned on its own.

import { useState } from "react";
import { Download, X } from "lucide-react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import Field from "../../common/Field";
import Switch from "../../common/Switch";
import MemoryImportDialog from "./MemoryImportDialog";
import type { Memory } from "../../../core/types";
import { uid } from "../../../core/utils";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";

export default function MemoryPane() {
  const memoryEnabled = useSettings((s) => s.settings.memoryEnabled);
  const memories = useSettings((s) => s.settings.memories);
  const update = useSettings((s) => s.update);
  const showToast = useUi((s) => s.showToast);
  const [draft, setDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    const memory: Memory = { id: uid(), text, kind: "fact", createdAt: Date.now() };
    update({ memories: [...memories, memory] });
    setDraft("");
  };

  const remove = (id: string) => update({ memories: memories.filter((m) => m.id !== id) });

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Memory</div>
        <div className="pane-sub">
          Learned on this PC, stored on this PC — never uploaded on its own.
        </div>
      </div>

      <div className="settings-card">
        <Field
          label="Remember things about me"
          hint="Eaon picks up durable facts from your chats and uses them later."
        >
          <Switch checked={memoryEnabled} onChange={(memoryEnabled) => update({ memoryEnabled })} />
        </Field>
        <Field
          label="Import from another assistant"
          hint="Bring over what ChatGPT, Claude, or Gemini already knows about you — copy one prompt, paste their reply back."
        >
          <Button size="sm" onClick={() => setImportOpen(true)}>
            <Download size={13} />
            Import
          </Button>
        </Field>
      </div>

      <div className="settings-card">
        <div className="settings-row" style={{ marginBottom: memories.length ? 12 : 0 }}>
          <input
            className="settings-input settings-grow"
            placeholder="Add something Eaon should remember…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <Button size="sm" onClick={add} disabled={!draft.trim()}>
            Add
          </Button>
        </div>

        {memories.length === 0 ? (
          <div className="settings-note">Nothing remembered yet.</div>
        ) : (
          memories.map((memory) => (
            <div key={memory.id} className="item-row">
              <div className="item-main">
                <div className="item-title">
                  <span style={{ fontWeight: 450 }}>{memory.text}</span>
                  <span className="tag-chip">{memory.kind}</span>
                </div>
                <div className="item-sub">{new Date(memory.createdAt).toLocaleDateString()}</div>
              </div>
              <div className="item-actions">
                <button
                  className="icon-btn danger"
                  aria-label="Forget this"
                  onClick={() => remove(memory.id)}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {memories.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
            Clear all
          </Button>
        </div>
      )}

      <MemoryImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        existing={memories}
        onImport={(imported) => {
          update({ memories: [...memories, ...imported] });
          showToast(`Imported ${imported.length} ${imported.length === 1 ? "memory" : "memories"}`);
        }}
      />

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Forget everything?"
        footer={
          <>
            <Button size="sm" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                update({ memories: [] });
                setConfirmClear(false);
              }}
            >
              Clear all
            </Button>
          </>
        }
      >
        <p>
          All {memories.length} memories will be deleted. Eaon will keep learning new ones if
          memory stays on.
        </p>
      </Dialog>
    </>
  );
}
