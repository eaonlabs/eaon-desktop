const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");

chrome.storage.local.get(["token"], ({ token }) => { if (token) tokenInput.value = token; });

document.getElementById("save").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({ token });
  statusEl.textContent = "Checking…";
  try {
    let ok = false;
    for (const port of [8823, 8824, 8825, 8826, 8827]) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-eaon-token": token } });
        if (r.ok) { ok = true; break; }
      } catch { /* next port */ }
    }
    if (ok) {
      statusEl.innerHTML = '<span class="ok">Connected to Eaon.</span>';
      chrome.runtime.sendMessage({ type: "eaon-reconnect" });
    } else {
      statusEl.innerHTML = '<span class="bad">Couldn\'t reach Eaon, or the token is wrong.</span>';
    }
  } catch {
    statusEl.innerHTML = '<span class="bad">Eaon isn\'t running, or Device Control is off.</span>';
  }
});
