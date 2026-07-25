// The main chat pane: hero or message list on top, the composer docked at
// the bottom center, the update banner floating top-right, and a quiet
// context-usage badge once a conversation grows past half the model's
// window. Owns chat.css for the whole chat surface.

import { useMemo } from "react";
import { useConversations } from "../../state/conversations";
import { useModels } from "../../state/models";
import { contextWindowFor } from "../../core/catalog";
import { estimateTokens } from "../../core/utils";
import UpdateBanner from "../common/UpdateBanner";
import ChatHome from "../home/ChatHome";
import MessageList from "./MessageList";
import Composer from "./Composer";
import "./chat.css";

export default function ChatView() {
  const conversation = useConversations(
    (s) => s.conversations.find((c) => c.id === s.currentId) ?? null,
  );
  const selectedKey = useModels((s) => s.selectedModelKey);

  const empty = !conversation || conversation.messages.length === 0;

  // chars/4 vs the model family's window — the same estimate the Mac badge
  // shows. Only surfaces past 50%, when it starts being worth knowing.
  const contextPercent = useMemo(() => {
    if (!conversation || conversation.messages.length === 0) return 0;
    const chars = conversation.messages.reduce(
      (total, message) => total + message.content.length + message.reasoning.length,
      0,
    );
    const entry = useModels.getState().entryFor(selectedKey);
    return Math.round(
      (estimateTokens(chars) / contextWindowFor(entry?.requestId ?? "")) * 100,
    );
  }, [conversation, selectedKey]);

  return (
    <div className="chat-view">
      <div className="chat-float">
        <UpdateBanner />
      </div>

      {empty ? <ChatHome /> : <MessageList />}

      <div className="chat-dock">
        <div className="chat-dock-inner">
          {contextPercent > 50 && (
            <div
              className="context-badge"
              title="Estimated share of the model's context window this conversation uses"
            >
              {Math.min(contextPercent, 999)}% of context
            </div>
          )}
          <Composer />
          {!empty && (
            <p className="chat-disclaimer">Eaon can make mistakes. Check important info.</p>
          )}
        </div>
      </div>
    </div>
  );
}
