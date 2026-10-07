import SwiftUI

extension AgentPlace: Identifiable {
    var id: String { rawValue }
}

/// The Agents tab: the agents on this iPhone and on the connected Mac, in one place.
struct AgentsView: View {
    @Environment(AgentsStore.self) private var store
    @Environment(ModelCatalog.self) private var catalog
    @Environment(AppNavigator.self) private var navigator

    @State private var path: [AgentKey] = []
    @State private var creating: AgentPlace?
    @State private var deleting: Agent?
    #if DEBUG
    @State private var debugCreateHandled = false
    #endif

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if store.isEmpty && !catalog.macAgentsSupported {
                    EmptyAgents(onCreate: { creating = .phone }, onConnectMac: { navigator.showsConnectMac = true })
                } else {
                    list
                }
            }
            .background(ScreenBackground())
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { DrawerButton() }
                ToolbarItem(placement: .principal) { ScreenSwitch() }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("New agent on this iPhone", systemImage: "iphone") { creating = .phone }
                        if store.mac.isAvailable {
                            Button("New agent on \(catalog.macName)", systemImage: "laptopcomputer") { creating = .mac }
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New agent")
                }
            }
            .navigationDestination(for: AgentKey.self) { key in
                AgentDetailView(key: key)
            }
            .onChange(of: store.openRequest) { _, request in
                guard let request else { return }
                path = [request]
                store.openRequest = nil
            }
            .onAppear {
                #if DEBUG
                if DebugLaunch.sheet == "newAgent", !debugCreateHandled {
                    debugCreateHandled = true
                    creating = .phone
                }
                #endif
            }
        }
        .tint(Palette.ink)
        .sheet(item: $creating) { place in
            NewAgentView(place: place) { agent in
                path = [agent.key]
            }
        }
        .confirmationDialog(
            "Remove \(deleting?.name ?? "this agent")?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let agent = deleting { Task { try? await store.source(agent.place).remove(agent.key.id) } }
            }
        } message: {
            Text(deleting?.place == .mac ? "It stops and is forgotten on your Mac. Its folder stays there." : "Its conversation and notes are deleted from this iPhone.")
        }
    }

    // MARK: The list

    private var list: some View {
        List {
            Section {
                ForEach(store.phone.agents) { agent in
                    row(agent)
                }
                if store.phone.agents.isEmpty {
                    Button { creating = .phone } label: {
                        Label("Spin up an agent on this iPhone", systemImage: "plus")
                            .font(.body.weight(.medium))
                            .foregroundStyle(Palette.ink)
                    }
                    .listRowBackground(Palette.surface)
                }
            } header: {
                header("On this iPhone", symbol: "iphone", trailing: nil)
            } footer: {
                if !store.phone.agents.isEmpty {
                    Text("Phone agents work while Eaon is open, and remind you when a check-in is due.")
                }
            }

            Section {
                macRows
            } header: {
                header(catalog.macAgentsSupported ? catalog.macName : "Your Mac", symbol: "laptopcomputer", trailing: macStatus)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private func row(_ agent: Agent) -> some View {
        NavigationLink(value: agent.key) {
            AgentRow(agent: agent)
        }
        .listRowBackground(Palette.surface)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                deleting = agent
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading) {
            Button {
                Haptic.select()
                Task { await store.source(agent.place).setPaused(agent.key.id, paused: !agent.isPaused) }
            } label: {
                Label(agent.isPaused ? "Resume" : "Pause", systemImage: agent.isPaused ? "play.fill" : "pause.fill")
            }
            .tint(agent.isPaused ? Palette.positive : Palette.caution)
        }
    }

    @ViewBuilder private var macRows: some View {
        if !catalog.macAgentsSupported {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    IconTile(systemImage: "laptopcomputer")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(catalog.macAddress == nil ? "Control the agents on your Mac" : "This Mac's Eaon is out of date")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                        Text(catalog.macAddress == nil
                             ? "See what they're doing, talk to them, and approve what they ask, from here."
                             : "Update Eaon on the Mac to control its agents from this iPhone. Its models still work in Chat.")
                            .font(.footnote)
                            .foregroundStyle(Palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if catalog.macAddress == nil {
                    Button("Connect to your Mac") { navigator.showsConnectMac = true }
                        .buttonStyle(PillButtonStyle(kind: .primary))
                }
            }
            .padding(.vertical, 6)
            .listRowBackground(Palette.surface)
        } else {
            ForEach(store.mac.agents) { agent in
                row(agent)
            }
            if store.mac.agents.isEmpty {
                if case .failed(let message) = store.mac.connection {
                    Callout(kind: .error, title: "Can't reach \(catalog.macName)", message: message, actionTitle: "Check connection") { navigator.showsConnectMac = true }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                } else {
                    Button { creating = .mac } label: {
                        Label("Spin up an agent on \(catalog.macName)", systemImage: "plus")
                            .font(.body.weight(.medium))
                            .foregroundStyle(Palette.ink)
                    }
                    .listRowBackground(Palette.surface)
                    .disabled(!store.mac.isAvailable)
                }
            }
        }
    }

    private var macStatus: (text: String, color: Color, pulsing: Bool)? {
        guard catalog.macAgentsSupported else { return nil }
        switch store.mac.connection {
        case .live: return ("Live", Palette.positive, false)
        case .connecting: return ("Connecting", Palette.tint, true)
        case .failed: return ("Offline", Palette.negative, false)
        case .off: return nil
        }
    }

    private func header(_ title: String, symbol: String, trailing: (text: String, color: Color, pulsing: Bool)?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
            Text(title)
            Spacer()
            if let trailing {
                HStack(spacing: 6) {
                    StatusDot(color: trailing.color, pulsing: trailing.pulsing)
                    Text(trailing.text)
                }
                .font(.footnote.weight(.medium))
            }
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(Palette.secondary)
        .textCase(nil)
    }
}

/// One agent in a list: its face, its name, and what it is up to.
struct AgentRow: View {
    let agent: Agent

    var body: some View {
        HStack(spacing: 14) {
            AgentFace(agent: agent, size: 46)
                .frame(width: 56, height: 56)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(agent.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    if agent.unread > 0 {
                        Circle().fill(Palette.tint).frame(width: 8, height: 8)
                            .transition(.scale(scale: 0.2).combined(with: .opacity))
                            .accessibilityLabel("\(agent.unread) unread")
                    }
                }
                Text(AgentWords.line(for: agent))
                    .font(.subheadline)
                    .foregroundStyle(agent.needsYou ? Palette.tint : Palette.secondary)
                    .lineLimit(2)
                    .contentTransition(.opacity)
            }
        }
        .padding(.vertical, 4)
        .animation(Springs.smooth, value: AgentWords.line(for: agent))
        .animation(Springs.bouncy, value: agent.unread > 0)
        .accessibilityElement(children: .combine)
    }
}

