// Running an Agent Swarm: convene the roster, run the discussion rounds, and
// hand the finished transcript back. Everything routes through chatComplete on
// the SAME route the chat itself uses, so a swarm runs on whatever model the
// user picked — hosted, BYOK, or a local one. That mattered enough to shape
// the design: a feature that silently needs an account isn't a mode you can
// offer next to "Agent".

import { chatComplete } from "../core/ipc";
import {
  createPersonasPrompt,
  discussionPrompt,
  emptyTranscript,
  MAX_ROUNDS,
  MIN_PERSONAS,
  parsePersonas,
  personaSystemPrompt,
  splitVote,
  VOTES_TO_END,
  type SwarmTranscript,
} from "../core/protocol/swarm";
import { nextRequestId } from "../state/generation";
import type { ResolvedRoute } from "./modelRouting";

export interface SwarmCallbacks {
  /** Fires every time the transcript grows — after the roster is convened and
   *  after each persona speaks. A swarm can run for a minute; reporting only
   *  a single status line would waste the most interesting part of the
   *  feature by hiding it until the end. */
  onProgress?: (transcript: SwarmTranscript) => void;
  onStatus?: (status: string) => void;
  /** Checked between every call so Stop actually stops a swarm mid-round
   *  rather than after all 18 calls have been paid for. */
  isCancelled?: () => boolean;
}

async function ask(
  route: ResolvedRoute,
  messages: Array<{ role: string; content: string }>,
): Promise<string | null> {
  try {
    const raw = await chatComplete({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      trialDevice: route.trialDevice,
      trialSecret: route.trialSecret,
      trialKey: route.trialKey,
      model: route.requestModel,
      format: route.format,
      requestId: nextRequestId(),
      messages,
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/** Runs the discussion and returns the transcript. A roster that comes back
 *  too small (offline, or a model that can't follow the JSON instruction)
 *  returns a transcript with no personas, which the caller treats as "skip the
 *  swarm and answer normally" rather than staging a discussion between zero
 *  people. */
export async function runSwarm(
  task: string,
  route: ResolvedRoute,
  callbacks: SwarmCallbacks = {},
): Promise<SwarmTranscript> {
  const { onProgress, onStatus, isCancelled } = callbacks;
  const cancelled = () => isCancelled?.() === true;
  const transcript = emptyTranscript(task);

  onStatus?.("Swarm — convening specialists for this task…");
  const rosterRaw = await ask(route, [{ role: "user", content: createPersonasPrompt(task) }]);
  if (cancelled()) return transcript;
  transcript.personas = rosterRaw ? parsePersonas(rosterRaw) : [];
  onProgress?.({ ...transcript });
  if (transcript.personas.length < MIN_PERSONAS) return transcript;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (cancelled()) break;
    let endVotesThisRound = 0;

    for (const persona of transcript.personas) {
      if (cancelled()) break;
      onStatus?.(`Swarm — round ${round}: ${persona.name} is weighing in…`);
      const raw = await ask(route, [
        { role: "system", content: personaSystemPrompt(persona) },
        { role: "user", content: discussionPrompt({ task, persona, transcript, round }) },
      ]);
      if (!raw) {
        transcript.remarks.push({
          personaName: persona.name,
          round,
          text: "",
          wantsToEnd: false,
          isError: true,
        });
        onProgress?.({ ...transcript });
        continue;
      }
      const { text, wantsToEnd } = splitVote(raw);
      transcript.remarks.push({ personaName: persona.name, round, text, wantsToEnd });
      if (wantsToEnd) endVotesThisRound++;
      onProgress?.({ ...transcript });
    }

    transcript.roundsUsed = round;
    onProgress?.({ ...transcript });
    if (endVotesThisRound >= VOTES_TO_END) {
      transcript.endedByVote = true;
      break;
    }
  }

  onStatus?.("Swarm — the specialists are handing off…");
  onProgress?.({ ...transcript });
  return transcript;
}
