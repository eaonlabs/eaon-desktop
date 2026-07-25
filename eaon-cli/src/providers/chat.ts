// The one streaming chat primitive every provider (Aqua, BYOK, Ollama)
// shares — same "one OpenAI-compatible path serves everything" design as
// the Tauri Rust core's chat_stream, extended with native tool-calling
// (tool_calls deltas), which the Rust core doesn't do yet. Uses the
// platform fetch/ReadableStream directly — no HTTP dependency needed.

import type { ChatRequestOptions, ChatStreamEvent, Turn } from "../types.js";

/** Turns an HTTP failure into something the user can act on.
 *
 * A bare "Server returned 401: {detail: Missing or invalid API Key}" sent a
 * real user hunting through their shell config for an env var that was set
 * correctly all along — the actual problem was the key being valid for a
 * different Eaon host. Auth failures now name the host that rejected the
 * key and the key style it saw, because that pair is the whole diagnosis. */
export function describeHttpFailure(status: number, body: string, url: string, apiKey: string | null): string {
  const detail = body.trim().slice(0, 300);
  if (status !== 401 && status !== 403) {
    return `Server returned ${status}${detail ? `: ${detail}` : ""}`;
  }

  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the raw url if it somehow isn't parseable
  }

  const key = (apiKey ?? "").trim();
  const lines = [`${host} rejected the API key (${status}).`];

  if (key.length === 0) {
    lines.push("No key was sent. Set one with /link, or export EAON_AQUA_API_KEY.");
  } else if (host.includes("aquadevs.com") && key.toLowerCase().startsWith("sk-eaon-")) {
    // The exact mix-up this message exists for.
    lines.push("That looks like an Eaon account key (sk-eaon-…), which belongs to api.eaon.dev, not this host.");
    lines.push("Eaon should route it automatically — if you're seeing this, the key may be incomplete.");
  } else if (host.includes("eaon.dev") && !key.toLowerCase().startsWith("sk-eaon-")) {
    lines.push("Eaon account keys start with sk-eaon-. This key looks like it belongs to a different provider.");
  } else {
    lines.push(`The key it sent starts with "${key.slice(0, 8)}" and is ${key.length} characters long — check it's complete and hasn't been revoked.`);
  }

  if (detail) lines.push(`Server said: ${detail}`);
  return lines.join("\n");
}

function turnToMessage(t: Turn): Record<string, unknown> {
  const msg: Record<string, unknown> = { role: t.role, content: t.content };
  if (t.toolCalls && t.toolCalls.length > 0) {
    msg.tool_calls = t.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (t.toolCallId) msg.tool_call_id = t.toolCallId;
  if (t.name) msg.name = t.name;
  return msg;
}

/** Streams one chat turn: token, reasoning, tool-call, done, and error
 * events. The caller (the agent loop) owns accumulating tool-call fragments
 * into complete calls, since it needs to track that alongside display state
 * anyway. Always stops after a `done` or `error` event.
 *
 * Branches on `opts.format` — Aqua and Ollama are always OpenAI-compatible;
 * a BYOK custom provider can be any of the three (mirrors the Mac app's
 * `CustomProviderAPIService.streamCompletion`). Anthropic Messages and
 * Google Gemini don't get native tool-calling here, same as the Mac app —
 * their tool_use wire shape is different enough that it isn't worth a
 * second whole tool-calling implementation for the CLI's one text-fence
 * fallback to already cover. */
export async function* streamChat(opts: ChatRequestOptions): AsyncGenerator<ChatStreamEvent, void, void> {
  if (opts.format === "anthropicMessages") {
    yield* streamAnthropicMessages(opts);
    return;
  }
  if (opts.format === "googleGemini") {
    yield* streamGoogleGemini(opts);
    return;
  }

  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.turns.map(turnToMessage),
    stream: true,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      yield { type: "done", finishReason: "cancelled" };
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    yield { type: "error", message: `Couldn't reach the model server at ${url}. Is it running? (${message})` };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    yield { type: "error", message: describeHttpFailure(response.status, text, url, opts.apiKey), status: response.status };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: "error", message: "No response body from the model server." };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const started = new Set<number>();
  let finishReason: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data.length === 0) continue;
        if (data === "[DONE]") {
          yield { type: "done", finishReason };
          return;
        }
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = json?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "token", text: delta.content };
        }
        const reasoning = typeof delta.reasoning === "string"
          ? delta.reasoning
          : typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : undefined;
        if (reasoning) {
          yield { type: "reasoning", text: reasoning };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = typeof tc.index === "number" ? tc.index : 0;
            const fn = tc.function ?? {};
            if (!started.has(index)) {
              started.add(index);
              yield { type: "tool_call_start", index, id: typeof tc.id === "string" && tc.id ? tc.id : `call_${index}`, name: typeof fn.name === "string" ? fn.name : "" };
            }
            if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
              yield { type: "tool_call_delta", index, argumentsFragment: fn.arguments };
            }
          }
        }
        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
      }
    }
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      yield { type: "done", finishReason: "cancelled" };
      return;
    }
    yield { type: "error", message: `Stream interrupted: ${e instanceof Error ? e.message : String(e)}` };
    return;
  }

  yield { type: "done", finishReason };
}

