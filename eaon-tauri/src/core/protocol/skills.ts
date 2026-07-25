// Port of Skill.swift + StarterSkills.swift — the SKILL.md convention (a
// `---` frontmatter block with name/description, then a markdown body used
// as the instructions), GitHub URL resolution, and the three seeded
// starter skills. Line-faithful port, not a reinterpretation, so a skill
// written for the Mac app behaves identically here.

export interface ParsedSkill {
  name: string;
  summary: string;
  instructions: string;
}

export class SkillParseError extends Error {}

/** Slugifies a frontmatter `name:` into something safe to type after `/`. */
export function normalizeSkillName(raw: string): string {
  const lowered = raw.toLowerCase().trim();
  const hyphenated = lowered.replace(/ /g, "-").replace(/_/g, "-");
  return Array.from(hyphenated)
    .filter((ch) => /[a-z0-9-]/.test(ch))
    .join("");
}

/**
 * Parses the SKILL.md convention: a leading frontmatter block delimited by
 * `---` lines with flat `key: value` pairs, then a markdown body used as-is
 * as the instructions. Deliberately not a general YAML parser — every real
 * skill keeps name/description as plain single-line scalars.
 */
export function parseSkill(text: string): ParsedSkill {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    throw new SkillParseError(
      "This doesn't look like a SKILL.md file — it needs to start with a --- frontmatter block containing name: and description: fields."
    );
  }
  const closingOffset = lines.slice(1).findIndex((l) => l.trim() === "---");
  if (closingOffset === -1) {
    throw new SkillParseError(
      "This doesn't look like a SKILL.md file — it needs to start with a --- frontmatter block containing name: and description: fields."
    );
  }

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closingOffset + 1)) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    fields[key] = value;
  }

  const rawName = fields["name"];
  if (!rawName) throw new SkillParseError("The frontmatter is missing a name: field.");
  const description = fields["description"];
  if (!description) throw new SkillParseError("The frontmatter is missing a description: field.");

  const instructions = lines
    .slice(closingOffset + 2)
    .join("\n")
    .trim();

  return { name: normalizeSkillName(rawName), summary: description, instructions };
}

/**
 * Turns a GitHub URL of almost any shape into raw-content URLs worth
 * trying, most-likely-correct first — mirrors
 * `SkillStore.candidateRawURLs`.
 */
export function candidateRawURLs(rawInput: string): string[] {
  const trimmed = rawInput.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return [];
  }

  if (url.host === "raw.githubusercontent.com") return [trimmed];
  if (url.host !== "github.com") return [];

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return [];
  const [org, repo] = segments;
  const rawURL = (branch: string, filePath: string) =>
    `https://raw.githubusercontent.com/${org}/${repo}/${branch}/${filePath}`;

  const results: string[] = [];
  if (segments.length >= 4 && (segments[2] === "blob" || segments[2] === "tree")) {
    const branch = segments[3];
    const restPath = segments.slice(4).join("/");
    if (segments[2] === "blob") {
      results.push(rawURL(branch, restPath));
    } else {
      results.push(rawURL(branch, restPath ? `${restPath}/SKILL.md` : "SKILL.md"));
      if (restPath) results.push(rawURL(branch, restPath));
    }
  } else if (segments.length === 2) {
    for (const branch of ["main", "master"]) results.push(rawURL(branch, "SKILL.md"));
  }
  return results;
}

