// Live generation state — one session per conversation so a background chat
// keeps streaming when the user switches away, plus the pause points where
// an agent turn waits on the user (tool confirmation / ask_user).

import { create } from "zustand";
import type { SwarmTranscript } from "../core/protocol/swarm";

/** What the model is actually doing right now — drives the status indicator
 *  under the thread, so a long silent stretch (a local model loading into
 *  RAM, a slow reasoning pass, a tool call running) never reads as "it
 *  stopped responding".
 *
 *  - `connecting`  request open, nothing back yet
 *  - `thinking`    reasoning tokens arriving, no visible answer yet
 *  - `responding`  visible answer streaming (the prose itself is the signal)
 *  - `tools`       between turns, executing search / plugins / agent tools */
export type GenerationPhase = "connecting" | "thinking" | "responding" | "tools";

export interface GenerationSession {
  requestId: number;
  streaming: boolean;
  /** Set by stopGeneration so a multi-step agent turn breaks its loop
   *  instead of only cancelling the current stream. */
  stopped: boolean;
  phase: GenerationPhase;
  /** What `tools` is doing, in the user's words ("Searching the web") —
   *  null for every other phase, which speaks for itself. */
  phaseLabel: string | null;
}

/** A tool call paused for the user's go-ahead (Sandboxed mode) — resolved
 *  by the confirmation dialog. */
export interface PendingToolConfirm {
  conversationId: string;
  summary: string;
  detail: string | null;
  resolve: (decision: "once" | "always" | "deny") => void;
}

/** An ask_user question the agent paused on. */
export interface PendingAgentQuestion {
  conversationId: string;
  question: string;
  options: string[];
  resolve: (answer: string) => void;
}

let requestCounter = 1;
export function nextRequestId(): number {
  return requestCounter++;
}

interface GenerationStore {
  sessions: Record<string, GenerationSession>;
  pendingConfirm: PendingToolConfirm | null;
  pendingQuestion: PendingAgentQuestion | null;
  /** Agent mode's Sandboxed(false)/Auto(true) switch — never persisted;
   *  resets to Sandboxed every launch on purpose. */
  agentAutoRun: boolean;
  askingToEnterAuto: boolean;

  begin: (conversationId: string, requestId: number) => void;
  end: (conversationId: string) => void;
  markStopped: (conversationId: string) => void;
  isStreaming: (conversationId: string | null) => boolean;
  /** Idempotent by design — the streaming hot path calls this per token, and
   *  an unchanged phase must not write to the store (a re-render per token
   *  is exactly the jank this indicator exists to avoid). */
  setPhase: (conversationId: string, phase: GenerationPhase, label?: string | null) => void;

  /** The swarm discussion as it happens, per conversation, so the panel can
   *  show who has spoken and how they voted while it runs. Cleared when the
   *  swarm hands off — from then on the finished transcript lives in the
   *  assistant message itself. */
  liveSwarm: Record<string, SwarmTranscript | null>;
  setSwarm: (conversationId: string, transcript: SwarmTranscript | null) => void;

  setPendingConfirm: (pending: PendingToolConfirm | null) => void;
  setPendingQuestion: (pending: PendingAgentQuestion | null) => void;
  setAgentAutoRun: (on: boolean) => void;
  setAskingToEnterAuto: (asking: boolean) => void;
}

export const useGeneration = create<GenerationStore>((set, get) => ({
  sessions: {},
  pendingConfirm: null,
  pendingQuestion: null,
  agentAutoRun: false,
  liveSwarm: {},
  askingToEnterAuto: false,

  begin: (conversationId, requestId) =>
    set((s) => ({
      sessions: {
        ...s.sessions,
        [conversationId]: {
          requestId,
          streaming: true,
          stopped: false,
          phase: "connecting",
          phaseLabel: null,
        },
      },
    })),

  end: (conversationId) =>
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[conversationId];
      return { sessions };
    }),

  markStopped: (conversationId) =>
    set((s) => {
      const session = s.sessions[conversationId];
      if (!session) return s;
      return {
        sessions: {
          ...s.sessions,
          [conversationId]: { ...session, stopped: true },
        },
      };
    }),

  isStreaming: (conversationId) =>
    conversationId != null && get().sessions[conversationId]?.streaming === true,

  setPhase: (conversationId, phase, label = null) =>
    set((s) => {
      const session = s.sessions[conversationId];
      // No session (already ended) or nothing actually changed → no write,
      // so subscribers don't re-render.
      if (!session) return s;
      if (session.phase === phase && session.phaseLabel === label) return s;
      return {
        sessions: {
          ...s.sessions,
          [conversationId]: { ...session, phase, phaseLabel: label },
        },
      };
    }),

  setSwarm: (conversationId, transcript) =>
    set((s) => ({ liveSwarm: { ...s.liveSwarm, [conversationId]: transcript } })),

  setPendingConfirm: (pendingConfirm) => set({ pendingConfirm }),
  setPendingQuestion: (pendingQuestion) => set({ pendingQuestion }),
  setAgentAutoRun: (agentAutoRun) => set({ agentAutoRun }),
  setAskingToEnterAuto: (askingToEnterAuto) => set({ askingToEnterAuto }),
}));
