# Publishing Eaon Browser Control to the Chrome Web Store

Everything the Chrome Web Store developer dashboard asks for, ready to paste,
plus the steps to get it published. This file lives in the repo for the
publisher; `scripts/pack-extension.mjs` leaves it out of the uploaded zip.

---

## 1. One-time setup (about 15 minutes, $5)

1. Sign in to the Google account that should own the listing. Use one you will
   keep: the listing can be moved to a group publisher later, but not easily
   to another personal account.
2. Turn on 2-Step Verification for that account
   (<https://myaccount.google.com/signinoptions/two-step-verification>). The
   dashboard will not let you publish without it.
3. Open the developer dashboard: <https://chrome.google.com/webstore/devconsole>.
4. Accept the developer agreement and **pay the one-time $5 registration fee**
   (card payment through Google). It is paid once per account, not per
   extension and not per year.
5. In **Account**, fill in the publisher name ("Eaon" or "Eaon Labs"), a
   contact email, and verify that email. Declare whether you are a trader
   (EU Digital Services Act). A free extension from an individual is usually
   "non-trader"; a company distributing it is a trader and must add an
   address and phone number that are shown publicly.

## 2. Build the upload

```sh
node scripts/pack-extension.mjs
# → dist/eaon-browser-extension-<version>.zip (1.1.0 at the time of writing)
```

The script refuses to pack if the manifest has problems the store would
reject (a `key` field, a description over 132 characters, a missing 128 px
icon, code evaluated at runtime).

Before uploading, load `extension/` unpacked in Chrome, pair it with Eaon and
run a Work task that uses the browser, so you know the exact build you are
submitting works.

## 3. Create the item

Dashboard → **Items** → **New item** → upload the zip. Then fill in each tab.

### Store listing

**Name** (from the manifest)

> Eaon Browser Control

**Summary** (from the manifest, 132 characters max)

> Lets the agent in the Eaon desktop app use Chrome for you: open pages, read them, click, type and take screenshots.

**Description**

> Eaon Browser Control connects Chrome to the Eaon desktop app, so the agent in Eaon's Work mode can use the web for you: look things up, fill in forms, compare pages and check what a site actually shows.
>
> How it works
> • Install the extension, open Eaon → Settings → Browser extension, and type the pairing code into the extension's popup. That's the whole setup.
> • When a Work task needs the browser, the agent opens its own tabs in an "Eaon" tab group. It reads pages as a compact list of links, buttons and fields, and acts on them by clicking, typing, choosing options and scrolling. It can take a screenshot when the layout matters.
> • A blue outline and an "Eaon is using this tab" bar show you which tab is being controlled. Press Stop there, or "Stop agent control" in the popup, and it stops immediately.
>
> You stay in control
> • The agent only sees tabs in the Eaon group. Your other tabs are invisible to it unless you share one from the popup.
> • Eaon asks for your approval before actions, and always before anything that looks like a purchase, a payment, sending a message, deleting something, or typing a password or card number.
> • The extension talks only to the Eaon app on your own computer, over a local connection (127.0.0.1). It has no server, no account and no analytics.
>
> Requires the Eaon desktop app for macOS or Windows: https://github.com/eaonlabs/eaon-desktop/releases

**Category**: Productivity → Tools (Workflow & Planning also fits)

**Language**: English

**Graphics**

| Asset | Size | What to use |
|---|---|---|
| Store icon | 128×128 PNG | `extension/icons/icon-128.png` (already padded to the store's 96 px artwork + 16 px margin) |
| Screenshots (1–5, at least one required) | 1280×800 or 640×400, PNG or JPEG, no transparency | see below |
| Small promo tile | 440×280 | Eaon logo on the brand orange with "Browser control for Eaon". Optional, but items without one are rarely featured |
| Marquee promo tile | 1400×560 | Optional; only needed if Google features the item |

Screenshots to take (use a clean Chrome profile, light or dark consistently,
no personal tabs or bookmarks visible, window sized so the capture is
exactly 1280×800):

1. **The agent at work**: a real site in an "Eaon" tab group with the blue
   outline and the "Eaon is using this tab · Stop" bar visible, next to the
   Eaon app showing the task. This is the one that explains the product.
2. **Pairing**: the popup's "Pair with the Eaon app" view beside Eaon →
   Settings → Browser extension showing the code.
3. **Connected popup**: "Connected", the agent's tab, "Share this tab with
   Eaon" and "Stop agent control".
4. **Approval**: Eaon asking to approve a click on something like "Place
   order", to show risky actions are confirmed.

Captions, if you add them, say what the user gets ("Stop the agent from any
tab") rather than naming features.

### Privacy

**Single purpose**

> Lets the Eaon desktop app's AI agent operate web pages in Chrome on the user's behalf — opening pages, reading their content, clicking, typing and taking screenshots — in tabs the user can see and stop at any time.

**Permission justifications** (the form has one box per permission)

| Permission | Justification to paste |
|---|---|
| `scripting` | The agent reads and operates web pages: the extension injects its script into the tab the agent is working in to list the page's links, buttons and fields, and to click, type, select and scroll. The script is injected only into tabs in the agent's "Eaon" tab group or tabs the user explicitly shared, and only when the agent acts on them. It is never injected into other tabs. |
| `tabGroups` | Every tab the agent opens is placed in a tab group titled "Eaon" so the user can see at a glance which tabs the agent is using. Membership of that group is also how the extension decides which tabs the agent may touch. |
| `storage` | Stores the pairing token that lets the extension reconnect to the Eaon app on the same computer, the connection port, and, for the current browser session only, which tabs belong to the agent and which the user has shared. Nothing is synced or sent anywhere. |
| `contextMenus` | Adds "Ask Eaon about this page", "Ask Eaon about “selection”" and "Send link to Eaon" to the right-click menu. Choosing one sends that page's address and title, the selected text, or the link to the Eaon app on the same computer, where it becomes a draft in a new chat for the user to finish and send. Nothing is sent unless the user picks one of these items. |
| `alarms` | While the Eaon app is closed the extension's service worker is suspended. A 30-second alarm wakes it to reconnect, so browser control works again as soon as the user opens Eaon, without them having to click anything. |
| Host permission `<all_urls>` | The user asks the agent to work on whatever website their task needs, which cannot be known in advance. Host access is required to inject the page script into those tabs and to capture a screenshot of the visible tab (`tabs.captureVisibleTab`). The extension uses it only on tabs in the agent's "Eaon" tab group or tabs the user explicitly shared from the popup. |

**Remote code**: No, I am not using remote code. (All JavaScript is in the
package. The extension receives instructions from the local app, such as
"click element 12", but never code.)

**Data usage**: tick

- **Website content**: the text, links, form fields and screenshots of pages
  in the tabs the agent works in.
- **Web history**: the URLs and titles of the tabs the agent works in.

Nothing else (no personally identifiable info, health, financial, auth,
personal communications, location or user activity is collected by the
extension itself). If a page the agent reads contains such information, it
is covered by "Website content" above.

Then certify all three statements: data is not sold to third parties, not
used or transferred for purposes unrelated to the single purpose, and not
used to determine creditworthiness or for lending.

**Privacy policy URL**: host the policy below at a public URL and paste it
here. The simplest option is to commit it as a page in the public repo, e.g.
`https://github.com/eaonlabs/eaon-desktop/blob/main/PRIVACY-extension.md`, or
a GitHub Pages / website page.

### Distribution

- **Visibility**: Public. (Unlisted also works if you only want people with
  the link from Eaon's Settings to find it.)
- **Regions**: All regions.
- **Pricing**: Free.

### Test instructions (shown only to the reviewer)

> This extension requires the free Eaon desktop app, which provides the AI agent that controls the browser.
> 1. Install Eaon for macOS or Windows from https://github.com/eaonlabs/eaon-desktop/releases and add any model provider API key in Settings → Providers.
> 2. In Eaon, open Settings → Browser extension. A 6-character pairing code is shown.
> 3. Click the extension's toolbar icon, enter the code and press Pair. The popup shows "Connected".
> 4. In Eaon, switch to Work mode and ask: "Open example.com in the browser and tell me what the page says." The agent opens a tab in an "Eaon" tab group, reads the page and answers. The tab shows a blue outline and an "Eaon is using this tab · Stop" bar.
> 5. Press Stop on that bar, or "Stop agent control" in the popup; the agent can no longer act until "Allow agent control" is pressed.
> The extension only connects to 127.0.0.1 and sends nothing to any server.

If you can, attach a short screen recording of steps 2–5 in the reviewer
notes. Extensions with broad host permissions get a manual review, and a
reviewer who can see it working is much less likely to bounce it.

## 4. Submit

Press **Submit for review**. Leave "Publish automatically after review"
checked unless you want to time the launch.

Reviews usually take a few days. Broad host permissions (`<all_urls>`)
always get a manual review and can take a week or two. If it is rejected,
the email names the policy; the usual ones for this kind of extension are an
unclear single purpose or a permission justification that does not say
exactly what the permission is used for, and the text above addresses both.

## 5. After it is approved

1. Copy the listing URL (`https://chromewebstore.google.com/detail/…/<id>`).
2. Paste it into `CHROME_WEB_STORE_URL` in `src/shared/browserBridge.ts`.
   Settings → Browser extension then shows an "Open" button for the store
   next to the "Load unpacked" steps.
3. Ship an Eaon release with that change.

The store build has a different extension ID from an unpacked copy. Nothing
needs to change for that: pairing binds to whichever extension paired, so
users of the unpacked copy simply pair again after installing from the store.

## 6. Publishing updates

1. Bump `"version"` in `extension/manifest.json` (the store rejects an upload
   whose version is not higher than the published one).
2. If the extension and the app change the messages they exchange, bump
   `BRIDGE_PROTOCOL` in `src/shared/browserBridge.ts` and `PROTOCOL` in
   `extension/lib/connection.js` together.
3. `node scripts/pack-extension.mjs`, then in the dashboard open the item →
   **Package** → **Upload new package** → **Submit for review**.
4. Chrome updates installed copies on its own within a few hours of approval.

Adding a permission makes Chrome disable the extension for existing users
until they accept the new warning, so avoid it unless there is no other way.

---

## Privacy policy

*Eaon Browser Control: privacy policy. Last updated 23 September 2026.*

Eaon Browser Control ("the extension") lets the Eaon desktop app on your
computer operate web pages in your browser when you ask its agent to.

**What the extension handles.** When the agent works in a tab, the extension
reads that tab's address, title and page content (text, links, buttons, form
fields and their values) and can capture a screenshot of it. It does this only
for tabs in the "Eaon" tab group and tabs you have shared with the agent from
the extension's popup. It never reads your other tabs, your browsing history,
cookies, passwords saved in the browser, or anything in other extensions.

**Where it goes.** The extension sends this information only to the Eaon
desktop app running on the same computer, over a local connection to
127.0.0.1 that never leaves your machine. The extension has no server of its
own, sends nothing to its developers, and contains no analytics, advertising
or tracking.

**What the Eaon app does with it.** The Eaon app gives page content to the AI
model you chose in its settings so the agent can decide what to do next.
That means the content is sent to that model's provider (for example
Anthropic, OpenAI or Google, using your own API key) or stays on your
computer if you use a local model. Those providers handle it under their own
terms and privacy policies. Eaon does not send it anywhere else.

**What is stored.** The extension stores a pairing token and the connection
port in the browser's local extension storage, and, for the current browser
session only, which tabs belong to the agent. Removing the extension or
pressing Unpair deletes the token. Nothing is synced to your Google account.

**Sharing and sale.** Data is not sold, not shared with third parties other
than the AI provider you chose, and not used for advertising,
creditworthiness or any purpose other than carrying out the tasks you give
the agent.

**Your control.** You can stop the agent at any time from the page ("Stop")
or the popup ("Stop agent control"), un-share a tab, unpair the browser, or
turn off browser control in Eaon → Settings → Browser extension.

**Contact.** Questions: open an issue at
<https://github.com/eaonlabs/eaon-desktop/issues> or email the address on the
Chrome Web Store listing.
