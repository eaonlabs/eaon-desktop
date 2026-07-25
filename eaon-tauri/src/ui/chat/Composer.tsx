// The input card everything funnels through: growing textarea, attachments
// (picker, paste), "/" skill autocomplete, the Chat/Agent switcher on fresh
// conversations, the Agent permission pill (Shift+Tab), the model picker,
// and a send button that becomes Stop while this conversation streams.

import { useEffect, useMemo, useRef, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { ArrowUp, FileText, FolderOpen, Image as ImageIcon, Plus, Shield, Slash, Square, X, Zap } from "lucide-react";
import type { MessageAttachment, Skill } from "../../core/types";
import { useConversations } from "../../state/conversations";
import { useGeneration } from "../../state/generation";
import { useModels } from "../../state/models";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { sendMessage, stopGeneration } from "../../chat/send";
import { importFile } from "../../core/attachments";
import { normalizeSkillName } from "../../core/protocol/skills";
import ModelPicker from "../models/ModelPicker";
import Button from "../common/Button";
import AttachmentThumb from "./AttachmentThumb";
import { onComposerDraft } from "./composerBus";

export default function Composer() {
  const currentId = useConversations((s) => s.currentId);
  const conversationEmpty = useConversations((s) => {
    const current = s.conversations.find((c) => c.id === s.currentId);
    return !current || current.messages.length === 0;
  });
  const streaming = useGeneration((s) =>
    currentId ? s.sessions[currentId]?.streaming === true : false,
  );
  const agentAutoRun = useGeneration((s) => s.agentAutoRun);
  const askingToEnterAuto = useGeneration((s) => s.askingToEnterAuto);
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  const skills = useSettings((s) => s.settings.skills);
  const agentWorkspace = useSettings((s) => s.settings.agentWorkspace);

  const selectedKey = useModels((s) => s.selectedModelKey);
  const hostedModels = useModels((s) => s.hostedModels);
  const ollamaModels = useModels((s) => s.ollamaModels);
  const placeholder = useMemo(() => {
    const entry = useModels.getState().entryFor(selectedKey);
    // Ollama tags carry ":latest"-style suffixes nobody says out loud.
    const name = entry?.display.split(":")[0];
    return name ? `Ask ${name} anything` : "Ask anything";
  }, [selectedKey, hostedModels, ollamaModels]);

  const [input, setInput] = useState("");
  const [pending, setPending] = useState<MessageAttachment[]>([]);
  const [invokedSkill, setInvokedSkill] = useState<Skill | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [skillDismissed, setSkillDismissed] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);

  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachWrapRef = useRef<HTMLDivElement | null>(null);
  const pillWrapRef = useRef<HTMLDivElement | null>(null);

  // Suggestion chips (ChatHome) prefill the draft through the bus.
  useEffect(
    () =>
      onComposerDraft((text) => {
        setInput(text);
        setSkillDismissed(false);
        fieldRef.current?.focus();
      }),
    [],
  );

  // Autogrow with the draft, capped so long prompts scroll inside the card.
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Close the attach menu / auto-run confirm on any outside press.
  useEffect(() => {
    if (!attachOpen && !askingToEnterAuto) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (attachOpen && !attachWrapRef.current?.contains(target)) setAttachOpen(false);
      if (askingToEnterAuto && !pillWrapRef.current?.contains(target)) {
        useGeneration.getState().setAskingToEnterAuto(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [attachOpen, askingToEnterAuto]);

  // "/" autocomplete is live only while the draft is a bare "/name" token.
  const skillToken = useMemo(() => /^\/(\S*)$/.exec(input)?.[1] ?? null, [input]);
  const skillMatches = useMemo(() => {
    if (skillToken === null || invokedSkill) return [];
    const query = normalizeSkillName(skillToken) as string;
    return skills
      .filter((skill) => skill.isEnabled && skill.name.startsWith(query))
      .slice(0, 6);
  }, [skillToken, invokedSkill, skills]);
  const skillOpen = !skillDismissed && skillMatches.length > 0;

  const pickSkill = (skill: Skill) => {
    setInvokedSkill(skill);
    setInput("");
    setSkillIndex(0);
    fieldRef.current?.focus();
  };

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      try {
        const attachment = (await importFile(file)) as MessageAttachment;
        setPending((prev) => [...prev, attachment]);
      } catch {
        useUi.getState().showToast(`Couldn't attach ${file.name}`);
      }
    }
  };

  const canSend = !streaming && (input.trim().length > 0 || pending.length > 0);

  const handleSend = () => {
    if (!canSend) return;
    const conversationId = currentId ?? useConversations.getState().newConversation();
    const text = input.trim();
    const attachments = pending;
    const skill = invokedSkill;
    setInput("");
    setPending([]);
    setInvokedSkill(null);
    void sendMessage({
      conversationId,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      skill: skill ?? undefined,
    });
  };

  const toggleAutoPill = () => {
    const generation = useGeneration.getState();
    if (generation.agentAutoRun) generation.setAgentAutoRun(false);
    else generation.setAskingToEnterAuto(true);
  };

  // Cursor's "open folder": the native directory picker sets the Agent's
  // workspace — every relative tool path and run_shell resolves against it.
  const workspaceName = agentWorkspace?.split(/[\\/]/).filter(Boolean).pop() ?? null;
  const pickWorkspace = async () => {
    const dir = await openFolderDialog({ directory: true, multiple: false, title: "Open project folder" });
    if (typeof dir === "string" && dir) useSettings.getState().update({ agentWorkspace: dir });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSkillIndex((i) => (i + 1) % skillMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSkillIndex((i) => (i - 1 + skillMatches.length) % skillMatches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pickSkill(skillMatches[Math.min(skillIndex, skillMatches.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSkillDismissed(true);
        return;
      }
    }
    if (event.key === "Tab" && event.shiftKey && mode === "agent") {
      event.preventDefault();
      toggleAutoPill();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const onFilesPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    void addFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const images = Array.from(items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (images.length === 0) return;
    event.preventDefault();
    void addFiles(images);
  };

  return (
    <div className="composer">
      <div className="composer-card">
        {skillOpen && (
          <div className="skill-pop" role="listbox" aria-label="Skills">
            {skillMatches.map((skill, index) => (
              <button
                key={skill.id}
                className={"skill-row" + (index === skillIndex ? " active" : "")}
                role="option"
                aria-selected={index === skillIndex}
                onMouseEnter={() => setSkillIndex(index)}
                onClick={() => pickSkill(skill)}
              >
                <span className="skill-row-name">/{skill.name}</span>
                <span className="skill-row-summary">{skill.summary}</span>
              </button>
            ))}
          </div>
        )}

        {(pending.length > 0 || invokedSkill) && (
          <div className="composer-chips">
            {invokedSkill && (
              <span className="skill-chip">
                <Slash size={10} strokeWidth={2.6} aria-hidden />
                {invokedSkill.name}
                <button
                  title="Remove skill"
                  aria-label={`Remove the ${invokedSkill.name} skill`}
                  onClick={() => setInvokedSkill(null)}
                >
                  <X size={10} strokeWidth={2.6} />
                </button>
              </span>
            )}
            {pending.map((attachment) => (
              <AttachmentThumb
                key={attachment.id}
                attachment={attachment}
                variant="composer"
                onRemove={() => setPending((prev) => prev.filter((a) => a.id !== attachment.id))}
              />
            ))}
          </div>
        )}

        <textarea
          ref={fieldRef}
          className="composer-textarea"
          rows={1}
          value={input}
          placeholder={placeholder}
          onChange={(e) => {
            setInput(e.target.value);
            setSkillDismissed(false);
            setSkillIndex(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={onFilesPicked} />
        <input ref={fileInputRef} type="file" multiple hidden onChange={onFilesPicked} />

        <div className="composer-bar">
          <div className="attach-wrap" ref={attachWrapRef}>
            <button
              className="composer-icon-btn"
              title="Attach"
              aria-label="Attach an image or file"
              onClick={() => setAttachOpen((open) => !open)}
            >
              <Plus size={17} />
            </button>
            {attachOpen && (
              <div className="attach-menu">
                <button onClick={() => { setAttachOpen(false); imageInputRef.current?.click(); }}>
                  <ImageIcon size={14} /> Image…
                </button>
                <button onClick={() => { setAttachOpen(false); fileInputRef.current?.click(); }}>
                  <FileText size={14} /> File…
                </button>
              </div>
            )}
          </div>

          <ModelPicker />

          {conversationEmpty && (
            <div className="mode-switch" role="tablist" aria-label="Mode">
              {(["chat", "agent"] as const).map((id) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={mode === id}
                  className={"mode-btn" + (mode === id ? " on" : "")}
                  onClick={() => setMode(id)}
                >
                  {id === "chat" ? "Chat" : "Agent"}
                </button>
              ))}
            </div>
          )}

          {mode === "agent" && (
            <div
              className={"workspace-chip" + (agentWorkspace ? " set" : "")}
              role="button"
              tabIndex={0}
              title={agentWorkspace ?? "Open a project folder — the agent works inside it, like Cursor"}
              onClick={() => void pickWorkspace()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void pickWorkspace();
                }
              }}
            >
              <FolderOpen size={12} aria-hidden />
              <span className="workspace-chip-name">{workspaceName ?? "Open folder"}</span>
              {agentWorkspace && (
                <button
                  aria-label="Close project folder"
                  title="Close project folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    useSettings.getState().update({ agentWorkspace: null });
                  }}
                >
                  <X size={10} strokeWidth={2.6} />
                </button>
              )}
            </div>
          )}

          {mode === "agent" && (
            <div className="agent-pill-wrap" ref={pillWrapRef}>
              <button
                className={"agent-pill " + (agentAutoRun ? "auto" : "sandboxed")}
                title="Switch how Agent actions are approved (Shift+Tab)"
                onClick={toggleAutoPill}
              >
                {agentAutoRun ? (
                  <Zap size={11} aria-hidden />
                ) : (
                  <Shield size={11} aria-hidden />
                )}
                {agentAutoRun ? "Auto" : "Sandboxed"}
              </button>
              {askingToEnterAuto && (
                <div className="auto-confirm" role="dialog" aria-label="Run without asking?">
                  <div className="auto-confirm-title">Run without asking?</div>
                  <p className="auto-confirm-note">
                    Eaon will run file and shell actions on this PC without confirming each one.
                  </p>
                  <div className="auto-confirm-actions">
                    <Button
                      size="sm"
                      onClick={() => useGeneration.getState().setAskingToEnterAuto(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        const generation = useGeneration.getState();
                        generation.setAgentAutoRun(true);
                        generation.setAskingToEnterAuto(false);
                      }}
                    >
                      Confirm
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <span className="composer-spacer" />

          {streaming ? (
            <button
              className="composer-send stop"
              title="Stop generating"
              aria-label="Stop generating"
              onClick={() => {
                if (currentId) void stopGeneration(currentId);
              }}
            >
              <Square size={12} strokeWidth={2.4} />
            </button>
          ) : (
            <button
              className="composer-send"
              title="Send"
              aria-label="Send message"
              disabled={!canSend}
              onClick={handleSend}
            >
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
