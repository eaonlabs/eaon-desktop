import Foundation
import UserNotifications

/// How an agent reaches the person when Eaon isn't in front of them.
@MainActor
protocol AgentNotifier: AnyObject {
    func requestPermission() async
    /// A notice now: a question, or news.
    func post(title: String, body: String, agentID: String)
    /// A reminder that the agent is due to check in at `date`, replacing any earlier one for it.
    func scheduleWake(agentID: String, name: String, at date: Date)
    func cancelWake(agentID: String)
}

/// Local notifications. An agent on the phone can't run while the app is closed,
/// so a scheduled check-in is a reminder to open Eaon; the agent then runs.
@MainActor
final class SystemAgentNotifier: NSObject, AgentNotifier, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    /// Called with an agent's id when its notification is tapped.
    var onOpen: (String) -> Void = { _ in }

    override init() {
        super.init()
        center.delegate = self
    }

    func requestPermission() async {
        #if DEBUG
        if DebugLaunch.has("-noNotificationPrompt") { return }
        #endif
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func post(title: String, body: String, agentID: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["agent": agentID]
        center.add(UNNotificationRequest(identifier: "agent.\(agentID).\(UUID().uuidString)", content: content, trigger: nil))
    }

    func scheduleWake(agentID: String, name: String, at date: Date) {
        cancelWake(agentID: agentID)
        guard date.timeIntervalSinceNow > 5 else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(name) is ready to check in"
        content.body = "Open Eaon and it will pick up where it left off."
        content.sound = .default
        content.userInfo = ["agent": agentID]
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: date.timeIntervalSinceNow, repeats: false)
        center.add(UNNotificationRequest(identifier: "agent.wake.\(agentID)", content: content, trigger: trigger))
    }

    func cancelWake(agentID: String) {
        center.removePendingNotificationRequests(withIdentifiers: ["agent.wake.\(agentID)"])
    }

    // Shown even while Eaon is open: a question from an agent is worth a banner.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let agent = response.notification.request.content.userInfo["agent"] as? String else { return }
        await MainActor.run { onOpen(agent) }
    }
}

/// Records what it was asked, for tests.
@MainActor
final class RecordingAgentNotifier: AgentNotifier {
    struct Post: Equatable {
        var title: String
        var body: String
        var agentID: String
    }

    private(set) var posts: [Post] = []
    private(set) var wakes: [String: Date] = [:]
    private(set) var permissionRequests = 0

    func requestPermission() async { permissionRequests += 1 }
    func post(title: String, body: String, agentID: String) { posts.append(Post(title: title, body: body, agentID: agentID)) }
    func scheduleWake(agentID: String, name: String, at date: Date) { wakes[agentID] = date }
    func cancelWake(agentID: String) { wakes[agentID] = nil }
}
