#if DEBUG
import Foundation
import UIKit

/// Launch arguments for putting a Debug build in a state, to look at or to test.
///
///     -guest                     come in as a guest
///     -demoAccount apple|github  come in as a made-up person
///     -connectMac "host:port|key"  connect to a real Mac server, as the pairing screen would
///     -demoMac                   pretend a Mac is connected, with two models and two agents
///     -demoAgents                give the phone three agents with something going on
///     -newAgent "Name|access|purpose"   make a real phone agent
///     -agentSend "Name|text"     write to a phone agent (with -asGoal, as its goal)
///     -openAgent <name>          open that agent's page
///     -seedChats                 put a few chats in the history
///     -tab chat|agents|settings  start on a screen
///     -drawer                    open the drawer
///     -temporary                 start a temporary chat
///     -attachDemo                put a picture and a file in the composer
///     -sheet attach|picker|provider|github|connectMac|issue   open a sheet
///     -demoProvider <address>    add a provider at that address (a fake server, say) and use it
///     -startGitHub               start the real GitHub sign-in (asks github.com for a code)
///     -githubClientID <id|none>  use another client id, or pretend there isn't one
///     -send <text>               send a message once launched
///     -resetAll                  forget everything first
enum DebugLaunch {
    private static let arguments = ProcessInfo.processInfo.arguments

    static func value(after flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    static func has(_ flag: String) -> Bool { arguments.contains(flag) }

    @MainActor
    static func prepare(session: SessionStore, catalog: ModelCatalog, store: ChatStore) {
        if has("-resetAll") {
            catalog.eraseEverything()
            store.deleteAll()
            session.eraseEverything()
        }
        if has("-guest") { session.continueAsGuest() }
        if let provider = value(after: "-demoAccount") {
            session.signIn(
                provider == "github"
                    ? Account(provider: .github, id: "1", name: "Alex Rivera", email: nil, handle: "alexrivera", avatarURL: nil)
                    : Account(provider: .apple, id: "demo.apple", name: "Alex Rivera", email: "alex@example.com", handle: nil, avatarURL: nil)
            )
        }
        if has("-demoMac") { catalog.installDemoMac() }
        if let address = value(after: "-demoProvider") {
            let provider = Provider(name: "Demo server", baseURL: address, modelID: "demo-model")
            catalog.save(provider, key: "demo")
            catalog.select(ModelRef(source: .provider(provider.id), id: provider.modelID, name: provider.modelID, detail: provider.name))
        }
        if has("-seedChats") { seed(store) }
    }

    @MainActor
    static func afterLaunch(auth: AuthController, navigator: AppNavigator, chat: ChatController, agents: AgentsStore, catalog: ModelCatalog) async {
        // "host:port|key": connect to a Mac the way the pairing screen does.
        if let spec = value(after: "-connectMac") {
            let parts = spec.components(separatedBy: "|")
            if parts.count == 2 { try? await catalog.connectMac(address: parts[0], key: parts[1]) }
        }
        if has("-demoAgents") { agents.phone.installDemo() }
        // "Name|access|what it's for": a real phone agent, made the way the sheet makes one.
        if let spec = value(after: "-newAgent") {
            let parts = spec.components(separatedBy: "|")
            var draft = AgentDraft(name: parts.first ?? "Agent", purpose: parts.count > 2 ? parts[2] : "Helps out.")
            draft.access = AgentAccess(rawValue: parts.count > 1 ? parts[1] : "autonomous") ?? .autonomous
            _ = try? await agents.phone.create(draft)
        }
        // "Name|what to say": mail to a phone agent.
        if let spec = value(after: "-agentSend") {
            let parts = spec.components(separatedBy: "|")
            if parts.count > 1, let agent = agents.phone.agents.first(where: { $0.name == parts[0] }) {
                try? await Task.sleep(for: .seconds(1))
                try? await agents.phone.send(agent.key.id, text: parts[1], asGoal: has("-asGoal"))
            }
        }
        if has("-demoMac") { agents.mac.installDemo() }
        if let name = value(after: "-openAgent") {
            // A Mac's agents arrive a moment after it connects.
            for _ in 0..<60 where !agents.all.contains(where: { $0.name == name }) { try? await Task.sleep(for: .milliseconds(100)) }
            if let agent = agents.all.first(where: { $0.name == name }) {
                navigator.screen = .agents
                try? await Task.sleep(for: .milliseconds(600))
                agents.openRequest = agent.key
            }
        }
        if value(after: "-sheet") == "connectMac" { navigator.showsConnectMac = true }
        switch value(after: "-tab") {
        case "agents": navigator.screen = .agents
        case "settings": navigator.showsSettings = true
        default: break
        }
        if has("-temporary") { chat.startTemporary() }
        if has("-attachDemo") { attachDemo(to: chat) }
        if has("-drawer") {
            try? await Task.sleep(for: .milliseconds(400))
            navigator.drawerOpen = true
        }
        if value(after: "-sheet") == "github" { auth.showDemoGitHubCode() }
        if value(after: "-sheet") == "issue" { auth.showDemoIssue() }
        if has("-startGitHub") { await auth.startGitHub() }
        if let text = value(after: "-send") {
            try? await Task.sleep(for: .seconds(1))
            chat.send(text)
        }
    }

    /// A made-up picture and a short document, in the composer.
    @MainActor
    private static func attachDemo(to chat: ChatController) {
        let size = CGSize(width: 900, height: 700)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            let colors = [UIColor(hex: 0xE7B727).cgColor, UIColor(hex: 0x3E86C6).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
        }
        if let data = image.jpegData(compressionQuality: 0.9), let draft = try? AttachmentLoader.draft(fromImage: data, name: "Sunset") {
            chat.attach(draft)
        }
        if let draft = try? AttachmentLoader.draft(fromText: "Meeting notes\n- ship the iPhone app\n- review the agents", name: "notes.txt") {
            chat.attach(draft)
        }
    }

    @MainActor
    private static func seed(_ store: ChatStore) {
        guard store.conversations.isEmpty else { return }
        let now = Date()
        func chat(_ title: String, _ question: String, _ answer: String, ago: TimeInterval) -> Conversation {
            Conversation(
                title: title,
                messages: [ChatMessage(role: .user, text: question), ChatMessage(role: .assistant, text: answer)],
                model: .onDevice,
                updated: now.addingTimeInterval(-ago)
            )
        }
        for conversation in [
            chat("Explain how tides work", "Explain how tides work", "Tides come from the **Moon's gravity** pulling on the oceans.\n\n- The side facing the Moon bulges\n- So does the opposite side\n- The Earth turns through both bulges each day", ago: 3_600),
            chat("Dinner ideas with chicken", "Give me three dinner ideas with chicken and rice", "1. Lemon chicken with herb rice\n2. Chicken fried rice\n3. Coconut chicken curry over rice", ago: 90_000),
            chat("Polite decline", "Write a polite message turning down an invitation", "Thank you so much for thinking of me. I can't make it, but I hope it's a wonderful evening.", ago: 400_000)
        ].reversed() {
            store.upsert(conversation)
        }
    }

    static var sheet: String? { value(after: "-sheet") }
}
#endif
