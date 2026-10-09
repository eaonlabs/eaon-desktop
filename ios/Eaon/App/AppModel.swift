import Foundation
import UIKit

/// The app's long-lived state, made once. SwiftUI may rebuild `AppRoot` as
/// often as it likes; these stay the same objects, and their start-up work
/// (the Keychain check, reading the saved chats) runs once.
@MainActor
final class AppModel {
    static let shared = AppModel()

    let session: SessionStore
    let auth: AuthController
    let catalog: ModelCatalog
    let store: ChatStore
    let chat: ChatController
    let agents: AgentsStore
    let notifier: SystemAgentNotifier
    let navigator = AppNavigator()

    private init() {
        let session = SessionStore()
        let catalog = ModelCatalog()
        let store = ChatStore()
        #if DEBUG
        DebugLaunch.prepare(session: session, catalog: catalog, store: store)
        #endif
        self.session = session
        self.catalog = catalog
        self.store = store
        auth = AuthController(session: session)
        chat = ChatController(store: store, catalog: catalog)

        let notifier = SystemAgentNotifier()
        self.notifier = notifier
        let phone = PhoneAgents(notifier: notifier, resolveModel: { pinned in catalog.resolveAgentModel(pinned) })
        phone.isForeground = { UIApplication.shared.applicationState == .active }
        let mac = MacAgents()
        let agents = AgentsStore(phone: phone, mac: mac)
        self.agents = agents

        // The Mac's agents follow the Mac connection.
        catalog.onMacChange = { client, name in mac.configure(client: client, name: name) }
        catalog.announceMac()
        // A tapped notification opens that agent.
        let navigator = navigator
        notifier.onOpen = { id in
            agents.openRequest = AgentKey(place: .phone, id: id)
            navigator.screen = .agents
        }
        #if DEBUG
        if DebugLaunch.has("-resetAll") { phone.eraseAll() }
        #endif
        phone.startScheduler()
    }
}
