// Reveals streaming assistant text character-by-character instead of
// flashing in whole chunks, without ever visibly lagging behind a fast or
// bursty stream: reveal speed scales with how far behind the target we are,
// so a big chunk (or a slow tick) snap-accelerates and closes the gap in a
// fraction of a second rather than becoming a bottleneck.

import { useEffect, useRef, useState } from "react";

const BASE_CPS = 260;
/** Any backlog closes within ~120ms at this rate, however large the chunk. */
const CATCH_UP_WINDOW_SECONDS = 0.12;
const MAX_FRAME_DELTA_MS = 100;

/** `live` is read once at mount: a message that is already-complete history
 *  (loaded from disk, scrolled into view, revisited via search) renders
 *  instantly and never replays the animation. Only a message that is truly
 *  streaming when its bubble first appears ever animates — including a
 *  regenerate of that same bubble, since the component instance persists. */
export function useTypewriter(target: string, live: boolean): string {
  const wasLiveRef = useRef(live);
  const [shown, setShown] = useState(() => (wasLiveRef.current ? "" : target));
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number | null>(null);

  useEffect(() => {
    if (!wasLiveRef.current) {
      setShown(target);
      return;
    }
    // Target shrank — an edit/regenerate reset the message, not new tokens.
    // Snap to it instead of "deleting" backwards a character at a time.
    if (target.length < shownRef.current.length) setShown(target);
    if (shownRef.current === target) return;

    const step = (now: number) => {
      // Already caught up — stop polling. The effect re-runs (and restarts
      // this loop) the moment `target` grows again, since it's the dep.
      if (shownRef.current.length >= target.length) return;

      const last = lastRef.current ?? now;
      const dt = Math.min(now - last, MAX_FRAME_DELTA_MS);
      lastRef.current = now;

      setShown((prev) => {
        if (prev.length >= target.length) return prev;
        const behind = target.length - prev.length;
        const cps = Math.max(BASE_CPS, behind / CATCH_UP_WINDOW_SECONDS);
        const chars = Math.max(1, Math.round((cps * dt) / 1000));
        return target.slice(0, Math.min(target.length, prev.length + chars));
      });

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastRef.current = null;
    };
  }, [target]);

  return wasLiveRef.current ? shown : target;
}
