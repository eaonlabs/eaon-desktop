// Privacy & data: honest description of where data lives, the tool-consent
// toggles, and chat export/import/delete. Import only ever appends — an
// existing conversation is never overwritten by a file.

import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import Field from "../../common/Field";
import Switch from "../../common/Switch";
import type { Conversation, Project } from "../../../core/types";
import { useConversations } from "../../../state/conversations";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";
import {
  browserRegenerateToken,
  browserStart,
  browserStatus,
  type BrowserStatus,
} from "../../../core/ipc";

export default function PrivacyPane() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const showToast = useUi((s) => s.showToast);
  const conversationCount = useConversations((s) => s.conversations.length);
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const exportChats = () => {
    const { conversations, projects } = useConversations.getState();
    const blob = new Blob([JSON.stringify({ conversations, projects }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "eaon-chats.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importChats = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as {
        conversations?: Conversation[];
        projects?: Project[];
      };
      const incoming = Array.isArray(parsed.conversations) ? parsed.conversations : [];
      const incomingProjects = Array.isArray(parsed.projects) ? parsed.projects : [];
      const store = useConversations.getState();
      const existingIds = new Set(store.conversations.map((c) => c.id));
      const existingProjectIds = new Set(store.projects.map((p) => p.id));
      const added = incoming.filter((c) => c && typeof c.id === "string" && !existingIds.has(c.id));
      store.hydrate({
        conversations: [...store.conversations, ...added],
        projects: [
          ...store.projects,
          ...incomingProjects.filter((p) => p && typeof p.id === "string" && !existingProjectIds.has(p.id)),
        ],
        currentId: store.currentId,
        statistics: store.statistics,
      });
      showToast(added.length === 0 ? "Nothing new to import" : `Imported ${added.length} ${added.length === 1 ? "chat" : "chats"}`);
    } catch {
      showToast("That file isn't an Eaon chat export");
    }
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Privacy & data</div>
        <div className="pane-sub">What leaves this PC, and what never does.</div>
      </div>

      <div className="settings-card">
        <div className="settings-card-sub" style={{ marginTop: 0 }}>
          Your chats live in a single state.json file on this PC — there's no cloud copy and no
          telemetry. When you send a message, the request goes only to the provider serving the
          model you picked; nothing else is contacted on your behalf.
        </div>
      </div>

      <div className="settings-card">
        <Field label="Web search" hint="Lets models look things up when a chat needs fresh facts.">
          <Switch
            checked={settings.webSearchEnabled}
            onChange={(webSearchEnabled) => update({ webSearchEnabled })}
          />
        </Field>
        <Field
          label="Always allow tool calls"
          hint="Skips per-call confirmations — never device control."
        >
          <Switch
            checked={settings.alwaysAllowTools}
            onChange={(alwaysAllowTools) => update({ alwaysAllowTools })}
          />
        </Field>
        <Field
          label="Device control (BETA)"
          hint="Agent may open apps and URLs and move files to the trash."
        >
          <Switch
            checked={settings.deviceControlEnabled}
            onChange={(deviceControlEnabled) => update({ deviceControlEnabled })}
          />
        </Field>
      </div>

      {settings.deviceControlEnabled && <BrowserBridgeCard />}

      <div className="settings-card">
        <div className="settings-card-title">Your chats</div>
        <div className="settings-card-sub" style={{ marginBottom: 10 }}>
          {conversationCount} {conversationCount === 1 ? "conversation" : "conversations"} on this PC.
        </div>
        <div className="settings-row">
          <Button size="sm" onClick={exportChats}>
            Export all chats
          </Button>
          <Button size="sm" onClick={() => fileInput.current?.click()}>
            Import chats
          </Button>
          <div className="settings-grow" />
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete all chats
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importChats(file);
            e.target.value = "";
          }}
        />
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete all chats?"
        footer={
          <>
            <Button size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                useConversations.getState().removeAll();
                setConfirmDelete(false);
                showToast("All chats deleted");
              }}
            >
              Delete everything
            </Button>
          </>
        }
      >
        <p>
          Every conversation on this PC will be permanently deleted. There's no undo — consider
          exporting first.
        </p>
      </Dialog>
    </>
  );
}

/** The loopback bridge the Eaon browser extension pairs with. Shown only
 *  while device control is on, since browser tools ride that same opt-in.
 *
 *  The port and token are exactly what the extension's options page asks
 *  for — and are wire-compatible with the Mac app's bridge, so one extension
 *  build pairs with either. */
function BrowserBridgeCard() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const showToast = useUi((s) => s.showToast);

  useEffect(() => {
    // Starting is idempotent, so this both boots the bridge and reads it.
    void browserStart()
      .then(setStatus)
      .catch(() => void browserStatus().then(setStatus).catch(() => {}));
    // The extension is considered paired by how recently it polled, so this
    // has to re-read rather than wait for an event.
    const id = setInterval(() => {
      void browserStatus().then(setStatus).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    showToast("Copied");
  };

  return (
    <div className="settings-card">
      <div className="settings-card-heading">Browser control</div>
      <div className="settings-row">
        <span className={status?.connected ? "status-dot on" : "status-dot"} />
        <div className="settings-card-title settings-grow">
          {status?.connected
            ? status.tab
              ? `Extension connected — ${status.tab}`
              : "Extension connected"
            : status?.running
              ? "Waiting for the Eaon browser extension"
              : "Bridge isn't running"}
        </div>
      </div>
      <div className="settings-card-sub" style={{ marginTop: 8 }}>
        Lets Eaon read and drive the page in your browser. Install the Eaon
        extension, then paste the port and pairing key below into its options.
        The bridge listens on this PC only, and every request must carry the key.
      </div>

      {status?.running && (
        <>
          <div className="key-row" style={{ marginTop: 10 }}>
            <span className="tag-chip">Port</span>
            <code>{status.port}</code>
            <button className="icon-btn" aria-label="Copy port" onClick={() => copy(String(status.port))}>
              <Copy size={13} />
            </button>
          </div>
          <div className="key-row" style={{ marginTop: 8 }}>
            <span className="tag-chip">Key</span>
            <code>{status.token}</code>
            <button className="icon-btn" aria-label="Copy pairing key" onClick={() => copy(status.token)}>
              <Copy size={13} />
            </button>
          </div>
          <div className="settings-row" style={{ marginTop: 10 }}>
            <Button
              size="sm"
              onClick={() => {
                void browserRegenerateToken().then((next) => {
                  setStatus(next);
                  showToast("New key — re-pair the extension");
                });
              }}
            >
              Regenerate key
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
