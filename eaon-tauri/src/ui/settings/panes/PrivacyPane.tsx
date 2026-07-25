// Privacy & data: honest description of where data lives, the tool-consent
// toggles, and chat export/import/delete. Import only ever appends — an
// existing conversation is never overwritten by a file.

import { useRef, useState } from "react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import Field from "../../common/Field";
import Switch from "../../common/Switch";
import type { Conversation, Project } from "../../../core/types";
import { useConversations } from "../../../state/conversations";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";

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
