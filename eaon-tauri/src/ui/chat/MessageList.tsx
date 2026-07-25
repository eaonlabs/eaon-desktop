// The scrolling conversation column. Auto-follows new tokens while the user
// is at the bottom; the instant they scroll up (wheel, touch, or scrollbar)
// following disarms, and it re-arms when they return to the bottom — with a
// floating jump button in between. Mirrors the Mac scroll-intent behavior.

import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useConversations } from "../../state/conversations";
import { useGeneration } from "../../state/generation";
import MessageBubble from "./MessageBubble";
import GenerationStatus from "./GenerationStatus";

export default function MessageList() {
  const conversation = useConversations(
    (s) => s.conversations.find((c) => c.id === s.currentId) ?? null,
  );
  const streaming = useGeneration(
    (s) => s.sessions[conversation?.id ?? ""]?.streaming === true,
  );
  // The status row mounts/unmounts and changes width with the phase, which
  // changes thread height without touching the message list — so the
  // auto-follow effect below needs it as a trigger too.
  const phase = useGeneration((s) => s.sessions[conversation?.id ?? ""]?.phase ?? null);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const lastTopRef = useRef(0);
  const [following, setFollowing] = useState(true);

  const conversationId = conversation?.id ?? null;

  // Entering a conversation always starts pinned to its latest message.
  useEffect(() => {
    setFollowing(true);
    const el = scrollerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastTopRef.current = el.scrollTop;
    }
  }, [conversationId]);

  // Track new content while armed. The conversation object's identity
  // changes on every appended token, so this runs at streaming rate —
  // a single scrollTop write, nothing layout-heavy.
  useEffect(() => {
    if (!following) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation, following, phase, streaming]);

  if (!conversation) return null;

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const distance = el.scrollHeight - top - el.clientHeight;
    const movedUp = top < lastTopRef.current - 1;
    lastTopRef.current = top;
    if (movedUp && distance > 4) setFollowing(false);
    else if (distance < 4 || (!movedUp && distance < 48)) setFollowing(true);
  };

  const jumpToBottom = () => {
    setFollowing(true);
    scrollerRef.current?.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: "smooth",
    });
  };

  const messages = conversation.messages;
  // Whether the trailing bubble is already showing an answer — the status
  // row uses this to stand down once prose is actually on screen.
  const last = messages[messages.length - 1];
  const hasVisibleAnswer =
    last?.role === "assistant" && !last.isToolResult && last.content.length > 0;

  return (
    <div className="msg-viewport">
      <div
        ref={scrollerRef}
        className="msg-scroller"
        onScroll={onScroll}
        onWheel={(e) => {
          // Upward intent disarms immediately, even before position changes.
          if (e.deltaY < 0) setFollowing(false);
        }}
        onTouchMove={() => setFollowing(false)}
      >
        <div className="msg-thread">
          {messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              conversationId={conversation.id}
              message={message}
              isLast={index === messages.length - 1}
              conversationStreaming={streaming}
            />
          ))}
          <GenerationStatus conversationId={conversation.id} hasVisibleAnswer={hasVisibleAnswer} />
        </div>
      </div>
      {!following && (
        <button className="jump-btn" title="Jump to latest" aria-label="Jump to latest" onClick={jumpToBottom}>
          <ArrowDown size={14} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
