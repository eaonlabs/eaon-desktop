// The EAON wordmark — figlet "banner3" block-pixel letters, baked in so
// end users never need figlet. Regenerate with:
//   figlet -f banner3 EAON
// Then replace `#` with `█` (U+2588 FULL BLOCK). Colored at render time
// by Wordmark.tsx (coral banded gradient + drop shadow).

export const EAON_WORDMARK: readonly string[] = [
  "████████    ███     ███████  ██    ██ ",
  "██         ██ ██   ██     ██ ███   ██ ",
  "██        ██   ██  ██     ██ ████  ██ ",
  "██████   ██     ██ ██     ██ ██ ██ ██ ",
  "██       █████████ ██     ██ ██  ████ ",
  "██       ██     ██ ██     ██ ██   ███ ",
  "████████ ██     ██  ███████  ██    ██ ",
];

/** Art width plus one column for the drop-shadow extrusion. */
export const EAON_WORDMARK_WIDTH = 39;

/** Art height plus one row for the drop-shadow extrusion. */
export const EAON_WORDMARK_HEIGHT = 8;

export function isWordmarkBlock(ch: string): boolean {
  return ch === "█" || ch === "#";
}
