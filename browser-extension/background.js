// Eaon Browser Control — service worker.
//
// Long-polls the Eaon desktop app for a command, runs it against the active
// tab, and posts the result back. Long-polling (rather than a WebSocket) keeps
// the desktop side to plain HTTP; see BrowserBridge.swift for why that
// tradeoff was made deliberately.
//
// Everything the page-side work needs is injected per call via
// chrome.scripting.executeScript, so there's no persistent content script
// sitting in every tab you open.

// Eaon tries these in order; a stray server on one shouldn't break pairing.
const PORTS = [8823, 8824, 8825, 8826, 8827];
let base = null;
let running = false;

async function findBase(key) {
  if (base) return base;
  for (const port of PORTS) {
    const candidate = `http://127.0.0.1:${port}`;
    try {
      const r = await fetch(`${candidate}/health`, { headers: { "x-eaon-token": key } });
      if (r.ok) { base = candidate; return base; }
    } catch { /* next */ }
  }
  return null;
}

async function token() {
  const { token } = await chrome.storage.local.get(["token"]);
  return token || "";
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// Pages no extension may touch. Chrome blocks script injection into its own
// internal pages outright, and the failure is an opaque "Cannot access
// contents of the page" — which reads like the extension is broken when it's
// actually working exactly as designed. Naming the real reason turns a dead
// end into a one-second fix.
const RESTRICTED = /^(chrome|edge|brave|vivaldi|opera|about|devtools|view-source|chrome-extension|moz-extension|file):/i;

async function usableTab() {
  const tab = await activeTab();
  if (!tab) throw new Error("No active tab.");
  const url = tab.url || "";
  if (!url || RESTRICTED.test(url)) {
    const scheme = (url.split(":")[0] || "unknown") + "://";
    throw new Error(
      `Can't act on "${tab.title || url}". Browsers forbid extensions from running on internal ${scheme} pages, ` +
      `so this tab can't be read or scrolled. Switch to a normal web page and try again.`
    );
  }
  if (url.startsWith("https://chromewebstore.google.com") || url.startsWith("https://chrome.google.com/webstore")) {
    throw new Error("Can't act on the Chrome Web Store — it blocks extensions by policy. Switch to another tab.");
  }
  return tab;
}

// --- the code that actually runs inside the page ---------------------------

function pageAction(action, params) {
  const clickableSelector =
    "a,button,input[type=submit],input[type=button],[role=button],[role=link],[onclick],summary";

  const visibleText = (el) =>
    ((el.innerText || el.value || el.getAttribute("aria-label") || el.title || "") + "")
      .trim()
      .toLowerCase();

  switch (action) {
    case "read": {
      const limit = params.maxCharacters || 6000;
      const text = document.body ? document.body.innerText.replace(/\n{3,}/g, "\n\n") : "";
      return `${document.title}\n${location.href}\n\n--- page text ---\n${text.slice(0, limit)}`;
    }
    case "scroll": {
      const dir = (params.direction || "down").toLowerCase();
      const pages = Math.max(1, Math.min(params.pages || 1, 20));
      // Scroll whichever element actually scrolls — many apps scroll an inner
      // pane, not the document, and window.scrollBy silently does nothing there.
      const scroller =
        [document.scrollingElement, ...document.querySelectorAll("main,[role=main],div")]
          .filter(Boolean)
          .find((el) => el.scrollHeight > el.clientHeight + 40) || document.scrollingElement;
      if (dir === "top") scroller.scrollTo({ top: 0, behavior: "smooth" });
      else if (dir === "bottom") scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
      else {
        const delta = scroller.clientHeight * 0.85 * pages * (dir === "up" ? -1 : 1);
        scroller.scrollBy({ top: delta, behavior: "smooth" });
      }
      // Return the newly visible text too. A second round trip is where
      // weaker models give up ("I can't interact with the browser"), and the
      // text is what they wanted from the scroll anyway.
      const seen = (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n");
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      return (
        `Scrolled ${dir}. Position ${Math.round(scroller.scrollTop)} of ${scroller.scrollHeight}` +
        `${atEnd ? " (bottom of page)" : ""}.\n\n--- visible now ---\n` +
        seen.slice(0, 4000)
      );
    }
    case "click": {
      const needle = (params.text || "").trim().toLowerCase();
      if (!needle) return "ERROR: no text given";
      for (const el of document.querySelectorAll(clickableSelector)) {
        const label = visibleText(el);
        if (label && label.includes(needle)) {
          el.scrollIntoView({ block: "center" });
          el.click();
          return `Clicked: ${label.slice(0, 120)}`;
        }
      }
      return "ERROR: nothing clickable matched that text";
    }
    case "type": {
      const needle = (params.field || "").trim().toLowerCase();
      const value = params.text || "";
      let el = null;
      if (!needle) el = document.activeElement;
      else {
        for (const candidate of document.querySelectorAll("input,textarea,[contenteditable=true]")) {
          const label = ((candidate.placeholder || candidate.name ||
            candidate.getAttribute("aria-label") || candidate.id || "") + "").toLowerCase();
          if (label && label.includes(needle)) { el = candidate; break; }
        }
      }
      if (!el) return "ERROR: no field matched";
      el.focus();
      if (el.isContentEditable) el.textContent = value; else el.value = value;
      // React and friends listen for these; setting .value alone is invisible.
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return `Typed into ${(el.placeholder || el.name || el.tagName)}`;
    }
    case "links": {
      const out = [];
      for (const a of document.querySelectorAll("a[href]")) {
        const label = (a.innerText || "").trim();
        if (label) out.push(`${label.slice(0, 80)} -> ${a.href}`);
        if (out.length >= 60) break;
      }
      return out.join("\n") || "No links found.";
    }
    default:
      return `ERROR: unknown action ${action}`;
  }
}

// --- command dispatch ------------------------------------------------------

async function run(command) {
  const { action, params = {} } = command;

  if (action === "tabs") {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    return tabs.map((t) => `${t.title} -> ${t.url}`).join("\n");
  }
  if (action === "navigate") {
    const tab = await activeTab();
    await chrome.tabs.update(tab.id, { url: params.url });
    return `Opened ${params.url}`;
  }

  const tab = await usableTab();
  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageAction,
      args: [action, params],
    });
  } catch (error) {
    // Surface the browser's own reason rather than a bare stack — injection
    // fails for genuinely different causes (page still loading, protected
    // origin, tab discarded) that need different responses.
    throw new Error(`Couldn't run on "${tab.title || tab.url}": ${error.message}`);
  }
  const result = frames && frames[0] ? frames[0].result : undefined;
  if (result === undefined || result === null) {
    throw new Error("The page returned nothing — it may still be loading. Try again in a moment.");
  }
  if (typeof result === "string" && result.startsWith("ERROR:")) {
    throw new Error(result.slice(6).trim());
  }
  return result;
}

async function loop() {
  if (running) return;
  running = true;
  while (running) {
    const key = await token();
    if (!key) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    try {
      const root = await findBase(key);
      if (!root) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      const tab = await activeTab();
      const response = await fetch(`${root}/poll`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eaon-token": key },
        body: JSON.stringify({ tab: tab ? `${tab.title} — ${tab.url}` : "" }),
      });
      if (!response.ok) { base = null; await new Promise((r) => setTimeout(r, 3000)); continue; }
      const command = await response.json();
      if (!command || command.action === "none") continue;

      let payload;
      try {
        payload = { id: command.id, result: String(await run(command)) };
      } catch (error) {
        payload = { id: command.id, error: String(error.message || error) };
      }
      await fetch(`${base}/result`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eaon-token": key },
        body: JSON.stringify(payload),
      });
    } catch {
      // Eaon closed or Device Control switched off — forget the port so the
      // next attempt rediscovers it, then back off.
      base = null;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(loop);
chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === "eaon-reconnect") loop(); });
loop();
