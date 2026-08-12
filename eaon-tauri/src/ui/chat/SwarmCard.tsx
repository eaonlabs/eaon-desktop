// The Agent Swarm discussion, as a collapsible card above the reply it
// produced.
//
// The discussion is the interesting part of this feature, so it is kept and
// shown rather than thrown away once the answer arrives — but collapsed by
// default, because the answer is what the user asked for.

import { useState } from "react";
import { ChevronRight, Users } from "lucide-react";
import type { SwarmTranscript } from "../../core/protocol/swarm";
import { MAX_ROUNDS } from "../../core/protocol/swarm";

export interface SwarmCardProps {
  transcript: SwarmTranscript;
  /** While the swarm is still running the card stays open and shows the
   *  discussion arriving; collapsing mid-run reads as a glitch. */
  isLive?: boolean;
}

export default function SwarmCard({ transcript, isLive = false }: SwarmCardProps) {
  const [open, setOpen] = useState(false);
  const expanded = isLive || open;
  const spoken = transcript.remarks.filter((r) => !r.isError);

  const summary = isLive
    ? `${transcript.personas.length} specialists · round ${Math.max(1, transcript.roundsUsed || 1)} of ${MAX_ROUNDS}`
    : transcript.endedByVote
      ? `${transcript.personas.length} specialists agreed to hand off`
      : // Never let a swarm that ran out of road look like one that agreed.
        `${transcript.personas.length} specialists · no consensus in ${MAX_ROUNDS} rounds`;

  return (
    <div className="swarm-card">
      <button
        className="swarm-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expanded}
        disabled={isLive}
      >
        <ChevronRight size={13} className={`swarm-chevron${expanded ? " open" : ""}`} aria-hidden />
        <Users size={13} aria-hidden />
        <span className="swarm-title">Agent Swarm</span>
        <span className="swarm-summary">{summary}</span>
      </button>

      {expanded && (
        <div className="swarm-body">
          {transcript.personas.length > 0 && (
            <div className="swarm-roster">
              {transcript.personas.map((p) => (
                <span key={p.name} className="swarm-chip" title={p.role}>
                  {p.name}
                </span>
              ))}
            </div>
          )}

          {spoken.map((remark, index) => (
            <div key={index} className="swarm-remark">
              <div className="swarm-remark-head">
                <span className="swarm-speaker">{remark.personaName}</span>
                <span className="swarm-round">round {remark.round}</span>
                {remark.wantsToEnd && <span className="swarm-vote">voted to hand off</span>}
              </div>
              <div className="swarm-remark-text">{remark.text}</div>
            </div>
          ))}

          {isLive && spoken.length === 0 && (
            <div className="swarm-waiting">Convening specialists…</div>
          )}
        </div>
      )}
    </div>
  );
}
