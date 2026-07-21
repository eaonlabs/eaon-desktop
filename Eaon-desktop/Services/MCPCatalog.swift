import SwiftUI

/// One external service Eaon can connect to via MCP. Every entry here is
/// genuinely connectable today — either a static token pasted into the
/// app, or a real browser sign-in — verified against the vendor's own
/// live server before being added, never guessed.
///
/// Deliberately NOT a full wishlist: a much longer list of services was
/// tried and individually verified over several rounds (live discovery
/// probes, not just docs), and the ones that turned out to be genuinely
/// blocked — OAuth-only with no self-registration and no way around it,
/// no hosted server at all, or a live endpoint that doesn't actually work
/// yet — were removed rather than kept as permanently-disabled rows. A
/// "Coming soon" tag that never resolves is just clutter; when one of
/// those vendors ships something new, it goes back in the same way these
/// did, re-verified at that point rather than assumed.
enum MCPAuthMode: Equatable {
    /// Paste a static API key/token — GitHub, Stripe, Render, etc.
    case pastedToken
    /// Real browser sign-in via the MCP spec's own OAuth discovery flow
    /// (RFC 9728 + 8414 + 7591 + PKCE) — see `MCPOAuth`. Verified per
    /// server before being marked this way — some OAuth-capable servers
    /// still don't qualify (no self-registration and no way for a client
    /// to get one, e.g. a reviewed-partner-only allowlist).
    case oauth
}

struct MCPServerDefinition: Identifiable, Equatable {
    let id: String
    let displayName: String
    let summary: String
    let endpoint: URL?
    let authMode: MCPAuthMode
    /// The `Authorization` header's scheme word — see `MCPClient.authScheme`
    /// for why this varies per vendor. Unused for `.oauth` (the access
    /// token is always a standard Bearer token per the OAuth spec).
    let authScheme: String
    /// Extra per-request headers this server needs beyond bare auth (e.g.
    /// GitHub's toolset-scoping extension).
    let extraHeaders: [String: String]
    let tokenCreationURL: URL?
    /// True only when `tokenCreationURL` actually pre-fills the right
    /// scopes/permissions via verified query parameters (GitHub only,
    /// today) — drives whether the UI is allowed to claim "the right
    /// permissions are already selected." Claiming that for a plain,
    /// unparameterized dashboard link would just be false.
    let tokenCreationURLIsPrefilled: Bool
    let tokenFieldPlaceholder: String
    /// An extra line shown under the token field for a service whose
    /// token needs something non-obvious to actually work — e.g.
    /// Cloudflare's token needing a specific permission before its tools
    /// will return anything. Nil for services with no such gotcha.
    let tokenHint: String?
    /// For `.oauth` servers that (per live discovery) don't support
    /// Dynamic Client Registration — verified case by case, e.g. Slack —
    /// where to go create one, and what to configure once there. Nil for
    /// every DCR-capable server, where this step doesn't exist at all.
    let manualClientIdSetupURL: URL?
    let manualClientIdHint: String?
    /// UserDefaults account key for this service's stored credentials
    /// (a pasted token, or — for `.oauth` — the DCR client id + access/
    /// refresh tokens). GitHub keeps its pre-existing literal key rather
    /// than the generated pattern, so the connection made while this was
    /// still GitHub-only doesn't silently orphan on this refactor.
    let tokenAccount: String
    /// Basename in Resources/BrandLogos (no extension) — see
    /// `BrandLogoLoader`.
    let logoAssetName: String

    static func == (lhs: MCPServerDefinition, rhs: MCPServerDefinition) -> Bool { lhs.id == rhs.id }
}