const steelmanThenDecide = `---
name: steelman-then-decide
description: Use when asked to weigh options, pick between approaches, or answer "which should I choose" — before giving a verdict.
---

# Steelman, Then Decide

The failure mode this guards against: a wishy-washy "it depends, here are some considerations" answer that never actually recommends anything, leaving the reader to do the deciding work they came to you for.

## How to answer a "which one" question

1. **Steelman every real option first.** For each one, state the single strongest, most charitable case for it — not a strawman you'll knock down. If an option has no genuinely strong case, say so plainly instead of inventing one.
2. **Name the actual tradeoff**, not a vague list of pros and cons. Most real decisions come down to one or two variables that matter (cost vs. speed, flexibility vs. simplicity, now vs. later) — identify which ones are actually in tension here.
3. **Give a real recommendation.** Pick one, state it in the first sentence of your verdict, and say what would have to be true for a different option to be the better call instead. "X, unless Y matters more to you than Z" beats "it depends."
4. **Scale the ceremony to the stakes.** A quick, low-stakes choice gets 2-3 sentences, not a structured breakdown. Save the fuller treatment for decisions that are actually hard or consequential.

## What NOT to do

- Don't hedge the recommendation itself away with "but it really depends on your specific situation" as the last word — that undoes the whole point.
- Don't present three options as equally valid when they clearly aren't; a fair steelman doesn't mean pretending everything is close.
- Don't ask clarifying questions as a way to avoid committing to an answer when you already have enough information to give a reasonable default recommendation.`;

const explainAtTwoLevels = `---
name: explain-at-two-levels
description: Use when explaining a concept, how something works, or why something happened, especially anything technical.
---

# Explain at Two Levels

The failure mode this guards against: either a shallow one-liner that doesn't actually answer the question, or a dense technical answer that loses the reader before it gets to the point — both are common because "how deep should this go" is genuinely ambiguous without asking.

## The shape of a good explanation

1. **First, the plain-language version** — one to three sentences, no jargon, as if explaining to someone who's smart but has zero background in this specific topic. This alone should be a real, correct, useful answer on its own, not a throat-clearing preamble to the "real" explanation below it.
2. **Then, the deeper layer** — the mechanism, the "why," the edge cases, the technical vocabulary — for whoever wants to actually understand it, not just get the headline. Signal the shift clearly (a line break, "in more detail:", or similar) so a reader can stop after step 1 without feeling like they missed something.
3. **Match depth to what's actually being asked.** A quick factual question doesn't need the full two-layer treatment — this is for "how does X work" / "why did this happen" / "explain Y" questions, not "what's the capital of France."

## Calibrating the deep layer

- Prefer the concrete mechanism over abstract description — "it does X, which causes Y" beats "it handles X in a sophisticated way."
- Use an analogy only when it clarifies the actual mechanism, not just as decoration; a wrong or strained analogy is worse than none.
- If the topic has a genuinely important caveat or common misconception, that belongs in the deep layer even if it wasn't explicitly asked about.`;

const tightenMyWriting = `---
name: tighten-my-writing
description: Use when asked to edit, tighten, shorten, or improve a piece of the user's own writing.
---

# Tighten My Writing

The failure mode this guards against: an edit that's technically shorter but reads like a different person wrote it, or one that's polished but silently changes what the author actually meant.

## What to actually change

- Cut filler and hedging that doesn't carry meaning: "I think that", "sort of", "in order to", "the fact that", needless "very"/"really", throat-clearing openers ("I wanted to reach out to say that...").
- Replace a weak verb + noun pair with one strong verb where it reads more naturally that way ("make a decision about" → "decide"), but not so aggressively that it flattens the author's own rhythm.
- Cut redundant restatement — saying the same thing twice in different words.
- Fix genuine clarity problems (a sentence that has to be read twice to parse), not just stylistic preference.

## What NOT to change

- The author's actual voice and register — don't turn a casual note formal, or a direct one flowery. Match the tone that's already there.
- The actual claims or meaning. An edit that makes a sentence crisper but changes what it asserts is a bug, not an improvement — when in doubt, preserve meaning over brevity.
- Don't rewrite something that's already tight just to have made a visible change.

## How to deliver it

Give the edited version first. Then, briefly (1-3 bullets, not a paragraph per sentence), name the biggest changes made and why — enough that the author can tell what happened and push back on any of it, not a line-by-line diff.`;

export const STARTER_SKILLS: string[] = [steelmanThenDecide, explainAtTwoLevels, tightenMyWriting];
