// The built-in MCP plugin catalog. Every entry is a hosted server run by the
// vendor itself and is connectable today in one of three ways: no auth at all
// (one click), a token pasted into the app, or a browser sign-in (OAuth 2.1 +
// PKCE, see src/main/mcpOAuth.ts).
//
// Every entry is checked against the vendor's live server by
// `node scripts/verify-plugins.mjs`, which walks the same discovery the app's
// sign-in does and, for self-registering servers, registers a client and
// requests the authorization URL. Last full run: 2026-09-23, all passing.
// Re-run it before adding or changing an entry; never add one on a guess.
//
// Deliberately NOT a wishlist. Removed or left out after verification:
//   - Figma (mcp.figma.com): its registration endpoint answers 403 to any
//     client outside Figma's own allowlist, and there is no manual-app route,
//     so the sign-in cannot complete for Eaon.
//   - Stack Overflow, Hex: answer 401/403 but publish no OAuth metadata, so
//     there is nothing to sign in against.
//   - Gamma: registration endpoint rejects new clients.
//   - Smartsheet: no registration endpoint and no PKCE advertised.
//   - Ahrefs: registers fine, but its authorize page sits behind a bot
//     challenge the verifier cannot get past, so the flow is unproven.
//   - Coda, Circleback, Pulumi: no hosted MCP endpoint answered.

export type McpAuthMode = "pastedToken" | "oauth" | "none";

export interface McpCatalogEntry {
  id: string;
  displayName: string;
  summary: string;
  endpoint: string;
  authMode: McpAuthMode;
  /** The `Authorization` header's scheme word — vendors genuinely differ
   *  (Sentry, Semrush). Unused for "oauth" — the issued token is always a
   *  standard Bearer token per the OAuth spec. */
  authScheme: string;
  /** Extra per-request headers this server needs beyond bare auth. */
  extraHeaders: Record<string, string>;
  tokenCreationURL?: string;
  /** True only when tokenCreationURL actually pre-fills the right
   *  scopes/permissions via verified query parameters (GitHub only). */
  tokenCreationURLIsPrefilled: boolean;
  tokenFieldPlaceholder: string;
  /** An extra line for a service whose token needs something non-obvious to
   *  actually work (e.g. Cloudflare's "Account Resources: Read"). */
  tokenHint?: string;
  /** For "oauth" servers without Dynamic Client Registration — verified case
   *  by case — where to go create an app, and what to configure. The UI asks
   *  for that app's client id before signing in. */
  manualClientIdSetupURL?: string;
  manualClientIdHint?: string;
  /** Verified to have no registration endpoint: the client id form is shown
   *  up front. Without it, the manual fields only appear if registration
   *  fails at sign-in time (Dropbox keeps its setup link for that case). */
  noDynamicRegistration?: boolean;
  /** The vendor's token endpoint only accepts confidential clients (its
   *  metadata lists no "none" auth method), so the app's secret is needed too. */
  manualClientNeedsSecret?: boolean;
  /** Basename in `renderer/src/assets/plugins` (with extension). Only official
   *  marks (Simple Icons, CC0, or the vendor's press kit); without one the UI
   *  draws a monogram rather than something that looks like a logo but isn't. */
  logoAssetName?: string;
}

/** A pre-filled "create a token" deep link — verified against GitHub's
 *  documented fine-grained-PAT template-URL query parameters (GitHub
 *  Changelog, "Template URLs for fine-grained PATs," 2025-08-26). */