enum MCPCatalog {
    /// Every connectable service, in the order the Plugins page renders
    /// them. Merged with any custom servers the user has added — see
    /// `available` below, which is what every real consumer (the Plugins
    /// page, tool dispatch, the reconnect-at-launch loop) actually reads.
    static let builtIn: [MCPServerDefinition] = [
        .init(
            id: "github", displayName: "GitHub",
            summary: "Repos, issues, and pull requests.",
            endpoint: URL(string: "https://api.githubcopilot.com/mcp/"),
            authMode: .pastedToken,
            authScheme: "Bearer",
            extraHeaders: ["X-MCP-Toolsets": "repos,issues,pull_requests"],
            tokenCreationURL: Self.githubTokenCreationURL, tokenCreationURLIsPrefilled: true,
            tokenFieldPlaceholder: "Paste a GitHub personal access token", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "github-mcp-token",
            logoAssetName: "github"
        ),
        .init(
            id: "stripe", displayName: "Stripe",
            summary: "Payments, customers, invoices, and subscriptions.",
            endpoint: URL(string: "https://mcp.stripe.com"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://dashboard.stripe.com/apikeys"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Stripe restricted API key", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-stripe",
            logoAssetName: "stripe"
        ),
        .init(
            id: "sentry", displayName: "Sentry",
            summary: "Issues, errors, and releases.",
            endpoint: URL(string: "https://mcp.sentry.dev/mcp"),
            authMode: .pastedToken,
            authScheme: "Sentry-Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://sentry.io/settings/account/api/auth-tokens/"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Sentry auth token", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-sentry",
            logoAssetName: "sentry"
        ),
        .init(
            id: "cloudflare", displayName: "Cloudflare",
            summary: "DNS, Workers, and zones.",
            endpoint: URL(string: "https://mcp.cloudflare.com/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://dash.cloudflare.com/profile/api-tokens"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Cloudflare API token",
            tokenHint: "Include the \"Account Resources: Read\" permission — without it Cloudflare's server can't tell which account to use, and its tools silently come back empty.",
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-cloudflare",
            logoAssetName: "cloudflare"
        ),
        .init(
            id: "posthog", displayName: "PostHog",
            summary: "Product analytics and events.",
            endpoint: URL(string: "https://mcp.posthog.com/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://app.posthog.com/settings/user-api-keys"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a PostHog personal API key", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-posthog",
            logoAssetName: "posthog"
        ),
        .init(
            id: "semrush", displayName: "Semrush",
            summary: "SEO keywords, domain analytics, and competitor research.",
            endpoint: URL(string: "https://mcp.semrush.com/v2/mcp"),
            authMode: .pastedToken,
            authScheme: "Apikey", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://www.semrush.com/kb/92-api-key"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Semrush API key", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-semrush",
            logoAssetName: "semrush"
        ),
        .init(
            id: "linear", displayName: "Linear",
            summary: "Issues, projects, and cycles.",
            endpoint: URL(string: "https://mcp.linear.app/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://linear.app/settings/account/security"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Linear API key", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-linear",
            logoAssetName: "linear"
        ),
        .init(
            id: "supabase", displayName: "Supabase",
            summary: "Postgres, auth, and storage.",
            endpoint: URL(string: "https://mcp.supabase.com/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://supabase.com/dashboard/account/tokens"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Supabase personal access token", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-supabase",
            logoAssetName: "supabase"
        ),
        .init(
            id: "render", displayName: "Render",
            summary: "Services, deploys, and managed Postgres.",
            endpoint: URL(string: "https://mcp.render.com/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://dashboard.render.com/u/settings?add-api-key"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Render API key", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-render",
            logoAssetName: "render"
        ),
        .init(
            id: "neon", displayName: "Neon",
            summary: "Serverless Postgres with branching.",
            endpoint: URL(string: "https://mcp.neon.tech/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://console.neon.tech/app/settings/api-keys"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Neon API key", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-neon",
            logoAssetName: "neon"
        ),
        .init(
            id: "datadog", displayName: "Datadog",
            summary: "Metrics, logs, traces, and monitors.",
            endpoint: URL(string: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://app.datadoghq.com/personal-settings/access-tokens"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Datadog access token", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-datadog",
            logoAssetName: "datadog"
        ),
        .init(
            id: "resend", displayName: "Resend",
            summary: "Transactional and broadcast email.",
            endpoint: URL(string: "https://mcp.resend.com/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://resend.com/api-keys"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a Resend API key", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-resend",
            logoAssetName: "resend"
        ),
        .init(
            id: "notion", displayName: "Notion",
            summary: "Pages, databases, and docs.",
            endpoint: URL(string: "https://mcp.notion.com/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-notion",
            logoAssetName: "notion"
        ),
        .init(
            id: "vercel", displayName: "Vercel",
            summary: "Deployments, projects, and domains.",
            endpoint: URL(string: "https://mcp.vercel.com"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-vercel",
            logoAssetName: "vercel"
        ),
        .init(
            id: "launchdarkly", displayName: "LaunchDarkly",
            summary: "Feature flags and targeting.",
            endpoint: URL(string: "https://mcp.launchdarkly.com/mcp/launchdarkly"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-launchdarkly",
            logoAssetName: "launchdarkly"
        ),
        .init(
            id: "slack", displayName: "Slack",
            summary: "Messages, channels, and threads.",
            endpoint: URL(string: "https://mcp.slack.com/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            // Verified live: Slack's server has real OAuth discovery but
            // no registration_endpoint — no self-service registration
            // exists, so (unlike Notion/Vercel/LaunchDarkly) this needs a
            // client ID from an app you create yourself first.
            manualClientIdSetupURL: URL(string: "https://api.slack.com/apps"),
            manualClientIdHint: "Create a new app → OAuth & Permissions → add redirect URL \(MCPOAuth.redirectURI.absoluteString) → copy the Client ID from Basic Information.",
            tokenAccount: "mcp-oauth-slack",
            logoAssetName: "slack"
        ),
        .init(
            id: "clickup", displayName: "ClickUp",
            summary: "Tasks, docs, and spaces.",
            endpoint: URL(string: "https://mcp.clickup.com/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-clickup",
            logoAssetName: "clickup"
        ),
        .init(
            id: "trello", displayName: "Trello",
            summary: "Boards, cards, and lists.",
            endpoint: URL(string: "https://mcp.trello.com/v1"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-trello",
            logoAssetName: "trello"
        ),
        .init(
            id: "airtable", displayName: "Airtable",
            summary: "Bases, tables, and records.",
            endpoint: URL(string: "https://mcp.airtable.com/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://airtable.com/create/tokens"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste an Airtable personal access token",
            tokenHint: "Needs data.records:read/write, schema.bases:read/write, and workspacesAndBases:read — pick these scopes on Airtable's token creation page before generating it.",
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-airtable",
            logoAssetName: "airtable"
        ),
        .init(
            id: "monday", displayName: "monday.com",
            summary: "Boards, items, and updates.",
            endpoint: URL(string: "https://mcp.monday.com/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-monday",
            logoAssetName: "monday"
        ),
        .init(
            id: "asana", displayName: "Asana",
            summary: "Tasks, projects, and portfolios.",
            endpoint: URL(string: "https://mcp.asana.com/v2/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            // Verified live: Asana's authorization server (app.asana.com)
            // has no registration_endpoint — no self-service registration,
            // so this needs a client ID from an app created first.
            manualClientIdSetupURL: URL(string: "https://app.asana.com/0/my-apps"),
            manualClientIdHint: "Create new app → type \"MCP app\" → add redirect URL \(MCPOAuth.redirectURI.absoluteString) → copy the Client ID.",
            tokenAccount: "mcp-oauth-asana",
            logoAssetName: "asana"
        ),
        .init(
            id: "hubspot", displayName: "HubSpot",
            summary: "Contacts, deals, and tickets.",
            endpoint: URL(string: "https://mcp.hubspot.com"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            // Verified live: HubSpot's discovery doc has no
            // registration_endpoint — needs an app created first.
            manualClientIdSetupURL: URL(string: "https://app.hubspot.com/"),
            manualClientIdHint: "Development → MCP Auth Apps → Create MCP auth app → add redirect URL \(MCPOAuth.redirectURI.absoluteString) → copy the Client ID.",
            tokenAccount: "mcp-oauth-hubspot",
            logoAssetName: "hubspot"
        ),
        .init(
            id: "intercom", displayName: "Intercom",
            summary: "Conversations, contacts, and tickets.",
            endpoint: URL(string: "https://mcp.intercom.com/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-intercom",
            logoAssetName: "intercom"
        ),
        .init(
            id: "attio", displayName: "Attio",
            summary: "Records, lists, and notes.",
            endpoint: URL(string: "https://mcp.attio.com/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-attio",
            logoAssetName: "attio"
        ),
        .init(
            id: "gitlab", displayName: "GitLab",
            summary: "Repos, issues, and merge requests.",
            endpoint: URL(string: "https://gitlab.com/api/v4/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-gitlab",
            logoAssetName: "gitlab"
        ),
        .init(
            id: "pagerduty", displayName: "PagerDuty",
            summary: "Incidents, on-call, and services.",
            endpoint: URL(string: "https://mcp.pagerduty.com/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            // Verified live: no registration_endpoint, and PagerDuty's own
            // docs say Dynamic Client Registration isn't supported — needs
            // an app created first, with a fixed redirect URI.
            manualClientIdSetupURL: URL(string: "https://developer.pagerduty.com/apps"),
            manualClientIdHint: "Create a new app → OAuth 2.0 → add redirect URL \(MCPOAuth.redirectURI.absoluteString) → copy the Client ID.",
            tokenAccount: "mcp-oauth-pagerduty",
            logoAssetName: "pagerduty"
        ),
        .init(
            id: "digitalocean", displayName: "DigitalOcean",
            summary: "App Platform deploys and management.",
            endpoint: URL(string: "https://apps.mcp.digitalocean.com/mcp"),
            authMode: .pastedToken,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: URL(string: "https://cloud.digitalocean.com/account/api/tokens"), tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "Paste a DigitalOcean personal access token",
            tokenHint: "This connects App Platform specifically — DigitalOcean also runs separate MCP endpoints per resource (Droplets, Databases, Kubernetes, and more) that aren't wired up here yet.",
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-token-digitalocean",
            logoAssetName: "digitalocean"
        ),
        .init(
            id: "figma", displayName: "Figma",
            summary: "Files, frames, and comments.",
            endpoint: URL(string: "https://mcp.figma.com/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-figma",
            logoAssetName: "figma"
        ),
        .init(
            id: "exa", displayName: "Exa",
            summary: "AI-native web search.",
            endpoint: URL(string: "https://mcp.exa.ai/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-exa",
            logoAssetName: "exa"
        ),
        .init(
            id: "apify", displayName: "Apify",
            summary: "Web scraping and automation actors.",
            endpoint: URL(string: "https://mcp.apify.com"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            manualClientIdSetupURL: nil, manualClientIdHint: nil,
            tokenAccount: "mcp-oauth-apify",
            logoAssetName: "apify"
        ),
        .init(
            id: "dropbox", displayName: "Dropbox",
            summary: "Files, folders, and sharing.",
            endpoint: URL(string: "https://mcp.dropbox.com/mcp"),
            authMode: .oauth,
            authScheme: "Bearer", extraHeaders: [:],
            tokenCreationURL: nil, tokenCreationURLIsPrefilled: false,
            tokenFieldPlaceholder: "", tokenHint: nil,
            // Dropbox's discovery doc advertises a registration_endpoint,
            // but self-registration for a client not already on their
            // known-client allowlist is unconfirmed — a manual app is the
            // safe default rather than risking a silent failure on first
            // connect. If DCR does work for this client, the live
            // discovery check elsewhere finds that out and this hint
            // simply never surfaces.
            manualClientIdSetupURL: URL(string: "https://www.dropbox.com/developers/apps/"),
            manualClientIdHint: "Create app → Scoped access → add redirect URI \(MCPOAuth.redirectURI.absoluteString) → copy the App key.",
            tokenAccount: "mcp-oauth-dropbox",
            logoAssetName: "dropbox"
        ),
    ]

    /// The built-in, individually-verified catalog plus whatever custom
    /// servers the user has added (Settings → Plugins → Add Custom
    /// Server) — reading `CustomMCPServerStore.shared` requires the main
    /// actor, same as every other store this app merges into a live list
    /// this way (e.g. `ChatViewModel.allChatCapableModels` reading
    /// `CustomProviderStore.shared`).
    @MainActor
    static var available: [MCPServerDefinition] {
        builtIn + CustomMCPServerStore.shared.definitions
    }

    @MainActor
    static func definition(for id: String) -> MCPServerDefinition? {
        available.first { $0.id == id }
    }

    /// A pre-filled "create a token" deep link, so connecting never means
    /// hunting through GitHub's own settings — verified against GitHub's
    /// documented fine-grained-PAT template-URL query parameters (see the
    /// GitHub Changelog, "Template URLs for fine-grained PATs," 2025-08-26).
    /// Scoped to what the MCP server's tools actually need day to day
    /// (repo contents, issues, PRs); GitHub's own page still lets the user
    /// add or remove permissions before generating the token.
    private static var githubTokenCreationURL: URL {
        var components = URLComponents(string: "https://github.com/settings/personal-access-tokens/new")!
        components.queryItems = [
            URLQueryItem(name: "name", value: "Eaon"),
            URLQueryItem(name: "description", value: "Lets the Eaon app read and act on your repos, issues, and pull requests."),
            URLQueryItem(name: "contents", value: "write"),
            URLQueryItem(name: "issues", value: "write"),
            URLQueryItem(name: "pull_requests", value: "write"),
            URLQueryItem(name: "metadata", value: "read"),
        ]
        return components.url!
    }
}
