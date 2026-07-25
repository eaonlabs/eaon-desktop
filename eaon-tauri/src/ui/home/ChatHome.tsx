// The empty-conversation hero: brand mark, a mode-aware greeting, suggestion
// chips that prefill the composer, and the user's most recent conversations
// as quick ways back in. Purely a launchpad — the composer itself stays
// docked in ChatView so nothing jumps when the first message sends.

import { useMemo } from "react";
import { ChevronRight, MessageSquare } from "lucide-react";
import { BrandMark } from "../layout/TitleBar";
import { useConversations } from "../../state/conversations";
import { useUi } from "../../state/ui";
import { dateBucket } from "../../core/utils";
import { setComposerDraft } from "../chat/composerBus";

interface Suggestion {
  label: string;
  draft: string;
}

const CHAT_SUGGESTIONS: Suggestion[] = [
  { label: "Summarize an article", draft: "Summarize the key points of this article: " },
  { label: "Draft an email", draft: "Draft a short, friendly email to " },
  { label: "Explain a concept", draft: "Explain, in plain terms, how " },
  { label: "Brainstorm ideas", draft: "Brainstorm ten ideas for " },
];

const AGENT_SUGGESTIONS: Suggestion[] = [
  { label: "Scaffold a project", draft: "Set up a new project folder with a starter " },
  { label: "Hunt down a bug", draft: "Help me find and fix a bug in " },
  { label: "Tidy up a folder", draft: "Organize the files in my Downloads folder by " },
  { label: "Write a script", draft: "Write and run a script that " },
];

export default function ChatHome() {
  const mode = useUi((s) => s.mode);
  const conversations = useConversations((s) => s.conversations);
  const select = useConversations((s) => s.select);

  const recents = useMemo(
    () =>
      conversations
        .filter((c) => c.messages.length > 0)
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3),
    [conversations],
  );

  const suggestions = mode === "agent" ? AGENT_SUGGESTIONS : CHAT_SUGGESTIONS;

  return (
    <div className="home">
      <div className="home-hero">
        <BrandMark size={52} />
        <h1 className="home-title">
          {mode === "agent" ? "What should we build?" : "What can I help with?"}
        </h1>
      </div>

      <div className="home-chips">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.label}
            className="home-chip"
            onClick={() => setComposerDraft(suggestion.draft)}
          >
            {suggestion.label}
          </button>
        ))}
      </div>

      {recents.length > 0 && (
        <div className="home-recents">
          <div className="home-recents-title">Recent chats</div>
          {recents.map((conversation) => (
            <button
              key={conversation.id}
              className="home-recent"
              onClick={() => select(conversation.id)}
            >
              <span className="home-recent-icon">
                <MessageSquare size={12} aria-hidden />
              </span>
              <span className="home-recent-title">{conversation.title}</span>
              <span className="home-recent-time">{dateBucket(conversation.updatedAt)}</span>
              <ChevronRight size={13} aria-hidden />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
