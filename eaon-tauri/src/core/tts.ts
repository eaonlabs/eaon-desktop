// Read-aloud — port of REF tts.ts (itself SpeechNarrator.swift) on the web
// SpeechSynthesis API: the OS's own voices, no network, no key. One
// utterance at a time — starting a new one stops whatever was playing.

/** Strip the markdown/tool plumbing a voice shouldn't read out loud
 *  (code fences become a spoken "(code)", links keep their label). */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether this platform can actually speak. The API object existing isn't
 *  enough: Linux WebKitGTK exposes speechSynthesis but reports zero voices
 *  when speech-dispatcher isn't installed, and Chromium-family webviews
 *  load the voice list asynchronously — so wait briefly for voiceschanged
 *  before concluding there are none. */
export function ttsAvailable(): Promise<boolean> {
  if (!("speechSynthesis" in window)) return Promise.resolve(false);
  const synth = window.speechSynthesis;
  try {
    if (synth.getVoices().length > 0) return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(synth.getVoices().length > 0);
      } catch {
        resolve(false);
      }
    };
    try {
      synth.addEventListener("voiceschanged", settle, { once: true });
    } catch {
      // Not an EventTarget on this engine — the timeout below decides.
    }
    // WebKitGTK with no voices never fires voiceschanged at all; don't
    // leave the caller's await hanging on it.
    window.setTimeout(settle, 600);
  });
}

/** Speak `text`, calling `onDone` when it finishes or is cut off. Returns
 *  false when this webview has no speech synthesis at all. */
export function speak(text: string, onDone: () => void): boolean {
  if (!("speechSynthesis" in window)) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onend = onDone;
  utterance.onerror = onDone;
  window.speechSynthesis.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
