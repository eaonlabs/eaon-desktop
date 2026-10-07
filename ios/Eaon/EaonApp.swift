import SwiftUI

@main
struct EaonApp: App {
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            // `-lab` opens a still lens over test text, for tuning the optics.
            if ProcessInfo.processInfo.arguments.contains("-lab") {
                LensLab()
            } else {
                AppRoot()
            }
            #else
            AppRoot()
            #endif
        }
    }
}