/** A turn's plain text as fed to a format with no "tool" role of its own
 * (Anthropic Messages, Google Gemini) — a real tool result (from either
 * native tool-calling or the text-fence fallback; the agent loop pushes
 * the same `role: "tool"` turn either way) becomes a clearly labeled
 * user-role message instead of being dropped, since these two formats
 * only ever see fence-based calls in the first place (see `streamChat`'s
 * own doc comment on why native tools aren't sent for them). */
function plainTextFor(t: Turn): string {
  if (t.role === "tool") return `[Tool result${t.name ? `: ${t.name}` : ""}]\n${t.content}`;
  return t.content;
}

async function* readSSELines(response: Response): AsyncGenerator<string, void, void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

/** Anthropic's native Messages API — `POST {base}/messages` with
 * `x-api-key`/`anthropic-version` headers, `system` as its own top-level
 * field (not a message role), and content-delta SSE events. Ported from
 * the Mac app's `CustomProviderAPIService.streamAnthropicMessages` —
 * implemented against Anthropic's public docs, not live-tested against a
 * real key here either, so a genuine shape change on their end would
 * surface as a clear error rather than a silent mis-render. */
async function* streamAnthropicMessages(opts: ChatRequestOptions): AsyncGenerator<ChatStreamEvent, void, void> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/messages`;
  const systemText = opts.turns.filter((t) => t.role === "system").map((t) => t.content).join("\n\n");
  const messages = opts.turns.filter((t) => t.role !== "system").map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: plainTextFor(t) }));

  const body: Record<string, unknown> = { model: opts.model, max_tokens: 4096, messages, stream: true };
  if (systemText.length > 0) body.system = systemText;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": opts.apiKey ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      yield { type: "done", finishReason: "cancelled" };
      return;
    }
    yield { type: "error", message: `Couldn't reach ${url}: ${e instanceof Error ? e.message : String(e)}` };
    return;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    yield { type: "error", message: describeHttpFailure(response.status, text, url, opts.apiKey ?? null), status: response.status };
    return;
  }

  try {
    for await (const payload of readSSELines(response)) {
      if (payload.length === 0) continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.type === "content_block_delta" && typeof json.delta?.text === "string") {
        yield { type: "token", text: json.delta.text };
      } else if (json.type === "message_stop") {
        break;
      }
    }
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      yield { type: "done", finishReason: "cancelled" };
      return;
    }
    yield { type: "error", message: `Stream interrupted: ${e instanceof Error ? e.message : String(e)}` };
    return;
  }
  yield { type: "done", finishReason: null };
}

/** Google's native Gemini API — `POST {base}/models/{id}:streamGenerateContent?alt=sse`
 * with the API key as a query param, "user"/"model" roles (no system
 * role — folded into the front of the first user turn instead), and
 * `candidates[0].content.parts[0].text` per SSE chunk. Ported from the Mac
 * app's `CustomProviderAPIService.streamGoogleGemini`, same caveat as
 * Anthropic above (implemented from docs, not live-tested here). */
async function* streamGoogleGemini(opts: ChatRequestOptions): AsyncGenerator<ChatStreamEvent, void, void> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/models/${encodeURIComponent(opts.model)}:streamGenerateContent?key=${encodeURIComponent(opts.apiKey ?? "")}&alt=sse`;

  const systemText = opts.turns.filter((t) => t.role === "system").map((t) => t.content).join("\n\n");
  const contents = opts.turns
    .filter((t) => t.role !== "system")
    .map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: plainTextFor(t) }] }));
  if (systemText.length > 0 && contents.length > 0) {
    contents[0].parts[0].text = `${systemText}\n\n${contents[0].parts[0].text}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      yield { type: "done", finishReason: "cancelled" };
      return;
    }
    yield { type: "error", message: `Couldn't reach ${url}: ${e instanceof Error ? e.message : String(e)}` };
    return;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    yield { type: "error", message: describeHttpFailure(response.status, text, url, opts.apiKey ?? null), status: response.status };
    return;
  }

  try {
    for await (const payload of readSSELines(response)) {
      if (payload.length === 0) continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text === "string" && text.length > 0) {
        yield { type: "token", text };
      }
    }
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      yield { type: "done", finishReason: "cancelled" };
      return;
    }
    yield { type: "error", message: `Stream interrupted: ${e instanceof Error ? e.message : String(e)}` };
    return;
  }
  yield { type: "done", finishReason: null };
}
