import Observation

/// What the main area is showing. The switch at the top of each moves between them.
enum AppScreen: Hashable {
    case chat
    case agents
}

/// Which screen is showing, whether the drawer or Settings is open, so a button in one place can take you to another.
@MainActor
@Observable
final class AppNavigator {
    var screen: AppScreen = .chat
    var drawerOpen = false
    /// Settings, as a sheet over whichever screen is showing.
    var showsSettings = false
    /// Shows the sheet for connecting to a Mac, from wherever the person asked.
    var showsConnectMac = false
    /// An eaon://pair link that arrived, waiting for the person to confirm it.
    var pairingLink: PairingLink?

    func go(_ screen: AppScreen) {
        self.screen = screen
        drawerOpen = false
    }

    func openSettings() {
        drawerOpen = false
        showsSettings = true
    }
}
