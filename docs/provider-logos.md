# Provider logos

Eaon shows a logo for every model provider: in the model picker, the message box, Settings → Model providers, Link accounts and the setup. The providers built into Eaon ship with theirs. Any other provider, one added with its own base URL, can get its logo in two ways:

- **The provider publishes it.** Eaon finds it from the base URL on its own, with nothing for the person to do. [For API providers: publish your logo](#for-api-providers-publish-your-logo) explains how, in three steps.
- **The person picks it.** Anyone can give any provider their own image, built-in providers included.

---

## For people using Eaon

### Change a provider's logo

1. Open **Settings → Model providers** and choose the provider.
2. Under **Logo**, press **Choose image…** and pick a file.

Eaon takes SVG, PNG, JPEG, WebP, GIF and ICO files up to 1 MB. Any shape works: Eaon trims the space around the logo and fits it to the tile. Your image shows everywhere the provider appears, in place of its own logo, until you press **Remove my image**.

### Custom providers find their own logo

When you add a custom provider (Settings → Model providers → **+**), or change its base URL, Eaon looks for the provider's logo within a few seconds. Under **Logo**, Settings shows where the logo came from. **What Eaon tried** lists every address Eaon checked and the result. **Look again** checks right away; otherwise Eaon checks again once a month, or once a week while it hasn't found one.

When no logo turns up, the provider shows its initials.

### What Eaon sends

Each request is a plain `GET` to the provider's API host or its website. It carries no API key and no cookies, and identifies itself as `Eaon/<version> (provider logo lookup; …)`.

- Eaon never looks up a logo for a provider built into Eaon. It only looks for custom providers you added yourself.
- A provider on the internet can't send Eaon to an address on your computer or your local network, whether through its manifest, a redirect or a DNS name.
- Logos are stored in your Eaon profile, in `provider-logos.json`. Images are only ever shown as images, so an SVG can't run code.

---

## For API providers: publish your logo

If people use your API from Eaon as a custom provider (an OpenAI- or Anthropic-compatible base URL), you can make your logo show up for them automatically.

### The short version

1. **Make the file.** Use a square SVG of your mark (the symbol, not the full wordmark) on a transparent background.
2. **Host it** anywhere it can be fetched without signing in, for example `https://acme.ai/brand/acme-mark.svg`.
3. **Serve this JSON** at `https://<your API host>/.well-known/eaon-provider.json`:

```json
{
  "name": "Acme AI",
  "logo": "https://acme.ai/brand/acme-mark.svg",
  "logo_dark": "https://acme.ai/brand/acme-mark-white.svg"
}
```

That's all. Anyone who adds `https://api.acme.ai/v1` (or any other path on that host) as a custom provider gets your logo within seconds. People who added you before you published get it at Eaon's next check, within a week. To check it, see [Check that it works](#check-that-it-works).

### Where Eaon looks

Eaon takes the **origin** of the base URL the person entered (scheme, host and port, ignoring the path). It then tries these addresses in order and keeps the first image that passes [the checks](#the-logo-file):

| # | Address | For a base URL of `https://api.acme.ai/v1` |
|---|---|---|
| 1 | The manifest on the API host | `https://api.acme.ai/.well-known/eaon-provider.json` |
| 2 | The manifest on your website, at the registrable domain | `https://acme.ai/.well-known/eaon-provider.json` |
| 3 | The icons your API host's home page declares | `https://api.acme.ai/` |
| 4 | The icons your website's home page declares | `https://acme.ai/` |
| 5 | The favicon on the API host | `https://api.acme.ai/favicon.ico` |
| 6 | The favicon on your website | `https://acme.ai/favicon.ico` |

Steps 2, 4 and 6 only happen when the API host is a subdomain of a registered domain. The registrable domain comes from the [Public Suffix List](https://publicsuffix.org/), including shared hosting such as `github.io`, `vercel.app` and `workers.dev`. A provider at `acme.github.io` is therefore never given GitHub's logo. Hosts that only exist on a local network (`localhost`, `10.x`, `192.168.x`, `.local`, `.internal`) only use steps 1, 3 and 5.

**Put the manifest on whichever host you control.** If your API is `api.acme.ai` and your marketing site is `acme.ai`, either one works.

### The manifest

`/.well-known/eaon-provider.json` is a JSON object:

| Field | Required | What it is |
|---|---|---|
| `logo` | Yes | Your logo. An absolute URL (`https://…`), a path relative to the manifest (`/brand/mark.svg`), or a `data:image/…` URL. |
| `logo_dark` | No | A version for dark mode, usually white or a lighter colour. Without it, Eaon still handles one-colour logos (see [How Eaon fits your logo](#how-eaon-fits-your-logo)). |
| `name` | No | Your name, up to 80 characters. It's shown in Settings next to where the logo came from. It doesn't rename the provider. |

The manifest also has to meet these rules:

- It must answer a plain `GET` with status `200`, without sign-in, cookies or an API key.
- It can be at most 64 KB.
- Up to 5 redirects are followed.
- Any `Content-Type` works, but `application/json` is best.
- CORS headers aren't needed, because Eaon fetches it from the app, not from a web page.

Unknown fields are ignored, so you can add your own. Eaon also understands `icon`, `logoDark`, `icon_dark` and `"logo": { "light": …, "dark": … }`, but the names in the table are the documented ones.

### The logo file

| | |
|---|---|
| **Format** | SVG (best), PNG, WebP, JPEG, GIF or ICO. Eaon detects the format from the file's contents, not its name or `Content-Type`. |
| **File size** | At most 1 MB. |
| **Pixel size** | For bitmaps, at least 16 px on the shorter side and at most 8192. Use 256 × 256 or larger. Eaon draws logos at 13–40 px, at up to 3× on high-density screens. |
| **Background** | Transparent, unless your logo is an app icon that fills its square. |
| **Content** | Your mark. A wordmark works, but at 13–16 px in the model picker a symbol reads far better. |

**SVG rules.** An SVG must be one self-contained file:

- No `<script>`, no `<foreignObject>` and no `<!ENTITY>` declarations. Eaon refuses files that have them.
- No `<image>`, `<use>` or filters that load another URL. Eaon refuses these too, because an image shown on its own can't load other files.
- **Convert text to paths.** Web fonts don't load inside an image, and the fallback font won't be yours.
- Include `xmlns="http://www.w3.org/2000/svg"` on the `<svg>` element. Eaon adds it if it's missing, but other apps won't.

### How Eaon fits your logo

Eaon looks at each logo once and fits it to the tile:

| Your file | What Eaon does |
|---|---|
| Fills its own square edge to edge (an app icon, or a mark on a coloured square) | It becomes the whole tile, with corners rounded like the other logos. |
| A mark with empty space around it | The space is trimmed and the mark is centred at the same visual size as the built-in logos. |
| A wide wordmark | Same as a mark, but given more width than height. |
| A logo on a plain white or coloured rectangle | The plain background is removed, then treated as above. |
| One colour, black | Shown on white tiles. In dark mode, as a bare mark, it turns white. |
| One colour, white | Shown on a dark tile. In light mode, as a bare mark, it turns black. |
| Several colours | Shown as it is on a white tile. If your colours don't work on dark backgrounds, add `logo_dark`. |

### If you don't publish a manifest

Eaon falls back to your home page's declared icons (steps 3–4), then `/favicon.ico` (steps 5–6). On a home page it reads:

- `<link rel="icon">`, preferring SVG, then the largest `sizes`;
- `<link rel="apple-touch-icon">`, which it treats as 180 px;
- the icons in your web app manifest (`<link rel="manifest">`), skipping any marked `"purpose": "monochrome"`.

This often works. But favicons are small, often have a background, and are sometimes a different mark from the one you'd choose. The manifest is the only way to decide exactly what shows, and to give a dark-mode version.

### Check that it works

**1. From a terminal:**

```sh
# The manifest: expect 200 and your JSON
curl -sS -i https://api.acme.ai/.well-known/eaon-provider.json

# The logo: expect 200 and a size under 1 MB
curl -sS -o /dev/null -w '%{http_code} %{content_type} %{size_download} bytes\n' https://acme.ai/brand/acme-mark.svg
```

**2. In Eaon:**

1. Go to Settings → Model providers → **+** and add your base URL.
2. Open the provider and look at **Logo**. **What Eaon tried** shows every address checked and what happened.
3. After you change something, press **Look again**.

**3. What the messages mean:**

| Message in "What Eaon tried" | Fix |
|---|---|
| `Not found (404)` | Nothing at that address. Check the path is exactly `/.well-known/eaon-provider.json`. Some hosts hide dot-folders (see below). |
| `The server answered 401` / `403` | The address needs sign-in. Serve the manifest and logo publicly, outside your API's authentication. |
| `Not valid JSON.` / `Not a JSON object.` | Run the file through a JSON validator. Trailing commas and comments aren't allowed. |
| `It has no "logo".` | Add a `logo` field. |
| `It isn’t an image Eaon can show (…)` | The URL returned something else, often an HTML error page. Open the URL in a browser to see what it returns. |
| `It’s … pixels; a logo needs at least 16 on each side.` | Use a bigger image: 256 × 256 or more. |
| `It’s … MB; a logo can be at most 1 MB.` / `Larger than 1 MB` | Compress it, or use an SVG. |
| `It’s an SVG with a script in it…` and other SVG messages | Export a plain SVG (in Figma: Export → SVG, with "Outline text" on), and remove scripts, embedded HTML and links to other files. |
| `Leads to this computer or the local network…` | Your manifest or a redirect points to a private address. Host the logo on a public address. |
| `No answer in 6 seconds` / `Couldn’t connect` / `Its HTTPS certificate isn’t valid` | The address can't be reached from the person's computer. Check DNS, the firewall and the certificate. |
| `Redirected more than 5 times` | A redirect loop. Link to the final URL directly. |

**Static hosts and `.well-known`.** Some hosts skip folders whose names start with a dot:

- **GitHub Pages (Jekyll):** add `include: [".well-known"]` to `_config.yml`, or add an empty `.nojekyll` file.
- **Netlify, Vercel and Cloudflare Pages:** they serve `.well-known/` from your output folder. Check that your build copies it there.
- **Your own server:** a static route, or one line in your API, for example `app.get('/.well-known/eaon-provider.json', (req, res) => res.json({ name: 'Acme AI', logo: 'https://acme.ai/brand/acme-mark.svg' }))`.

### Updating your logo

Change the file or the manifest. Eaon picks the change up at its next check: within a month for people who already have your logo, and within a week for people who don't have one yet. It also checks right away when someone adds your base URL, changes it, or presses **Look again**. If you rename the logo file, update the manifest to match.

### Built-in providers

Providers that come with Eaon (everything in Settings → Model providers outside the **Custom** group) ship their logos inside Eaon and never fetch one. If you're one of them and want your logo updated, open an issue or a pull request at [github.com/eaonlabs/eaon-desktop](https://github.com/eaonlabs/eaon-desktop). The files are in `src/renderer/src/assets/providers/`, and their sources are listed in `NOTICE.md` there.
