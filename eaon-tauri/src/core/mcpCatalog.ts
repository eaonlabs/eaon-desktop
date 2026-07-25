// The built-in MCP plugin catalog — a straight port of the Mac app's
// MCPCatalog.swift. Every entry here is genuinely connectable today, either
// a static token pasted into the app or a real browser sign-in — verified
// against the vendor's own live server before being added, never guessed.
//
// Deliberately NOT a full wishlist: services that turned out to be blocked
// (OAuth-only with no self-registration and no way around it, no hosted
// server at all, or a live endpoint that doesn't actually work yet) were
// left out entirely rather than kept as a permanently-disabled row.

export type McpAuthMode = "pastedToken" | "oauth";

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
  /** For "oauth" servers that don't support Dynamic Client Registration —
   *  verified case by case — where to go create one, and what to configure. */
  manualClientIdSetupURL?: string;
  manualClientIdHint?: string;
  /** Basename in /public/brand-logos (with extension). */
  logoAssetName: string;
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

/** The loopback redirect URI every OAuth-capable server's manual app setup
 *  needs to register — must match `REDIRECT_PORT` in src-tauri/src/mcp_oauth.rs. */
export const MCP_OAUTH_REDIRECT_URI = "http://127.0.0.1:51849/callback";

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
  {
    id: "notion", displayName: "Notion", summary: "Pages, databases, and docs.",
    endpoint: "https://mcp.notion.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "notion.svg",
  },
  {
    id: "vercel", displayName: "Vercel", summary: "Deployments, projects, and domains.",
    endpoint: "https://mcp.vercel.com", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "vercel.svg",
  },
  {
    id: "launchdarkly", displayName: "LaunchDarkly", summary: "Feature flags and targeting.",
    endpoint: "https://mcp.launchdarkly.com/mcp/launchdarkly", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "launchdarkly.svg",
  },
  {
    id: "slack", displayName: "Slack", summary: "Messages, channels, and threads.",
    endpoint: "https://mcp.slack.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: Slack's server has real OAuth discovery but no
    // registration_endpoint — no self-service registration exists, so
    // (unlike Notion/Vercel/LaunchDarkly) this needs a client ID from an
    // app you create yourself first.
    manualClientIdSetupURL: "https://api.slack.com/apps",
    manualClientIdHint: `Create a new app → OAuth & Permissions → add redirect URL ${MCP_OAUTH_REDIRECT_URI} → copy the Client ID from Basic Information.`,
    logoAssetName: "slack.svg",
  },
  {
    id: "clickup", displayName: "ClickUp", summary: "Tasks, docs, and spaces.",
    endpoint: "https://mcp.clickup.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "clickup.svg",
  },
  {
    id: "trello", displayName: "Trello", summary: "Boards, cards, and lists.",
    endpoint: "https://mcp.trello.com/v1", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "trello.svg",
  },
  {
    id: "airtable", displayName: "Airtable", summary: "Bases, tables, and records.",
    endpoint: "https://mcp.airtable.com/mcp", authMode: "pastedToken", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURL: "https://airtable.com/create/tokens", tokenCreationURLIsPrefilled: false,
    tokenFieldPlaceholder: "Paste an Airtable personal access token",
    tokenHint: "Needs data.records:read/write, schema.bases:read/write, and workspacesAndBases:read — pick these scopes on Airtable's token creation page before generating it.",
    logoAssetName: "airtable.svg",
  },
  {
    id: "monday", displayName: "monday.com", summary: "Boards, items, and updates.",
    endpoint: "https://mcp.monday.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "monday.png",
  },
  {
    id: "asana", displayName: "Asana", summary: "Tasks, projects, and portfolios.",
    endpoint: "https://mcp.asana.com/v2/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: Asana's authorization server has no registration_endpoint.
    manualClientIdSetupURL: "https://app.asana.com/0/my-apps",
    manualClientIdHint: `Create new app → type "MCP app" → add redirect URL ${MCP_OAUTH_REDIRECT_URI} → copy the Client ID.`,
    logoAssetName: "asana.svg",
  },
  {
    id: "hubspot", displayName: "HubSpot", summary: "Contacts, deals, and tickets.",
    endpoint: "https://mcp.hubspot.com", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: HubSpot's discovery doc has no registration_endpoint.
    manualClientIdSetupURL: "https://app.hubspot.com/",
    manualClientIdHint: `Development → MCP Auth Apps → Create MCP auth app → add redirect URL ${MCP_OAUTH_REDIRECT_URI} → copy the Client ID.`,
    logoAssetName: "hubspot.svg",
  },
  {
    id: "intercom", displayName: "Intercom", summary: "Conversations, contacts, and tickets.",
    endpoint: "https://mcp.intercom.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "intercom.svg",
  },
  {
    id: "attio", displayName: "Attio", summary: "Records, lists, and notes.",
    endpoint: "https://mcp.attio.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "attio.png",
  },
  {
    id: "gitlab", displayName: "GitLab", summary: "Repos, issues, and merge requests.",
    endpoint: "https://gitlab.com/api/v4/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "gitlab.svg",
  },
  {
    id: "pagerduty", displayName: "PagerDuty", summary: "Incidents, on-call, and services.",
    endpoint: "https://mcp.pagerduty.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Verified live: no registration_endpoint, and PagerDuty's own docs say
    // Dynamic Client Registration isn't supported.
    manualClientIdSetupURL: "https://developer.pagerduty.com/apps",
    manualClientIdHint: `Create a new app → OAuth 2.0 → add redirect URL ${MCP_OAUTH_REDIRECT_URI} → copy the Client ID.`,
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
  {
    id: "figma", displayName: "Figma", summary: "Files, frames, and comments.",
    endpoint: "https://mcp.figma.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "figma.svg",
  },
  {
    id: "exa", displayName: "Exa", summary: "AI-native web search.",
    endpoint: "https://mcp.exa.ai/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "exa.svg",
  },
  {
    id: "apify", displayName: "Apify", summary: "Web scraping and automation actors.",
    endpoint: "https://mcp.apify.com", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    logoAssetName: "apify.svg",
  },
  {
    id: "dropbox", displayName: "Dropbox", summary: "Files, folders, and sharing.",
    endpoint: "https://mcp.dropbox.com/mcp", authMode: "oauth", authScheme: "Bearer", extraHeaders: {},
    tokenCreationURLIsPrefilled: false, tokenFieldPlaceholder: "",
    // Dropbox's discovery doc advertises a registration_endpoint, but
    // self-registration for a client not already on their known-client
    // allowlist is unconfirmed — a manual app is the safe default rather
    // than risking a silent failure on first connect. If DCR does work for
    // this client, live discovery finds that out and this hint never surfaces.
    manualClientIdSetupURL: "https://www.dropbox.com/developers/apps/",
    manualClientIdHint: `Create app → Scoped access → add redirect URI ${MCP_OAUTH_REDIRECT_URI} → copy the App key.`,
    logoAssetName: "dropbox.svg",
  },
];

export function mcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}
