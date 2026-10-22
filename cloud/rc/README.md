# Eaon Remote (rc.eaon.dev)

Control Eaon Desktop from any browser: ADE sessions, live terminals (watch and
type), starting agents, and Workers. No App Store app: a website, signed in
with GitHub (or with a password set for the GitHub account).

```
 browser ──wss /relay/web (cookie)──▶ ┌──────────────────────────┐ ◀──wss /relay/device (device token)── Eaon Desktop
                                      │ Cloudflare Worker         │
 GitHub ◀── /auth/github, callback ── │  Account DO (per GitHub   │     (outgoing: nothing on the Mac
                                      │  user): devices + relay   │      listens to the internet)
                                      │  Links DO: link codes     │
                                      └──────────────────────────┘
```

- **Sign-in:** GitHub OAuth with no scopes (only who you are). The session is an
  HttpOnly, Secure, SameSite=Lax cookie signed with `SESSION_SECRET`. The GitHub
  token is thrown away after the first call.
- **Password sign-in** (`src/passwords.ts`, `src/password.ts`): optional, added to
  a GitHub account at `/security`; you then sign in with your GitHub username
  and that password, optionally plus a 2-step code from an authenticator app.
  - Hashing: PBKDF2-SHA256, 100,000 rounds (the Workers maximum), over an HMAC
    keyed with the `PASSWORD_PEPPER` secret. 2-step secrets are sealed with
    AES-GCM under a key from the same secret.
  - New passwords: at least 12 characters, not the username, and not in Have I
    Been Pwned's leaked list (k-anonymity: only 5 hex characters of a SHA-1
    leave the Worker).
  - Guessing: five wrong tries on a username, then it locks for 1, 2, 4… minutes,
    up to a day; checks on one username run one at a time, so a burst can't slip
    past. Separately, 20 tries per 15 minutes and 100 per day per IP (IPv6 /64).
    An unknown username answers exactly like a wrong password, in the same time.
    A locked-out owner can still sign in with GitHub.
  - Changing the password or 2-step needs a GitHub sign-in from the last 10
    minutes, so a stolen password can't take the account over. Each change
    signs out every session that came from a password.
- **Linking (the TV way):** Eaon → `POST /api/link/start` → shows a code and opens
  `/link?code=…`; you sign in and approve; Eaon, polling with a secret only it
  holds, collects its device token once (`eaonrc1.<github id>.<device>.<secret>`,
  kept in Eaon's encrypted vault; the server stores only a SHA-256 of the secret).
  Codes last 10 minutes; starting a link is rate-limited per IP.
- **Relay:** one Durable Object per GitHub account, WebSocket hibernation. Tabs and
  computers of the same account only; nothing passing through is stored.
- **Guards:** every state-changing request and every browser WebSocket must carry
  this site's `Origin`; input only reaches panes in the ADE's layout; unlinking (on
  the site or in Eaon) closes the computer's connection and kills its token.
- **Encryption:** TLS end to end between each side and Cloudflare. The relay
  itself can see the traffic (terminal text included). End-to-end encryption
  between browser and computer can be layered on the same messages later.

## Deploy (once)

1. **GitHub OAuth app**: github.com → Settings → Developer settings → OAuth Apps →
   New OAuth App.
   - Homepage URL: `https://rc.eaon.dev`
   - Authorization callback URL: `https://rc.eaon.dev/auth/callback`
   Copy the Client ID and generate a Client secret.
2. **Secrets** (in this folder, after `wrangler login` with the Cloudflare account
   that has `eaon.dev`):
   ```sh
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   openssl rand -base64 32 | wrangler secret put SESSION_SECRET
   openssl rand -base64 32 | wrangler secret put PASSWORD_PEPPER
   ```
3. **Deploy**: `wrangler deploy`. The `rc.eaon.dev` custom domain in
   `wrangler.jsonc` makes Cloudflare create the DNS record and certificate
   itself, because `eaon.dev` is on the same account.

Rotating `SESSION_SECRET` signs everyone out. Never change `PASSWORD_PEPPER`:
every password and 2-step secret stops working. Never set `DEV_LOGIN` in production.

## Develop

```sh
cp .dev.vars.example .dev.vars        # DEV_LOGIN=1: /auth/dev?login=you signs in without GitHub
wrangler dev --local-upstream localhost:8787
```
`--local-upstream` matters: without it wrangler dev rewrites `Origin` to
`rc.eaon.dev` and every POST is refused as cross-site. Point Eaon at it with
`EAON_RC_URL=http://localhost:8787`.

The end-to-end test (`npm run test:e2e -- rc.e2e` from the repo root) starts
wrangler dev itself and drives linking, sessions, a live terminal, a new pane and
Workers against a real Eaon build.

## Protocol (JSON over the WebSockets)

Tab → computer (relay adds `from`): `{t:'req', dev, id, method, path, body}`,
`{t:'sub'|'unsub', dev, pane}`, `{t:'input', dev, pane, data}`.
Computer → tab (relay adds `dev`): `{t:'res', to, id, status, body}`,
`{t:'snap', to, pane, name, cols, rows, running, data}`, `{t:'term', to, pane, data}`, `{t:'exit', to, pane}`.
Relay → tab: `{t:'hello', conn, devices}`, `{t:'presence', dev, online, removed?}`. Relay → computer: `{t:'gone', from}`.

Requests a computer answers (`src/main/features/rc/handler.ts`): `GET /ade/sessions`,
`GET /ade/panes/:id`, `POST /ade/sessions/:id/panes {agent}`, `POST /ade/panes/:id/start`,
and the Workers API under `/remote/v1/…` (`docs/remote-api.md`).
