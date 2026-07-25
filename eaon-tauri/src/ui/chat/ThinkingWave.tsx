// The live "what's happening right now" indicator: a pulsing orb plus the
// current phase word, whose letters travel in a running wave (T rises, H
// follows, I follows…).
//
// WHY IT NEVER STUTTERS UNDER A LOCAL MODEL — the whole point of this file.
// Ollama inference pegs the CPU and the token stream re-renders the thread
// many times a second, so anything main-thread-driven visibly hitches. Three
// rules keep this smooth regardless:
//   1. Animation is pure CSS keyframes on `transform`/`opacity` only — those
//      run on the compositor, so they keep animating even while the main
//      thread is blocked. No rAF loop, no JS timer, no layout-triggering
//      property (top/margin/height) anywhere.
//   2. memo() on the label means a token storm re-rendering the parent does
//      NOT re-render these letters. A re-render that replaced the spans
//      would restart their keyframes mid-cycle — that is exactly the
//      "glitching out" this replaces.
//   3. Letter identity is keyed by index and the per-letter offset rides in
//      a CSS custom property, so even when React does re-render, the DOM
//      attributes it diffs are byte-identical and it touches nothing.

import { memo } from "react";

export interface ThinkingWaveProps {
  /** The word(s) to wave — "Thinking", "Responding", "Searching the web". */
  label: string;
}

function ThinkingWave({ label }: ThinkingWaveProps) {
  // Split on characters but keep words intact for wrapping; spaces get no
  // animation (a floating gap reads as a rendering bug, not a wave).
  const letters = [...label];

  return (
    <div className="think-wave" role="status" aria-live="polite">
      <span className="think-orb" aria-hidden />
      {/* The accessible name is the plain string — a screen reader must not
          hear the label spelled out one animated letter at a time. */}
      <span className="think-wave-text" aria-label={label}>
        {letters.map((char, index) =>
          char === " " ? (
            <span key={index} className="think-wave-space" aria-hidden>
              &nbsp;
            </span>
          ) : (
            <span
              key={index}
              className="think-wave-letter"
              style={{ ["--i" as string]: index }}
              aria-hidden
            >
              {char}
            </span>
          ),
        )}
      </span>
    </div>
  );
}

// Re-render only when the phase word itself changes. Streaming tokens move
// the parent constantly; none of that reaches the animation.
export default memo(ThinkingWave, (prev, next) => prev.label === next.label);
