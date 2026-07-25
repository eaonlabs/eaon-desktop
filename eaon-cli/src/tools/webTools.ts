// Web access — the gap that most limits what the agent can actually build.
// Without it the model works entirely from training-cutoff memory: it can't
// read the docs for a library it's wiring up, check an API's current shape,
// or look up an error message. Both tools are read-only (no permission
// prompt) and hardened the same way: HTTPS-preferred, redirect-capped,
// size-capped, timed out, and private/loopback addresses refused so this
// can never be turned into an internal-network scanner.

import type { ToolResult } from "../types.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 30_000;
const MAX_REDIRECTS = 5;

const USER_AGENT = "EaonCLI/1.0 (+https://eaon.dev)";

/** Blocks loopback/private/link-local hosts. A coding agent has no business
 * fetching http://192.168.x.x or http://localhost from a *web* tool — that's
 * SSRF-shaped, and anything genuinely local should go through run_shell
 * (curl) where the user can see and approve the exact command. */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  // IPv4 literals in private / loopback / link-local / CGNAT ranges.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  // IPv6 unique-local / link-local.
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
  return false;
}

function normalizeUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim().startsWith("http") ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return { error: `ERROR: "${raw}" isn't a valid URL.` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: `ERROR: only http/https URLs are supported (got ${url.protocol}).` };
  }
  if (isBlockedHost(url.hostname)) {
    return { error: `ERROR: refused — ${url.hostname} is a local/private address. Use run_shell with curl if you genuinely need to reach a local service, so the user can see the exact command.` };
  }
  return { url };
}

/** Strips a fetched HTML document down to readable text. Deliberately a
 * pragmatic scrub rather than a real DOM parse (no dependency): drop the
 * elements whose content is never prose, unwrap the rest, decode the
 * handful of entities that actually show up, and collapse whitespace. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|canvas|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Keep block structure as newlines so lists/paragraphs don't run together.
  s = s.replace(/<\/(p|div|section|article|h[1-6]|li|tr|br|hr)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => {
      const code = parseInt(d, 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    });
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/\n\s*\n\s*\n+/g, "\n\n");
  return s.trim();
}

async function fetchWithLimits(url: URL, accept: string): Promise<{ text: string; finalUrl: string; contentType: string } | { error: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: `ERROR: couldn't reach ${current.hostname}: ${message}` };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { error: `ERROR: ${current} returned ${response.status} with no redirect target.` };
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { error: `ERROR: ${current} redirected to an invalid URL (${location}).` };
      }
      // Re-check every hop: a redirect chain is the classic way to smuggle
      // a request to a blocked internal address past a one-time check.
      if (isBlockedHost(next.hostname)) {
        return { error: `ERROR: refused — the redirect chain led to a local/private address (${next.hostname}).` };
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      return { error: `ERROR: ${current} returned HTTP ${response.status} ${response.statusText}.` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const declared = parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      return { error: `ERROR: ${current} is ${(declared / 1024 / 1024).toFixed(1)}MB — too large to read.` };
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return { error: `ERROR: ${current} exceeded the ${MAX_BYTES / 1024 / 1024}MB read cap.` };
    }
    return { text: new TextDecoder("utf-8").decode(buffer), finalUrl: current.toString(), contentType };
  }
  return { error: `ERROR: too many redirects (>${MAX_REDIRECTS}) starting from ${url}.` };
}

export async function webFetch(args: Record<string, unknown>): Promise<ToolResult> {
  const raw = args.url;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { isError: true, text: 'ERROR: "url" is required.' };
  }
  const normalized = normalizeUrl(raw);
  if ("error" in normalized) return { isError: true, text: normalized.error };

  const result = await fetchWithLimits(normalized.url, "text/html,text/plain,application/json;q=0.9,*/*;q=0.8");
  if ("error" in result) return { isError: true, text: result.error };

  const isHtml = /html/i.test(result.contentType) || /^\s*<(!doctype|html)/i.test(result.text);
  const body = isHtml ? htmlToText(result.text) : result.text.trim();
  const capped = body.length > MAX_TEXT_CHARS
    ? body.slice(0, MAX_TEXT_CHARS) + `\n…(truncated at ${MAX_TEXT_CHARS} characters of ${body.length})`
    : body;
  if (capped.length === 0) {
    return { isError: false, text: `${result.finalUrl} returned no readable text (content-type: ${result.contentType || "unknown"}).` };
  }
  return { isError: false, text: `${result.finalUrl}\n\n${capped}` };
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Parses DuckDuckGo's HTML endpoint. No API key, no account, no tracking
 * cookie — the pragmatic choice for a tool that must work for every user
 * out of the box. Result markup does drift; when it does this returns
 * "no results" rather than garbage, and web_fetch still works. */
function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    let href = linkMatch[1];
    // DDG wraps results as /l/?uddg=<encoded>; unwrap to the real target.
    const wrapped = href.match(/[?&]uddg=([^&]+)/);
    if (wrapped) {
      try {
        href = decodeURIComponent(wrapped[1]);
      } catch {
        // keep the wrapped form rather than dropping the hit
      }
    }
    if (href.startsWith("//")) href = "https:" + href;
    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const title = htmlToText(linkMatch[2]);
    if (!title || !/^https?:\/\//i.test(href)) continue;
    hits.push({
      title,
      url: href,
      snippet: snippetMatch ? htmlToText(snippetMatch[1]) : "",
    });
    if (hits.length >= 10) break;
  }
  return hits;
}

export async function webSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length === 0) return { isError: true, text: 'ERROR: "query" is required.' };

  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const result = await fetchWithLimits(url, "text/html");
  if ("error" in result) return { isError: true, text: result.error };

  const hits = parseDuckDuckGoHtml(result.text);
  if (hits.length === 0) {
    return {
      isError: false,
      text: `No results parsed for "${query}". The search page may have changed shape — if you know a likely URL, read it directly with web_fetch.`,
    };
  }
  const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`);
  return {
    isError: false,
    text: [`${hits.length} result${hits.length === 1 ? "" : "s"} for "${query}":`, "", ...lines, "", "Use web_fetch on a URL above to read the full page."].join("\n"),
  };
}
