// The Agent's ask_user pause: the model's question, one button per offered
// option, and a free-text field so the user can always answer in their own
// words. The turn is suspended until an answer resolves it.

import { useEffect, useState } from "react";
import { MessageCircleQuestionMark } from "lucide-react";
import { useGeneration } from "../../state/generation";
import Button from "../common/Button";

export default function AgentQuestionDialog() {
  const pending = useGeneration((s) => s.pendingQuestion);
  const [custom, setCustom] = useState("");

  // A fresh question starts with a clean free-text field.
  useEffect(() => setCustom(""), [pending]);

  if (!pending) return null;

  const answer = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    pending.resolve(trimmed);
    useGeneration.getState().setPendingQuestion(null);
  };

  return (
    <div className="chat-overlay">
      <div className="chat-dialog" role="dialog" aria-modal="true" aria-label="Eaon has a question">
        <h2 className="dialog-title">
          <MessageCircleQuestionMark size={16} aria-hidden />
          Eaon has a question
        </h2>
        <p className="dialog-summary">{pending.question}</p>
        {pending.options.length > 0 && (
          <div className="question-options">
            {pending.options.map((option) => (
              <button key={option} className="question-option" onClick={() => answer(option)}>
                {option}
              </button>
            ))}
          </div>
        )}
        <div className="question-custom">
          <input
            value={custom}
            placeholder="Or answer in your own words…"
            autoFocus={pending.options.length === 0}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") answer(custom);
            }}
          />
          <Button variant="primary" disabled={!custom.trim()} onClick={() => answer(custom)}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
