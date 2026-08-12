// One turn of the conversation. Users get a right-aligned bubble (18px
// radius, optionally accent-tinted) with hover copy/edit; assistants get
// ChatGPT-style full-width prose with the thinking disclosure, markdown,
// generated images, and a metadata + actions footer. Memoized so streaming
// only re-renders the message actually receiving tokens.

import { memo, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Pencil,
  RefreshCw,
  Slash,
  Square,
  TriangleAlert,
  Volume2,
} from "lucide-react";
import type { ChatMessage } from "../../core/types";
import { useSettings } from "../../state/settings";
import { regenerate, editAndResend } from "../../chat/send";
import { ttsAvailable, speak, stopSpeaking, speakableText } from "../../core/tts";
import AssistantContent from "./AssistantContent";
import ThinkingDisclosure from "./ThinkingDisclosure";
import ToolResultCard from "./ToolResultCard";
import AttachmentThumb from "./AttachmentThumb";
import Button from "../common/Button";
import { copyText } from "./CodeBlock";
import { useTypewriter } from "./useTypewriter";

/** Resets the previous bubble's "reading aloud" state when another starts —
 *  the narrator itself is one-at-a-time already. */
let resetActiveSpeaker: (() => void) | null = null;

/** Read-aloud support is probed once per launch; bubbles share the answer. */
let ttsSupported: boolean | null = null;
function useTtsAvailable(): boolean {
  const [available, setAvailable] = useState(ttsSupported === true);
  useEffect(() => {
    if (ttsSupported !== null) return;
    let alive = true;
    void ttsAvailable().then((supported) => {
      ttsSupported = supported;
      if (alive && supported) setAvailable(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return available;
}

export interface MessageBubbleProps {
  conversationId: string;
  message: ChatMessage;
  isLast: boolean;
  /** Whether this message's conversation is currently streaming. */
  conversationStreaming: boolean;
}

function useCopyFeedback(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return [copied, onCopy];
}

function UserTurn({ conversationId, message }: MessageBubbleProps) {
  const tinted = useSettings((s) => s.settings.coloredUserBubble);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, onCopy] = useCopyFeedback(message.content);

  const submitEdit = () => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    void editAndResend(conversationId, message.id, text);
  };

  return (
    <div className="turn turn-user">
      {message.attachments && message.attachments.length > 0 && (
        <div className="user-attachments">
          {message.attachments.map((attachment) => (
            <AttachmentThumb key={attachment.id} attachment={attachment} variant="bubble" />
          ))}
        </div>
      )}
      {message.invokedSkillName && (
        <span className="skill-badge" title={`Sent with the ${message.invokedSkillName} skill`}>
          <Slash size={10} strokeWidth={2.6} aria-hidden />
          {message.invokedSkillName}
        </span>
      )}
      {editing ? (
        <div className="user-edit">
          <textarea
            value={draft}
            autoFocus
            rows={Math.min(Math.max(draft.split("\n").length, 2), 10)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitEdit();
              }
            }}
          />
          <div className="user-edit-actions">
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={submitEdit}>
              Send
            </Button>
          </div>
        </div>
      ) : (
        <>
          {message.content && (
            <div className={"user-bubble" + (tinted ? " accent-tint" : "")} data-selectable>
              {message.content}
            </div>
          )}
          <div className="user-actions">
            <button title="Copy" aria-label="Copy message" onClick={onCopy}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <button
              title="Edit and resend"
              aria-label="Edit and resend"
              onClick={() => {
                setDraft(message.content);
                setEditing(true);
              }}
            >
              <Pencil size={13} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AssistantTurn({ conversationId, message, isLast, conversationStreaming }: MessageBubbleProps) {
  const showTokenSpeed = useSettings((s) => s.settings.showTokenSpeed);
  const ttsOk = useTtsAvailable();
  const [copied, onCopy] = useCopyFeedback(message.content);
  const [speaking, setSpeaking] = useState(false);

  const streamingThis = conversationStreaming && isLast;
  const done = !streamingThis && (message.content.length > 0 || message.isError === true);
  const shownContent = useTypewriter(message.content, streamingThis);

  const toggleSpeak = () => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      resetActiveSpeaker = null;
      return;
    }
    resetActiveSpeaker?.();
    const started = speak(speakableText(message.content), () => {
      setSpeaking(false);
      resetActiveSpeaker = null;
    });
    if (!started) return;
    setSpeaking(true);
    resetActiveSpeaker = () => setSpeaking(false);
  };

  const meta: string[] = [];
  if (message.modelDisplay) meta.push(message.modelDisplay);
  if (message.generatedTokenCount && message.generationStartTime && message.generationEndTime) {
    meta.push(`≈ ${message.generatedTokenCount} tok`);
    const seconds = (message.generationEndTime - message.generationStartTime) / 1000;
    if (showTokenSpeed && seconds > 0) {
      meta.push(`${Math.round(message.generatedTokenCount / seconds)} tok/s`);
    }
  }

  return (
    <div className={"turn turn-assistant" + (isLast ? " is-last" : "")}>
      {message.reasoning && (
        <ThinkingDisclosure
          reasoning={message.reasoning}
          thinking={streamingThis && !message.content}
        />
      )}

      {message.isError ? (
        <div className="error-card" data-selectable>
          <TriangleAlert size={16} aria-hidden />
          <div>
            <div className="error-title">Something went wrong</div>
            <div className="error-body">{message.content}</div>
          </div>
        </div>
      ) : shownContent ? (
        <div className={"msg-body" + (streamingThis ? " streaming" : "")}>
          <AssistantContent content={shownContent} />
        </div>
      ) : null}
      {/* The waiting indicator is NOT here: it lives at thread level
          (GenerationStatus) so it also covers the stretches where this
          bubble doesn't exist — the agent loop deletes a turn that was
          nothing but tool fences, and tool execution is the longest wait
          of all. */}

      {message.attachments && message.attachments.length > 0 && (
        <div className="gen-images">
          {message.attachments.map((attachment) => (
            <AttachmentThumb
              key={attachment.id}
              attachment={attachment}
              variant={message.isGeneratedImage ? "generated" : "bubble"}
            />
          ))}
        </div>
      )}

      {done && (
        <div className="msg-footer">
          {meta.length > 0 && !message.isError && <div className="msg-meta">{meta.join(" · ")}</div>}
          <div className="msg-actions">
            <button title="Copy" aria-label="Copy reply" onClick={onCopy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {ttsOk && message.content && (
              <button
                title={speaking ? "Stop reading" : "Read aloud"}
                aria-label={speaking ? "Stop reading" : "Read aloud"}
                className={speaking ? "lit" : ""}
                onClick={toggleSpeak}
              >
                {speaking ? <Square size={13} /> : <Volume2 size={14} />}
              </button>
            )}
            {isLast && (
              <button
                title="Regenerate"
                aria-label="Regenerate reply"
                onClick={() => void regenerate(conversationId, message.id)}
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble(props: MessageBubbleProps) {
  const { message } = props;
  if (message.isToolResult) {
    return (
      <div className="turn turn-assistant">
        <ToolResultCard content={message.content} />
      </div>
    );
  }
  return message.role === "user" ? <UserTurn {...props} /> : <AssistantTurn {...props} />;
}

export default memo(
  MessageBubble,
  (prev, next) =>
    prev.message === next.message &&
    prev.isLast === next.isLast &&
    prev.conversationStreaming === next.conversationStreaming &&
    prev.conversationId === next.conversationId,
);
