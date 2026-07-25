// Image generation — the cross-platform port of ImageGeneration.swift's
// `eaon:image` tool channel. Any chat model can generate an image
// mid-conversation by emitting the fence below; the app resolves whichever
// backend the user actually has configured (a BYOK image provider, a local
// Stable Diffusion server, a local Ollama diffusion model, or Eaon's hosted
// image models) and attaches the result to the reply.

/** Mirrors ImageGenerationTool.agentInstructionBlock — only injected when
 *  the toggle is on AND a backend exists, so it's never taught uselessly. */
export const IMAGE_INSTRUCTION = `You can also generate images from a text description. Use it only when the user actually asks for an image, picture, illustration, logo, or similar visual to be created — never to illustrate a point unprompted.

To generate an image, use a fenced block with the prompt as JSON:

\`\`\`eaon:image
{"prompt": "a detailed description of the image"}
\`\`\`

Always close the fence with \`\`\` on its own line. The generated image is shown directly to the user — after it's created, just briefly confirm what you made; don't describe the image back to them as if they can't see it.`;

/** Extracts every \`\`\`eaon:image fence's prompt — same fence grammar as
 *  agent.ts's parseToolCalls, tolerant of prose-wrapped JSON. */
export function parseImagePrompts(text: string): string[] {
  const prompts: string[] = [];
  const fence = /```[^\S\n]*eaon:image[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1].trim();
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.prompt === "string" && parsed.prompt.trim()) {
        prompts.push(parsed.prompt.trim());
        continue;
      }
    } catch {
      // Not JSON — treat the raw body as the prompt (models sometimes skip
      // the JSON wrapper); empty bodies are dropped.
    }
    if (body && !body.startsWith("{")) prompts.push(body);
  }
  return prompts;
}

/** Removes the image fences from display text once their images are
 *  attached — the reply keeps its prose, loses the tool plumbing. */
export function stripImageFences(text: string): string {
  return text
    .replace(/```[^\S\n]*eaon:image[^\n]*\n[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