function githubTokenCreationURL(): string {
  const params = new URLSearchParams({
    name: "Eaon",
    description: "Lets the Eaon app read and act on your repos, issues, and pull requests.",
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

/**
 * Where the browser comes back after an OAuth sign-in: a loopback listener the
 * main process opens only while a sign-in is waiting (RFC 8252 §7.3). The port
 * is fixed rather than ephemeral because servers without Dynamic Client
 * Registration need the exact URI typed into an app the user creates by hand.
 */
export const MCP_OAUTH_REDIRECT_URI = "http://127.0.0.1:51849/callback";

/**
 * What Eaon registers as with servers that support Dynamic Client
 * Registration. A native app cannot keep a secret, so it registers as a
 * public client and relies on PKCE — the verifier script registers with this
 * exact object so a pass there means the app's registration works too.
 */
export const MCP_OAUTH_CLIENT_METADATA = {
  client_name: "Eaon",
  client_uri: "https://github.com/eaonlabs/eaon-desktop",
  redirect_uris: [MCP_OAUTH_REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

/** Shorthand for the entries that need nothing but an endpoint. */
const open = (id: string, displayName: string, summary: string, endpoint: string, logoAssetName?: string): McpCatalogEntry => ({
  id, displayName, summary, endpoint, authMode: "none", authScheme: "Bearer", extraHeaders: {},
  tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "", logoAssetName,
});

/** Shorthand for browser sign-in entries whose server self-registers clients. */
const oauth = (id: string, displayName: string, summary: string, endpoint: string, logoAssetName?: string): McpCatalogEntry => ({
  id, displayName, summary, endpoint, authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
  tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "", logoAssetName,
});

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "github", displayName: "GitHub", summary: "Repos, issues, and pull requests.",
    endpoint: "https://api.githubcopilot.com/mcp/", authMode: "pastedToken", authScheme: "Bearer",
    extraHeaders: { "X-MCP-Toolsets": "repos,issues,pull_requests" },
    tokenCreationURL: githubTokenCreationURL(), tokenCreationURLIsPrefilled: true,
    tokenFieldPlaceholder: "Paste a GitHub personal access token",
    logoAssetName: "github.svg",
  },
  {
    id: "stripe", displayName: "Stripe", summary: "Payments, customers, invoices, and subscriptions.",
    endpoint: "https://mcp.stripe.com", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://dashboard.stripe.com/apikeys", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Stripe restricted API key",
    logoAssetName: "stripe.svg",
  },
  {
    id: "sentry", displayName: "Sentry", summary: "Issues, errors, and releases.",
    endpoint: "https://mcp.sentry.dev/mcp", authMode: "pastedToken", authScheme: "Sentry-Bearer", extraHeaders: {},
    tokenCreationURL: "https://sentry.io/settings/account/api/auth-tokens/", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Sentry auth token",
    logoAssetName: "sentry.svg",
  },
  {
    id: "cloudflare", displayName: "Cloudflare", summary: "DNS, Workers, and zones.",
    endpoint: "https://mcp.cloudflare.com/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://dash.cloudflare.com/profile/api-tokens", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Cloudflare API token",
    tokenHint: "Include the \"Account Resources: Read\" permission — without it Cloudflare's server can't tell which account to use, and its tools silently come back empty.",
    logoAssetName: "cloudflare.svg",
  },
  {
    id: "posthog", displayName: "PostHog", summary: "Product analytics and events.",
    endpoint: "https://mcp.posthog.com/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://app.posthog.com/settings/user-api-keys", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a PostHog personal API key",
    logoAssetName: "posthog.svg",
  },
  {
    id: "semrush", displayName: "Semrush", summary: "SEO keywords, domain analytics, and competitor research.",
    endpoint: "https://mcp.semrush.com/v2/mcp", authMode: "pastedToken", authScheme: "Apikey", extraHeaders: {},
    tokenCreationURL: "https://www.semrush.com/kb/92-api-key", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Semrush API key",
    logoAssetName: "semrush.svg",
  },
  {
    id: "linear", displayName: "Linear", summary: "Issues, projects, and cycles.",
    endpoint: "https://mcp.linear.app/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://linear.app/settings/account/security", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Linear API key",
    logoAssetName: "linear.svg",
  },
  {
    id: "supabase", displayName: "Supabase", summary: "Postgres, auth, and storage.",
    endpoint: "https://mcp.supabase.com/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://supabase.com/dashboard/account/tokens", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Supabase personal access token",
    logoAssetName: "supabase.svg",
  },
  {
    id: "render", displayName: "Render", summary: "Services, deploys, and managed Postgres.",
    endpoint: "https://mcp.render.com/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://dashboard.render.com/u/settings?add-api-key", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Render API key",
    logoAssetName: "render.svg",
  },
  {
    id: "neon", displayName: "Neon", summary: "Serverless Postgres with branching.",
    endpoint: "https://mcp.neon.tech/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://console.neon.tech/app/settings/api-keys", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Neon API key",
    logoAssetName: "neon.svg",
  },
  {
    id: "datadog", displayName: "Datadog", summary: "Metrics, logs, traces, and monitors.",
    endpoint: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://app.datadoghq.com/personal-settings/access-tokens", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Datadog access token",
    logoAssetName: "datadog.svg",
  },
  {
    id: "resend", displayName: "Resend", summary: "Transactional and broadcast email.",
    endpoint: "https://mcp.resend.com/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://resend.com/api-keys", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a Resend API key",
    logoAssetName: "resend.svg",
  },
  oauth("notion", "Notion", "Pages, databases, and docs.", "https://mcp.notion.com/mcp", "notion.svg"),
  oauth("vercel", "Vercel", "Deployments, projects, and domains.", "https://mcp.vercel.com", "vercel.svg"),
  oauth("launchdarkly", "LaunchDarkly", "Feature flags and targeting.", "https://mcp.launchdarkly.com/mcp/launchdarkly", "launchdarkly.svg"),
  {
    id: "slack", displayName: "Slack", summary: "Messages, channels, and threads.",
    endpoint: "https://mcp.slack.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: real OAuth discovery but no registration_endpoint, and
    // the token endpoint only takes client_secret_post — so this needs an
    // app you create yourself, secret included.
    manualClientIdSetupURL: "https://api.slack.com/apps",
    manualClientIdHint: `Create a new app → OAuth & Permissions → add redirect URL ${MCP_OAUTH_REDIRECT_URI} → copy the Client ID and Client Secret from Basic Information.`,
    manualClientNeedsSecret: true,
    noDynamicRegistration: true,
    logoAssetName: "slack.svg",
  },
  oauth("clickup", "ClickUp", "Tasks, docs, and spaces.", "https://mcp.clickup.com/mcp", "clickup.svg"),
  oauth("trello", "Trello", "Boards, cards, and lists.", "https://mcp.trello.com/v1", "trello.svg"),
  {
    id: "airtable", displayName: "Airtable", summary: "Bases, tables, and records.",
    endpoint: "https://mcp.airtable.com/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://airtable.com/create/tokens", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste an Airtable personal access token",
    tokenHint: "Needs data.records:read/write, schema.bases:read/write, and workspacesAndBases:read — pick these scopes on Airtable's token creation page before generating it.",
    logoAssetName: "airtable.svg",
  },
  oauth("monday", "monday.com", "Boards, items, and updates.", "https://mcp.monday.com/mcp", "monday.png"),
  {
    id: "asana", displayName: "Asana", summary: "Tasks, projects, and portfolios.",
    endpoint: "https://mcp.asana.com/v2/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: no registration_endpoint; token endpoint takes only
    // client_secret_post / client_secret_basic.
    manualClientIdSetupURL: "https://app.asana.com/0/my-apps",
    manualClientIdHint: `Create new app → type "MCP app" → add redirect URL ${MCP_OAUTH_REDIRECT_URI} → copy the Client ID and Client secret.`,
    manualClientNeedsSecret: true,
    noDynamicRegistration: true,
    logoAssetName: "asana.svg",
  },
  {
    id: "hubspot", displayName: "HubSpot", summary: "Contacts, deals, and tickets.",
    endpoint: "https://mcp.hubspot.com", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: no registration_endpoint; client_secret_post only.
    manualClientIdSetupURL: "https://app.hubspot.com/",
    manualClientIdHint: `Development → MCP Auth Apps → Create MCP auth app → add redirect URL ${MCP_OAUTH_REDIRECT_URI} → copy the Client ID and Client secret.`,
    manualClientNeedsSecret: true,
    noDynamicRegistration: true,
    logoAssetName: "hubspot.svg",
  },
  // No RFC 9728 document, but its authorization server metadata sits at the
  // origin, which the SDK falls back to — verified to register and authorize.
  oauth("intercom", "Intercom", "Conversations, contacts, and tickets.", "https://mcp.intercom.com/mcp", "intercom.svg"),
  oauth("attio", "Attio", "Records, lists, and notes.", "https://mcp.attio.com/mcp", "attio.png"),
  oauth("gitlab", "GitLab", "Repos, issues, and merge requests.", "https://gitlab.com/api/v4/mcp", "gitlab.svg"),
  {
    id: "pagerduty", displayName: "PagerDuty", summary: "Incidents, on-call, and services.",
    endpoint: "https://mcp.pagerduty.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: no registration_endpoint, and PagerDuty's own docs say
    // Dynamic Client Registration isn't supported.
    manualClientIdSetupURL: "https://developer.pagerduty.com/apps",
    manualClientIdHint: `Create a new app → OAuth 2.0 → add redirect URL ${MCP_OAUTH_REDIRECT_URI} → copy the Client ID and Client Secret.`,
    manualClientNeedsSecret: true,
    noDynamicRegistration: true,
    logoAssetName: "pagerduty.svg",
  },
  {
    id: "digitalocean", displayName: "DigitalOcean", summary: "App Platform deploys and management.",
    endpoint: "https://apps.mcp.digitalocean.com/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://cloud.digitalocean.com/account/api/tokens", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste a DigitalOcean personal access token",
    tokenHint: "This connects App Platform specifically — DigitalOcean also runs separate MCP endpoints per resource (Droplets, Databases, Kubernetes, and more) that aren't wired up here yet.",
    logoAssetName: "digitalocean.svg",
  },
  // Answers anonymous requests with a free-tier quota, so it needs no sign-in.
  open("exa", "Exa", "AI-native web search and page fetching.", "https://mcp.exa.ai/mcp", "exa.svg"),
  oauth("apify", "Apify", "Web scraping and automation actors.", "https://mcp.apify.com", "apify.svg"),
  {
    id: "dropbox", displayName: "Dropbox", summary: "Files, folders, and sharing.",
    endpoint: "https://mcp.dropbox.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: self-registration works for Eaon's client metadata and
    // the authorize page accepts the result. The manual route stays as a
    // fallback — it only surfaces if registration ever starts failing.
    manualClientIdSetupURL: "https://www.dropbox.com/developers/apps/",
    manualClientIdHint: `Create app → Scoped access → add redirect URI ${MCP_OAUTH_REDIRECT_URI} → copy the App key.`,
    logoAssetName: "dropbox.svg",
  },

  // Documentation and knowledge servers: public, read-only, no account needed.
  open("context7", "Context7", "Up-to-date library docs and code examples.", "https://mcp.context7.com/mcp"),
  open("deepwiki", "DeepWiki", "Ask questions about any public GitHub repository.", "https://mcp.deepwiki.com/mcp"),
  open("huggingface", "Hugging Face", "Models, datasets, Spaces, and papers.", "https://huggingface.co/mcp", "huggingface.svg"),
  open("microsoft-learn", "Microsoft Learn", "Microsoft and Azure documentation and code samples.", "https://learn.microsoft.com/api/mcp"),
  open("aws-knowledge", "AWS Knowledge", "AWS documentation and regional availability.", "https://knowledge-mcp.global.api.aws"),
  open("cloudflare-docs", "Cloudflare Docs", "Search Cloudflare's developer documentation.", "https://docs.mcp.cloudflare.com/mcp", "cloudflare.svg"),

  // Browser sign-in, each verified to self-register and reach a login page.
  // Atlassian publishes no RFC 9728 document; discovery falls back to its origin.
  oauth("atlassian", "Atlassian", "Jira issues and Confluence pages.", "https://mcp.atlassian.com/v1/mcp", "atlassian.svg"),
  oauth("canva", "Canva", "Designs, templates, and exports.", "https://mcp.canva.com/mcp"),
  oauth("zapier", "Zapier", "Actions across the apps in your Zapier account.", "https://mcp.zapier.com/api/mcp/mcp", "zapier.svg"),
  oauth("netlify", "Netlify", "Sites, deploys, and environment variables.", "https://netlify-mcp.netlify.app/mcp", "netlify.svg"),
  oauth("webflow", "Webflow", "Sites, CMS collections, and pages.", "https://mcp.webflow.com/mcp", "webflow.svg"),
  oauth("wix", "Wix", "Sites, stores, and bookings.", "https://mcp.wix.com/mcp", "wix.svg"),
  oauth("paypal", "PayPal", "Invoices, orders, and transactions.", "https://mcp.paypal.com/mcp", "paypal.svg"),
  oauth("square", "Square", "Payments, orders, catalog, and customers.", "https://mcp.squareup.com/mcp", "square.svg"),
  oauth("cloudinary", "Cloudinary", "Upload, search, and transform media assets.", "https://asset-management.mcp.cloudinary.com/mcp", "cloudinary.svg"),
  oauth("miro", "Miro", "Boards, diagrams, and sticky notes.", "https://mcp.miro.com/", "miro.svg"),
  oauth("todoist", "Todoist", "Tasks, projects, and due dates.", "https://ai.todoist.net/mcp", "todoist.svg"),
  oauth("granola", "Granola", "Meeting notes and transcripts.", "https://mcp.granola.ai/mcp"),
  oauth("fireflies", "Fireflies", "Meeting transcripts and summaries.", "https://api.fireflies.ai/mcp"),
  oauth("jam", "Jam", "Bug reports with console logs and replays.", "https://mcp.jam.dev/mcp"),
  oauth("close", "Close", "CRM leads, opportunities, and activities.", "https://mcp.close.com/mcp"),
  oauth("prisma", "Prisma", "Prisma Postgres databases.", "https://mcp.prisma.io/mcp", "prisma.svg"),
  oauth("semgrep", "Semgrep", "Scan code for security issues.", "https://mcp.semgrep.ai/mcp"),
  oauth("honeycomb", "Honeycomb", "Traces, queries, and SLOs.", "https://mcp.honeycomb.io/mcp"),
  oauth("amplitude", "Amplitude", "Product analytics charts and cohorts.", "https://mcp.amplitude.com/mcp"),
  oauth("mixpanel", "Mixpanel", "Events, funnels, and retention.", "https://mcp.mixpanel.com/mcp", "mixpanel.svg"),
  oauth("sanity", "Sanity", "Content documents, schemas, and releases.", "https://mcp.sanity.io", "sanity.svg"),
  oauth("lucid", "Lucid", "Lucidchart and Lucidspark diagrams.", "https://mcp.lucid.app/mcp", "lucid.svg"),
  oauth("buildkite", "Buildkite", "Pipelines, builds, and job logs.", "https://mcp.buildkite.com/mcp", "buildkite.svg"),
  oauth("postman", "Postman", "Collections, workspaces, and APIs.", "https://mcp.postman.com/mcp", "postman.svg"),
  oauth("klaviyo", "Klaviyo", "Email and SMS campaigns, flows, and profiles.", "https://mcp.klaviyo.com/mcp"),
  oauth("railway", "Railway", "Projects, services, and deployments.", "https://mcp.railway.com", "railway.svg"),
  oauth("shortcut", "Shortcut", "Stories, epics, and iterations.", "https://mcp.shortcut.com/mcp", "shortcut.svg"),
  oauth("mapbox", "Mapbox", "Geocoding, directions, and maps.", "https://mcp.mapbox.com/mcp", "mapbox.svg"),
  oauth("mercury", "Mercury", "Business bank accounts and transactions.", "https://mcp.mercury.com/mcp"),
  oauth("ramp", "Ramp", "Corporate cards, spend, and bills.", "https://mcp.ramp.com/mcp"),
  {
    id: "box", displayName: "Box", summary: "Files, folders, and Box AI.",
    endpoint: "https://mcp.box.com", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: RFC 9728 points at api.box.com, which has no
    // registration_endpoint and only client_secret_basic/post.
    manualClientIdSetupURL: "https://app.box.com/developers/console",
    manualClientIdHint: `A Box admin has to enable the Box MCP server first (Admin Console → Integrations). Then create an OAuth 2.0 app → add redirect URI ${MCP_OAUTH_REDIRECT_URI} → copy the Client ID and Client Secret.`,
    manualClientNeedsSecret: true,
    noDynamicRegistration: true,
    logoAssetName: "box.svg",
  },
];

export function mcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}
