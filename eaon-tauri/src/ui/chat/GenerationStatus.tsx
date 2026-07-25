// The status row under the thread while a reply is in flight. It exists
// because the old indicator only covered one of the several stretches where
// the app goes quiet: it lived inside the assistant bubble, but the agent
// loop deletes that bubble when a turn is nothing but tool fences, so the
// entire tool-execution window — often the longest wait in a run — rendered
// nothing at all and read as "the model stopped responding".
//
// Living at thread level instead means it covers every gap: waiting on the
// first token (a local model loading into RAM can take a while), reasoning
// before any visible answer, and tools running between turns.

import { useGeneration, type GenerationPhase } from "../../state/generation";
import ThinkingWave from "./ThinkingWave";

/** The phase word. `tools` carries its own label from the agent loop; the
 *  rest are fixed. "Connecting" is deliberately NOT surfaced as its own
 *  word — from the user's side, a request that's open with nothing back yet
 *  is the model thinking, and flipping "Connecting"→"Thinking" a beat later
 *  is a flicker with no information in it. */
function phaseLabel(phase: GenerationPhase, label: string | null): string {
  if (phase === "tools") return label ?? "Working";
  if (phase === "responding") return "Responding";
  return "Thinking";
}

export interface GenerationStatusProps {
  conversationId: string;
  /** True when the trailing assistant bubble already shows real text — the
   *  prose and its caret are their own "responding" signal, so the row
   *  stands down rather than duplicating it. */
  hasVisibleAnswer: boolean;
}

export default function GenerationStatus({ conversationId, hasVisibleAnswer }: GenerationStatusProps) {
  const session = useGeneration((s) => s.sessions[conversationId]);
  if (!session?.streaming) return null;
  // Stopping mid-run: the loop is unwinding and nothing more will arrive, so
  // claiming "Thinking" until it finishes would be a lie.
  if (session.stopped) return null;
  if (session.phase === "responding" && hasVisibleAnswer) return null;

  return <ThinkingWave label={phaseLabel(session.phase, session.phaseLabel)} />;
}
