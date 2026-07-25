// "Import from another assistant" — the copy-prompt / paste-reply flow.
//
// Three visible steps in one dialog rather than a wizard: the whole point is
// that the user can see what the round trip involves before committing to
// it, and the review list is where junk from a chatty source model gets
// dropped — so it must sit next to the paste box, not behind a Next button.

import { useMemo, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import { copyText } from "../../chat/CodeBlock";
import type { Memory } from "../../../core/types";
import { isDuplicateMemory, MAX_MEMORIES } from "../../../core/protocol/memory";
import {
  MEMORY_IMPORT_PROMPT,
  parseImportedMemories,
  toMemories,
  type ImportedMemory,
} from "../../../core/protocol/memoryImport";

export interface MemoryImportDialogProps {
  open: boolean;
  onClose: () => void;
  existing: Memory[];
  onImport: (memories: Memory[]) => void;
}

export default function MemoryImportDialog({
  open,
  onClose,
  existing,
  onImport,
}: MemoryImportDialogProps) {
  const [pasted, setPasted] = useState("");
  const [copied, setCopied] = useState(false);
  // Items the user removed from the review list, by their text — index-based
  // tracking would shift under them as the parse re-runs on every keystroke.
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());

  const existingTexts = useMemo(() => existing.map((m) => m.text), [existing]);

  const { keep, duplicates } = useMemo(() => {
    const parsed = parseImportedMemories(pasted);
    const keep: ImportedMemory[] = [];
    let duplicates = 0;
    for (const item of parsed) {
      if (isDuplicateMemory(existingTexts, item.text)) {
        duplicates += 1;
        continue;
      }
      if (dropped.has(item.text)) continue;
      keep.push(item);
    }
    return { keep, duplicates };
  }, [pasted, existingTexts, dropped]);

  // The store's lifetime ceiling still applies to an import — say so up
  // front rather than silently keeping the first N.
  const room = Math.max(0, MAX_MEMORIES - existing.length);
  const overflow = Math.max(0, keep.length - room);
  const importable = keep.slice(0, room);

  const reset = () => {
    setPasted("");
    setDropped(new Set());
    setCopied(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const copyPrompt = () => {
    void copyText(MEMORY_IMPORT_PROMPT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const confirm = () => {
    if (!importable.length) return;
    onImport(toMemories(importable));
    reset();
    onClose();
  };

  const showReview = pasted.trim().length > 0;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import memories"
      width={620}
      footer={
        <>
          <Button size="sm" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!importable.length} onClick={confirm}>
            {importable.length ? `Import ${importable.length}` : "Import"}
          </Button>
        </>
      }
    >
      <div className="import-step">
        <div className="import-step-label">Step 1 — Copy this prompt</div>
        <p className="settings-note" style={{ marginTop: 0 }}>
          Send it to ChatGPT, Claude, Gemini, or any assistant that remembers you. Nothing is
          shared from here — you paste it there yourself.
        </p>
        <pre className="import-prompt-box" data-selectable>
          {MEMORY_IMPORT_PROMPT}
        </pre>
        <Button size="sm" onClick={copyPrompt}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy prompt"}
        </Button>
      </div>

      <div className="import-step">
        <div className="import-step-label">Step 2 — Paste its reply below</div>
        <textarea
          className="settings-textarea"
          rows={5}
          placeholder='Paste the whole reply. JSON, a bullet list, or plain lines all work.'
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
      </div>

      {showReview && (
        <div className="import-step">
          <div className="import-step-label">Step 3 — Review</div>
          {keep.length === 0 ? (
            <p className="settings-note" style={{ marginTop: 0 }}>
              {duplicates > 0
                ? `Nothing new — all ${duplicates} ${duplicates === 1 ? "item" : "items"} already match something Eaon remembers.`
                : "Nothing readable in that reply yet. Paste the assistant's whole answer, including its list."}
            </p>
          ) : (
            <>
              <p className="settings-note" style={{ marginTop: 0 }}>
                {importable.length} to import
                {duplicates > 0 && ` · ${duplicates} already known, skipped`}
                {overflow > 0 && ` · ${overflow} over the ${MAX_MEMORIES} limit, not imported`}
              </p>
              <div className="import-preview">
                {importable.map((item) => (
                  <div key={item.text} className="item-row">
                    <div className="item-main">
                      <div className="item-title">
                        <span style={{ fontWeight: 450 }}>{item.text}</span>
                        <span className="tag-chip">{item.kind}</span>
                      </div>
                    </div>
                    <div className="item-actions">
                      <button
                        className="icon-btn danger"
                        aria-label="Don't import this"
                        title="Don't import this"
                        onClick={() =>
                          setDropped((prev) => new Set(prev).add(item.text))
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