/// Before the first agent: what they are, and the ways to start.
private struct EmptyAgents: View {
    var onCreate: () -> Void
    var onConnectMac: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                HStack(spacing: -10) {
                    AgentFace(colorHex: "#3E86C6", mood: .happy, size: 64, seed: 11)
                        .entrance(delay: 0.05, rise: 18, scale: 0.5, animation: Springs.bouncy)
                    AgentFace(colorHex: "#D6509B", mood: .curious, size: 76, seed: 22)
                        .zIndex(1)
                        .entrance(delay: 0.12, rise: 18, scale: 0.5, animation: Springs.bouncy)
                    AgentFace(colorHex: "#3FAE6A", mood: .neutral, size: 64, seed: 33)
                        .entrance(delay: 0.19, rise: 18, scale: 0.5, animation: Springs.bouncy)
                }
                .padding(.top, 36)

                VStack(spacing: 8) {
                    Text("Agents that get things done")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                    Text("Give an agent a job and it works on it: reading the web, keeping notes, adding reminders, checking in on its own. Run them on this iPhone, or control the ones on your Mac.")
                        .font(.subheadline)
                        .foregroundStyle(Palette.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 12)
                .entrance(delay: 0.26)

                VStack(spacing: 10) {
                    Button("Spin up an agent", action: onCreate)
                        .buttonStyle(PillButtonStyle(kind: .primary))
                    Button {
                        onConnectMac()
                    } label: {
                        Label("Control agents on your Mac", systemImage: "laptopcomputer")
                    }
                    .buttonStyle(PillButtonStyle(kind: .secondary))
                }
                .entrance(delay: 0.34)
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 40)
        }
    }
}
