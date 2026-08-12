// The Quick Assistant panel — one question, one answer, no history.
//
// Summoned by a global hotkey from anywhere on the machine, so it is
// deliberately NOT a second copy of the chat app: no sidebar, no
// conversation list, no settings. Ask, read, dismiss. Anything that wants
// follow-up belongs in the main window.
//
// It reuses the real send path's model routing and streaming, so whichever
// model and credentials the app is configured with are what answer here —
// there is no second route to keep in sync.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sparkles, CornerDownLeft } from "lucide-react";
import { chatComplete } from "../../core/ipc";
import { CHAT_IDENTITY_PROMPT } from "../../chat/internal";
import { resolveRoute } from "../../chat/modelRouting";
import { nextRequestId } from "../../state/generation";
import { useModels } from "../../state/models";
import { hydrateReadOnly } from "../../state/persist";
import Markdown from "../chat/Markdown";

export default function QuickPanel() {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // This window mounts QuickPanel instead of App, so nothing else has loaded
  // the user's providers and keys here. Read-only on purpose — see
  // hydrateReadOnly.
  useEffect(() => {
    let disposed = false;
    void (async () => {
      await hydrateReadOnly();
      if (disposed) return;
      setReady(true);
      await Promise.allSettled([
        useModels.getState().refreshHosted(),
        useModels.getState().refreshOllama(),
      ]);
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    void invoke("quick_hide");
  }, []);

  // Refocus every time the panel is summoned, not just on first mount — the
  // window is hidden rather than destroyed, so mount happens once but the
  // panel is shown many times.
  useEffect(() => {
    const window = getCurrentWindow();
    inputRef.current?.focus();
    const unlisten = window.onFocusChanged(({ payload: focused }) => {
      if (focused) inputRef.current?.focus();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const ask = async () => {
    const text = prompt.trim();
    if (!text || busy || !ready) return;
    // The main window's live selection is session-only state that this
    // separate window cannot see, so fall back to the first model the user's
    // configuration actually offers rather than refusing to answer.
    const models = useModels.getState();
    const entry = models.entryFor(models.selectedModelKey) ?? models.entries()[0] ?? null;
    if (!entry) {
      setError("No models are set up yet — open Eaon and add a provider first.");
      return;
    }
    setBusy(true);
    setError(null);
    setAnswer("");
    try {
      const route = await resolveRoute(entry);
      if ("error" in route) {
        setError(route.error);
        return;
      }
      const reply = await chatComplete({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        trialDevice: route.trialDevice,
        trialSecret: route.trialSecret,
        trialKey: route.trialKey,
        model: route.requestModel,
        format: route.format,
        requestId: nextRequestId(),
        messages: [
          { role: "system", content: CHAT_IDENTITY_PROMPT },
          // The panel is for quick answers, so ask for one explicitly —
          // without this a chat-tuned model writes three paragraphs into a
          // 460px window.
          { role: "system", content: "Answer briefly and directly. A few sentences at most unless the question genuinely needs more." },
          { role: "user", content: text },
        ],
      });
      setAnswer(reply.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick-root">
      <div className="quick-drag" data-tauri-drag-region />
      <div className="quick-input-row">
        <Sparkles size={15} className="quick-spark" aria-hidden />
        <textarea
          ref={inputRef}
          className="quick-input"
          rows={1}
          placeholder="Ask Eaon…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <button
          className="quick-send"
          onClick={() => void ask()}
          disabled={busy || !prompt.trim()}
          aria-label="Ask"
        >
          <CornerDownLeft size={14} />
        </button>
      </div>

      {(busy || answer || error) && (
        <div className="quick-answer">
          {busy && !answer && <div className="quick-thinking">Thinking…</div>}
          {error && <div className="quick-error">{error}</div>}
          {answer && <Markdown content={answer} />}
        </div>
      )}

      <div className="quick-hint">
        <kbd>Esc</kbd> to dismiss
      </div>
    </div>
  );
}
