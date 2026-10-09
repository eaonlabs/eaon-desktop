import SwiftUI

/// The app once someone's in: Chat or Agents, with the drawer on the left and Settings as a sheet.
/// Opening the drawer pushes the screen aside as a card with rounded corners that greys a little,
/// the way ChatGPT's does. A swipe from the left edge of Chat opens it, a swipe left or a tap on the
/// screen closes it. Moving between screens brings the new one into focus.
struct AppShell: View {
    @Environment(AppNavigator.self) private var navigator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @GestureState private var drag: CGFloat = 0

    private static let edgeWidth: CGFloat = 26
    /// About the screen's own corner radius, so the pushed card looks like the screen itself moved.
    private static let cardRadius: CGFloat = 52

    var body: some View {
        @Bindable var navigator = navigator
        // The shell spans the whole display, so the pushed card's corners are the screen's own; the
        // drawer is handed the safe area to keep clear of the status bar and the home indicator.
        GeometryReader { outer in
            shell(insets: outer.safeAreaInsets)
                .ignoresSafeArea(.container)
        }
        .background(Palette.drawer.ignoresSafeArea())
        .sensoryFeedback(.impact(weight: .light, intensity: 0.6), trigger: navigator.drawerOpen)
        .onChange(of: navigator.drawerOpen) { _, open in
            if open { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
        .sheet(isPresented: $navigator.showsSettings) {
            SettingsView()
        }
    }

    private func shell(insets: EdgeInsets) -> some View {
        GeometryReader { proxy in
            let width = min(proxy.size.width * 0.8, 340)
            let open = navigator.drawerOpen
            let moved = clamp((open ? width : 0) + drag, 0, width)
            let fraction = width > 0 ? moved / width : 0

            ZStack(alignment: .leading) {
                SideDrawer(width: width)
                    .padding(.top, insets.top)
                    .padding(.bottom, insets.bottom)
                    .offset(x: (fraction - 1) * width * 0.25)
                    .opacity(0.2 + 0.8 * fraction)
                    .accessibilityHidden(!open)

                screen
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .background(Palette.background)
                    .overlay {
                        Palette.pushedTint
                            .opacity(0.08 * fraction)
                            .allowsHitTesting(false)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Self.cardRadius * fraction, style: .continuous))
                    .offset(x: moved)
                    .allowsHitTesting(!open)
                    .accessibilityHidden(open)
                    .overlay(alignment: .leading) {
                        // A thin strip along the left edge opens the drawer from Chat, where nothing else swipes from there.
                        if !open, navigator.screen == .chat {
                            Color.clear
                                .frame(width: Self.edgeWidth)
                                .contentShape(Rectangle())
                                .gesture(dragGesture(width: width, open: false))
                        }
                    }

                if open {
                    // Everything over the screen takes a tap, and a drag, to close it.
                    Color.clear
                        .contentShape(Rectangle())
                        .frame(width: max(proxy.size.width - width, 0), height: proxy.size.height)
                        .offset(x: width)
                        .onTapGesture { close() }
                        .gesture(dragGesture(width: width, open: true))
                        .accessibilityLabel("Close menu")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction { close() }
                }
            }
            .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.42, dampingFraction: 0.86), value: navigator.drawerOpen)
        }
    }

    private var screen: some View {
        ZStack {
            switch navigator.screen {
            case .chat: ChatView().transition(.focus)
            case .agents: AgentsView().transition(.focus)
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.2) : Springs.smooth, value: navigator.screen)
    }

    private func close() {
        navigator.drawerOpen = false
    }

    private func dragGesture(width: CGFloat, open: Bool) -> some Gesture {
        DragGesture(minimumDistance: 6)
            .updating($drag) { value, state, _ in
                state = open ? min(0, value.translation.width) : max(0, value.translation.width)
            }
            .onEnded { value in
                // Past a third of the way, or flicked that way: it goes the way the finger was going.
                let travelled = open ? width + value.translation.width : value.translation.width
                let predicted = open ? width + value.predictedEndTranslation.width : value.predictedEndTranslation.width
                navigator.drawerOpen = travelled > width * 0.4 || predicted > width * 0.7
            }
    }
}
