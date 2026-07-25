// A reasoning model's chain-of-thought, tucked behind a quiet disclosure.
// Collapsed by default, settling to a past-tense caption once visible
// content starts.
//
// While the model is still working this deliberately does NOT animate or say
// "Thinking…": the thread-level status row (GenerationStatus) owns that word
// and its wave, and two "Thinking" indicators stacked a few pixels apart read
// as a rendering bug. This one names what's inside — press to watch the
// reasoning live — and lets the status row carry the state.

import { useState } from "react";
import { ChevronRight } from "lucide-react";

export interface ThinkingDisclosureProps {
  reasoning: string;
  /** True while this message is streaming with no visible content yet. */
  thinking: boolean;
}

export default function ThinkingDisclosure({ reasoning, thinking }: ThinkingDisclosureProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="thinking">
      <button
        className="think-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={"think-chevron" + (open ? " open" : "")} aria-hidden>
          <ChevronRight size={11} strokeWidth={2.4} />
        </span>
        <span>{thinking ? "Reasoning" : "Thought for a moment"}</span>
      </button>
      {open && (
        <div className="think-body" data-selectable>
          {reasoning}
        </div>
      )}
    </div>
  );
}
