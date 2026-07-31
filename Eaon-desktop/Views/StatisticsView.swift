import SwiftUI

enum StatisticsTab: String, CaseIterable, Identifiable {
    case usage = "Usage"
    case cost  = "Cost"
    var id: String { rawValue }
}

/// Settings → Statistics. Follows the same shell as every other settings
/// page — 32pt gutters, a title/description block, then `SettingsCard`s at
/// 16pt spacing — rather than the tighter one-off metrics dashboard this
/// used to be. The numbers are unchanged; only their presentation is.
struct StatisticsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable var chatViewModel: ChatViewModel
    @Bindable private var tracker = StatisticsTracker.shared
    @Bindable private var appearance = AppearanceSettings.shared

    @AppStorage("nerd_hud_enabled") private var nerdHUDEnabled = false
    @State private var rangeStart = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
    @State private var rangeEnd = Date()
    @State private var now = Date()
    @State private var activeTab: StatisticsTab = .usage
    /// Which quick-range chip is lit. Cleared when either date picker is
    /// touched, so the chip never claims a range the fields don't show.
    @State private var activePreset: String? = "7 Days"

    private let weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    private var dateRange: ClosedRange<Date> {
        let start = Calendar.current.startOfDay(for: rangeStart)
        let end = Calendar.current.date(bySettingHour: 23, minute: 59, second: 59, of: rangeEnd) ?? rangeEnd
        return start...end
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Statistics")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 8)

            Text("What you've run through Eaon, and what it would have cost. All of it is measured on this Mac and stored here. Nothing is reported anywhere.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 16)

            tabPicker
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch activeTab {
                    case .usage:
                        liveCard
                        sessionMetricsGrid
                        dateRangeCard
                        usagePatternCard
                        promptsByModelCard
                        mostActiveDayCard

                    case .cost:
                        dateRangeCard
                        costOverviewCard
                        costByModelCard
                        costByDayCard
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .onAppear { refreshChatSnapshot() }
        .onChange(of: chatViewModel.messages.count) { _, _ in refreshChatSnapshot() }
        .onChange(of: chatViewModel.inputText) { _, _ in refreshChatSnapshot() }
        .onChange(of: chatViewModel.selectedModel) { _, _ in refreshChatSnapshot() }
        .onChange(of: chatViewModel.isGenerating) { _, _ in refreshChatSnapshot() }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { tick in
            now = tick
            tracker.tickTPMHistory()
            refreshChatSnapshot()
        }
    }

    // MARK: - Tabs

    /// Sized to its content and left-aligned under the description, rather
    /// than bottom-pinned opposite the page title — no other settings page
    /// puts a control on the title line.
    private var tabPicker: some View {
        HStack(spacing: 0) {
            ForEach(StatisticsTab.allCases) { tab in
                Button {
                    activeTab = tab
                } label: {
                    Text(tab.rawValue)
                        .font(AppFont.mono(12, weight: .semibold))
                        .foregroundColor(activeTab == tab ? colors.textPrimary : colors.textSecondary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 6)
                        .background(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(activeTab == tab ? colors.backgroundSelected : Color.clear)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(colors.backgroundInputSecondary)
        )
        .fixedSize()
        .animation(.easeOut(duration: 0.12), value: activeTab)
    }

    // MARK: - Live

    /// The floating-HUD switch and the live chart it mirrors, in one card.
    /// Both were previously loose views sitting outside the card system, so
    /// they read as leftovers above the page rather than part of it.
    private var liveCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Stats for Nerds")
                            .font(AppFont.mono(14, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                        Text(nerdHUDEnabled
                             ? "On. A live counter floats over the app while you chat."
                             : "Off. Shows a live counter over the app while you chat.")
                            .font(AppFont.mono(12))
                            .foregroundColor(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }
                    Spacer(minLength: 0)
                    Toggle("", isOn: $nerdHUDEnabled)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .tint(AppearanceSettings.toggleTint)
                }
                .padding(16)

                if nerdHUDEnabled {
                    Divider().overlay(colors.borderSubtle)

                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Corner")
                                .font(AppFont.mono(14, weight: .semibold))
                                .foregroundColor(colors.textPrimary)
                            Text("Where the counter sits on screen.")
                                .font(AppFont.mono(12))
                                .foregroundColor(colors.textTertiary)
                        }
                        Spacer(minLength: 0)
                        Picker("", selection: $appearance.notificationPosition) {
                            ForEach(NotificationPosition.allCases) { pos in
                                Text(pos.rawValue).tag(pos)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                        .fixedSize()
                        .tint(appearance.accentColor)
                    }
                    .padding(16)
                }

                Divider().overlay(colors.borderSubtle)

                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 12) {
                        cardHeading(icon: "waveform.path.ecg",
                                    title: "Throughput",
                                    subtitle: "The last minute of activity, updated every second.")
                        Spacer(minLength: 0)
                    }

                    HStack(spacing: 8) {
                        liveChip("RPM", "\(tracker.liveRPM)")
                        liveChip("TPM", "\(tracker.liveTPM)")
                        liveChip("tok/s", String(format: "%.0f", tracker.tokensPerSecond))
                    }

                    LineChartView(points: tracker.tpmChartValues, tint: appearance.accentColor)
                        .frame(height: 120)
                }
                .padding(16)
            }
        }
        .animation(.easeOut(duration: 0.15), value: nerdHUDEnabled)
    }

    private func liveChip(_ label: String, _ value: String) -> some View {
        HStack(spacing: 5) {
            Text(label)
                .font(AppFont.mono(10, weight: .semibold))
                .foregroundColor(colors.textTertiary)
            Text(value)
                .font(AppFont.mono(12, weight: .semibold))
                .foregroundColor(colors.textPrimary)
                .monospacedDigit()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(colors.backgroundChip)
        )
    }

    // MARK: - Session metrics

    /// Was three fixed columns of 11pt mono in a ~616pt pane, which left
    /// every label truncated or wrapped. An adaptive grid gives each card
    /// room to hold "Total characters (all chats)" on one line and reflows
    /// to a single column when the window is narrow.
    private var sessionMetricsGrid: some View {
        VStack(alignment: .leading, spacing: 16) {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 268), spacing: 16, alignment: .top)],
                alignment: .leading,
                spacing: 16
            ) {
                runtimePanel
                currentChatPanel
                enginePanel
                totalsPanel
            }

            Text("Token counts are estimates, worked out live from character count at roughly 4 characters per token.")
                .font(AppFont.sans(11))
                .foregroundColor(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
    }

    private var runtimePanel: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                cardHeading(icon: "bolt.fill", title: "Runtime", subtitle: nil)

                headline(StatisticsTracker.formatUptime(tracker.sessionUptime))
                Text("Session uptime")
                    .font(AppFont.mono(11))
                    .foregroundColor(colors.textTertiary)

                VStack(spacing: 8) {
                    metricRow("Live RPM", "\(tracker.liveRPM)")
                    metricRow("Live TPM", "\(tracker.liveTPM)")
                    metricRow("Tokens/sec", String(format: "%.0f", tracker.tokensPerSecond))
                }

                Divider().overlay(colors.borderSubtle)

                VStack(spacing: 8) {
                    badgeRow("Online", tracker.isOnline ? "Yes" : "No", style: tracker.isOnline ? .success : .idle)
                    badgeRow("Connection", tracker.connectionState, style: .idle)
                    badgeRow("Sync", tracker.syncState, style: .idle)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var currentChatPanel: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                cardHeading(icon: "bubble.left.and.bubble.right.fill", title: "This chat", subtitle: nil)

                headline(tracker.hasActiveChat ? "Active" : "Nothing open")
                Text(tracker.isGenerating ? "Generating a reply now" : "Idle")
                    .font(AppFont.mono(11))
                    .foregroundColor(colors.textTertiary)

                VStack(spacing: 8) {
                    metricRow("Messages", "\(tracker.currentMessageCount)")
                    metricRow("From you", "\(tracker.currentUserMessageCount)")
                    metricRow("From the model", "\(tracker.currentAIMessageCount)")
                    metricRow("Characters", "\(tracker.currentCharacterCount)")
                    metricRow("Approx. tokens", "\(tracker.currentApproxTokens)")
                    metricRow("Draft length", "\(tracker.draftLength)")
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var enginePanel: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                cardHeading(icon: "cpu", title: "Engine", subtitle: nil)

                headline(tracker.selectedEngine)
                Text("Storing chats locally")
                    .font(AppFont.mono(11))
                    .foregroundColor(colors.textTertiary)

                VStack(spacing: 8) {
                    metricRow("Generating", tracker.isGenerating ? "Yes" : "No")
                    metricRow("Tokens this session", "\(tracker.sessionGeneratedTokens)")
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var totalsPanel: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                cardHeading(icon: "tray.full.fill", title: "All time", subtitle: nil)

                headline("\(tracker.totalChats) chats")
                Text("Everything stored on this Mac")
                    .font(AppFont.mono(11))
                    .foregroundColor(colors.textTertiary)

                VStack(spacing: 8) {
                    metricRow("Prompts in range", "\(tracker.prompts(in: dateRange).count)")
                    metricRow("Characters", "\(tracker.totalAllCharacters)")
                    metricRow("Approx. tokens", "\(tracker.totalAllApproxTokens)")
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Range

    private var dateRangeCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 14) {
                cardHeading(icon: "calendar.badge.clock",
                            title: "Date range",
                            subtitle: "Everything below is counted over these days.")

                HStack(spacing: 8) {
                    rangeButton("Today", todayOnly: true)
                    rangeButton("7 Days", days: -7)
                    rangeButton("30 Days", days: -30)
                }

                Divider().overlay(colors.borderSubtle)

                HStack(spacing: 24) {
                    dateField("From", selection: $rangeStart)
                    dateField("To", selection: $rangeEnd)
                    Spacer(minLength: 0)
                }
            }
            .padding(16)
        }
    }

    // MARK: - Historical

    private var usagePatternCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 14) {
                cardHeading(icon: "chart.xyaxis.line",
                            title: "Prompts over time",
                            subtitle: "How many messages you sent on each day in range.")

                DayCountChartView(data: tracker.promptsByDay(in: dateRange),
                                  tint: appearance.accentColor)
                    .frame(height: 150)
            }
            .padding(16)
        }
    }

    private var promptsByModelCard: some View {
        let byModel = tracker.promptsByModel(in: dateRange)
        let maxCount = byModel.map(\.count).max() ?? 1
        return SettingsCard {
            VStack(alignment: .leading, spacing: 14) {
                cardHeading(icon: "square.stack.3d.up.fill",
                            title: "Prompts by model",
                            subtitle: "Which models you actually reached for.")

                if byModel.isEmpty {
                    emptyState("Nothing yet. Send a message and it shows up here.")
                } else {
                    VStack(spacing: 10) {
                        ForEach(byModel, id: \.modelId) { item in
                            HStack(spacing: 10) {
                                BrandLogoView(brand: ModelCatalog.brand(for: item.modelId), size: 16)
                                    .frame(width: 20)

                                Text(ModelCatalog.displayName(modelId: item.modelId, apiName: nil))
                                    .font(AppFont.mono(12, weight: .medium))
                                    .foregroundColor(colors.textPrimary)
                                    .lineLimit(1)
                                    .frame(minWidth: 110, maxWidth: 170, alignment: .leading)

                                barTrack(fraction: CGFloat(item.count) / CGFloat(max(maxCount, 1)),
                                         tint: appearance.accentColor)

                                Text("\(item.count)")
                                    .font(AppFont.mono(12, weight: .semibold))
                                    .foregroundColor(colors.textSecondary)
                                    .monospacedDigit()
                                    .frame(width: 36, alignment: .trailing)
                            }
                        }
                    }
                }
            }
            .padding(16)
        }
    }

    private var mostActiveDayCard: some View {
        let weekday = tracker.mostActiveWeekday(in: dateRange)
        let counts = sundayFirstWeekdayCounts()

        return SettingsCard {
            VStack(alignment: .leading, spacing: 14) {
                cardHeading(icon: "calendar",
                            title: "Busiest day",
                            subtitle: "Prompts by weekday, added up across the range.")

                Text(weekday.name == "—" ? "Not enough data yet" : weekday.name)
                    .font(AppFont.mono(weekday.name == "—" ? 15 : 22, weight: .bold))
                    .foregroundColor(weekday.name == "—" ? colors.textTertiary : appearance.accentColor)

                VStack(spacing: 9) {
                    ForEach(0..<7, id: \.self) { index in
                        weekdayBarRow(label: weekdayLabels[index], count: counts[index])
                    }
                }
            }
            .padding(16)
        }
    }

    // MARK: - Shared pieces

    private func refreshChatSnapshot() {
        let model = chatViewModel.chatModels.first { $0.id == chatViewModel.selectedModel }
        tracker.syncChatState(
            messages: chatViewModel.messages,
            draft: chatViewModel.inputText,
            modelId: chatViewModel.selectedModel,
            modelName: model?.name,
            generating: chatViewModel.isGenerating
        )
    }

    private func sundayFirstWeekdayCounts() -> [Int] {
        let monFirst = tracker.weekdayCounts(in: dateRange)
        guard monFirst.count == 7 else { return Array(repeating: 0, count: 7) }
        return [monFirst[6], monFirst[0], monFirst[1], monFirst[2], monFirst[3], monFirst[4], monFirst[5]]
    }

    /// The card header used on every settings page: icon chip, 14pt
    /// semibold title, optional 12pt subtitle. Replaces this page's old
    /// all-caps 10pt mono section labels, which appeared nowhere else.
    @ViewBuilder
    private func cardHeading(icon: String, title: String, subtitle: String?) -> some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(colors.backgroundSubtle)
                    .frame(width: 30, height: 30)
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(colors.textSecondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                if let subtitle {
                    Text(subtitle)
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func headline(_ text: String) -> some View {
        Text(text)
            .font(AppFont.mono(17, weight: .bold))
            .foregroundColor(colors.textPrimary)
            .lineLimit(2)
            .minimumScaleFactor(0.8)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func metricRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label)
                .font(AppFont.mono(12))
                .foregroundColor(colors.textSecondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(value)
                .font(AppFont.mono(12, weight: .medium))
                .foregroundColor(colors.textPrimary)
                .monospacedDigit()
                .lineLimit(1)
        }
    }

    private func emptyState(_ text: String) -> some View {
        Text(text)
            .font(AppFont.sans(12))
            .foregroundColor(colors.textTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10)
    }

    private func barTrack(fraction: CGFloat, tint: Color) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(colors.backgroundSubtle)
                Capsule()
                    .fill(tint.opacity(0.8))
                    .frame(width: max(fraction > 0 ? 6 : 0, geo.size.width * min(max(fraction, 0), 1)))
            }
        }
        .frame(height: 7)
    }

    private enum BadgeStyle { case success, idle }

    /// Same tinted-capsule convention as `ModelFitBadge`/`ProviderBadge`
    /// elsewhere in the app (foreground color at low opacity as its own
    /// background) instead of a separately hand-picked dark fill — that
    /// approach only ever looked right in dark mode, since a flat literal
    /// like #1a3d2e reads as a muddy blob against a light background.
    /// `.idle` uses the app's own neutral secondary color rather than an
    /// arbitrary third hue, since nothing about "idle" is semantically
    /// orange.
    private func badgeRow(_ label: String, _ value: String, style: BadgeStyle) -> some View {
        let tint = style == .success ? StatisticsView.positive : colors.textSecondary
        return HStack(spacing: 10) {
            Text(label)
                .font(AppFont.mono(12))
                .foregroundColor(colors.textSecondary)
            Spacer(minLength: 8)
            Text(value)
                .font(AppFont.mono(10, weight: .semibold))
                .foregroundColor(tint)
                .lineLimit(1)
                .padding(.horizontal, 9)
                .padding(.vertical, 3)
                .background(Capsule().fill(tint.opacity(0.16)))
        }
    }

    private func dateField(_ label: String, selection: Binding<Date>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(AppFont.mono(11))
                .foregroundColor(colors.textTertiary)
            DatePicker("", selection: selection, displayedComponents: .date)
                .labelsHidden()
                .datePickerStyle(.field)
                .tint(appearance.accentColor)
                .onChange(of: selection.wrappedValue) { _, _ in activePreset = nil }
        }
    }

    /// Chips match the app's other selectable pills: rounded rect, chip
    /// fill, and a lit state so the range in effect is visible rather than
    /// inferred from the two date fields.
    private func rangeButton(_ title: String, days: Int = 0, todayOnly: Bool = false) -> some View {
        let isActive = activePreset == title
        return Button {
            if todayOnly {
                rangeStart = Calendar.current.startOfDay(for: Date())
                rangeEnd = Date()
            } else {
                rangeEnd = Date()
                rangeStart = Calendar.current.date(byAdding: .day, value: days, to: rangeEnd) ?? rangeEnd
            }
            activePreset = title
        } label: {
            Text(title)
                .font(AppFont.mono(12, weight: .medium))
                .foregroundColor(isActive ? colors.textPrimary : colors.textSecondary)
                .padding(.horizontal, 13)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(isActive ? colors.backgroundSelected : colors.backgroundChip)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(isActive ? colors.borderMedium : Color.clear, lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func weekdayBarRow(label: String, count: Int) -> some View {
        HStack(spacing: 10) {
            Text(label)
                .font(AppFont.mono(12))
                .foregroundColor(colors.textSecondary)
                .frame(width: 32, alignment: .leading)

            barTrack(fraction: CGFloat(count) / CGFloat(max(sundayFirstWeekdayCounts().max() ?? 1, 1)),
                     tint: appearance.accentColor)

            Text("\(count)")
                .font(AppFont.mono(12))
                .foregroundColor(colors.textSecondary)
                .monospacedDigit()
                .frame(width: 24, alignment: .trailing)
        }
        .frame(height: 16)
    }
}

// MARK: - Cost cards

extension StatisticsView {
    /// One green for money, defined once. It was previously written out as
    /// `#34C759` in four separate places in this file.
    static let positive = Color(hex: "#34C759")

    var costOverviewCard: some View {
        let totalTok = tracker.totalTokens(in: dateRange)
        let allByModel = tracker.tokensByModel(in: dateRange)
        let totalCost = allByModel.reduce(0.0) { sum, entry in
            let tier = chatViewModel.availableModels.first { $0.id == entry.modelId }?.tier
            return sum + ModelPricingStore.estimatedCost(tokens: entry.tokens, modelId: entry.modelId, tier: tier)
        }

        return SettingsCard {
            HStack(spacing: 0) {
                costStatCell("Tokens generated", value: "\(totalTok)", icon: "number", color: appearance.accentColor)
                Divider().overlay(colors.borderSubtle).frame(height: 54)
                costStatCell("Estimated cost", value: ModelPricingStore.formatCost(totalCost), icon: "dollarsign.circle", color: StatisticsView.positive)
                Divider().overlay(colors.borderSubtle).frame(height: 54)
                costStatCell("Models used", value: "\(allByModel.count)", icon: "cpu", color: colors.textSecondary)
            }
            .padding(.vertical, 18)
        }
    }

    private func costStatCell(_ label: String, value: String, icon: String, color: Color) -> some View {
        VStack(spacing: 7) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(color)
            Text(value)
                .font(AppFont.mono(18, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(AppFont.mono(11))
                .foregroundColor(colors.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity)
    }

    var costByModelCard: some View {
        let byModel = tracker.tokensByModel(in: dateRange)
        let maxTok = byModel.first?.tokens ?? 1

        return SettingsCard {
            VStack(alignment: .leading, spacing: 14) {
                cardHeading(icon: "chart.bar.fill",
                            title: "Cost by model",
                            subtitle: "Estimated from output tokens over the range.")

                if byModel.isEmpty {
                    emptyState("No token data yet. Start chatting and cost estimates show up here.")
                } else {
                    VStack(spacing: 10) {
                        ForEach(byModel, id: \.modelId) { entry in
                            let tier = chatViewModel.availableModels.first { $0.id == entry.modelId }?.tier
                            let cost = ModelPricingStore.estimatedCost(tokens: entry.tokens, modelId: entry.modelId, tier: tier)
                            costModelRow(modelId: entry.modelId, tokens: entry.tokens, cost: cost, maxTokens: maxTok)
                        }
                    }

                    Divider().overlay(colors.borderSubtle)

                    Text("These are approximations, based on roughly $0.005 to $0.020 per 1K output tokens depending on the model's tier. Check your provider's bill for the real number.")
                        .font(AppFont.sans(11))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
            }
            .padding(16)
        }
    }

    private func costModelRow(modelId: String, tokens: Int, cost: Double, maxTokens: Int) -> some View {
        HStack(spacing: 10) {
            BrandLogoView(brand: ModelCatalog.brand(for: modelId), size: 16)
                .frame(width: 20)

            Text(ModelCatalog.displayName(modelId: modelId, apiName: nil))
                .font(AppFont.mono(12, weight: .medium))
                .foregroundColor(colors.textPrimary)
                .lineLimit(1)
                .frame(minWidth: 110, maxWidth: 170, alignment: .leading)

            barTrack(fraction: CGFloat(tokens) / CGFloat(max(maxTokens, 1)),
                     tint: appearance.accentColor)

            Text("\(tokens) tok")
                .font(AppFont.mono(11))
                .foregroundColor(colors.textSecondary)
                .monospacedDigit()
                .frame(width: 74, alignment: .trailing)

            Text(ModelPricingStore.formatCost(cost))
                .font(AppFont.mono(11, weight: .semibold))
                .foregroundColor(StatisticsView.positive)
                .monospacedDigit()
                .frame(width: 68, alignment: .trailing)
        }
    }

    var costByDayCard: some View {
        let byDay = tracker.tokensByDay(in: dateRange)

        return SettingsCard {
            VStack(alignment: .leading, spacing: 14) {
                cardHeading(icon: "calendar",
                            title: "Tokens over time",
                            subtitle: "Output tokens generated on each day in range.")

                DayCountChartView(data: byDay.map { (date: $0.date, count: $0.tokens) },
                                  tint: StatisticsView.positive)
                    .frame(height: 150)
            }
            .padding(16)
        }
    }
}

// MARK: - Chart scaling

/// Shared by every chart on this page. The old versions each hardcoded a
/// Y-axis maximum of 4, so any real traffic ran straight off the top of the
/// plot and the axis labels lied — five ticks reading 0 through 4 no matter
/// what the data was.
private enum ChartScale {
    /// Rounds up to the next 1/2/5×10ⁿ so ticks land on readable numbers.
    static func niceMax(_ raw: Double) -> Double {
        guard raw > 0, raw.isFinite else { return 4 }
        let magnitude = pow(10, floor(log10(raw)))
        let fraction = raw / magnitude
        let stepped: Double = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 4 ? 4 : fraction <= 5 ? 5 : 10
        return stepped * magnitude
    }

    static func label(_ value: Double) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
        if value >= 1_000 { return String(format: value.truncatingRemainder(dividingBy: 1_000) == 0 ? "%.0fk" : "%.1fk", value / 1_000) }
        return String(format: "%.0f", value)
    }

    /// Leaves room for a right-aligned "1.5M" without it colliding with the
    /// plot; the old 24pt gutter only ever fit a single digit.
    static let gutter: CGFloat = 38
    static let axisInset: CGFloat = 22
}

/// Grid, axis labels, and a soft fill under the line. Used for both the live
/// TPM trace and the per-day series so all three charts on the page read as
/// the same component instead of three near-copies.
private struct ChartFrame<Content: View>: View {
    @Environment(\.themeColors) private var colors
    let maxValue: Double
    @ViewBuilder let content: (CGSize) -> Content

    var body: some View {
        GeometryReader { geo in
            let plotHeight = max(geo.size.height - ChartScale.axisInset, 1)

            ZStack(alignment: .topLeading) {
                ForEach(0..<5, id: \.self) { level in
                    let y = plotHeight - (CGFloat(level) / 4.0 * plotHeight)
                    Path { path in
                        path.move(to: CGPoint(x: ChartScale.gutter, y: y))
                        path.addLine(to: CGPoint(x: geo.size.width - 4, y: y))
                    }
                    .stroke(colors.borderSubtle,
                            style: StrokeStyle(lineWidth: 1, dash: level == 0 ? [] : [3, 4]))

                    Text(ChartScale.label(maxValue * Double(level) / 4.0))
                        .font(AppFont.mono(9))
                        .foregroundColor(colors.textTertiary)
                        .frame(width: ChartScale.gutter - 8, alignment: .trailing)
                        .position(x: (ChartScale.gutter - 8) / 2, y: y)
                }

                content(geo.size)
            }
        }
        .padding(.vertical, 8)
        .padding(.trailing, 4)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(colors.backgroundChart)
        )
    }
}

private struct LineChartView: View {
    @Environment(\.themeColors) private var colors
    let points: [Double]
    let tint: Color

    var body: some View {
        let maxValue = ChartScale.niceMax(points.max() ?? 0)

        return ChartFrame(maxValue: maxValue) { size in
            let plotHeight = max(size.height - ChartScale.axisInset, 1)
            let plotWidth = max(size.width - ChartScale.gutter - 4, 1)

            if points.count > 1 {
                let coords = points.enumerated().map { index, value -> CGPoint in
                    let x = ChartScale.gutter + (CGFloat(index) / CGFloat(points.count - 1)) * plotWidth
                    let y = plotHeight - CGFloat(min(value / maxValue, 1.0)) * plotHeight
                    return CGPoint(x: x, y: y)
                }

                Path { path in
                    path.move(to: CGPoint(x: coords[0].x, y: plotHeight))
                    coords.forEach { path.addLine(to: $0) }
                    path.addLine(to: CGPoint(x: coords[coords.count - 1].x, y: plotHeight))
                    path.closeSubpath()
                }
                .fill(LinearGradient(colors: [tint.opacity(0.22), tint.opacity(0.01)],
                                     startPoint: .top, endPoint: .bottom))

                Path { path in
                    path.move(to: coords[0])
                    coords.dropFirst().forEach { path.addLine(to: $0) }
                }
                .stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            } else {
                Path { path in
                    path.move(to: CGPoint(x: ChartScale.gutter, y: plotHeight))
                    path.addLine(to: CGPoint(x: size.width - 4, y: plotHeight))
                }
                .stroke(tint.opacity(0.5), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
        }
    }
}

/// One series indexed by day, with dated ticks along the bottom. Replaces
/// the two near-identical `UsageGridChartView` / `TokenDayChartView` copies,
/// which differed only in their hardcoded line color.
private struct DayCountChartView: View {
    @Environment(\.themeColors) private var colors
    let data: [(date: Date, count: Int)]
    let tint: Color

    var body: some View {
        let days = paddedDayRange()
        let counts = days.map { day in
            data.first { Calendar.current.isDate($0.date, inSameDayAs: day) }?.count ?? 0
        }
        let maxValue = ChartScale.niceMax(Double(counts.max() ?? 0))

        return ChartFrame(maxValue: maxValue) { size in
            let plotHeight = max(size.height - ChartScale.axisInset, 1)
            let plotWidth = max(size.width - ChartScale.gutter - 4, 1)
            let step = plotWidth / CGFloat(max(days.count - 1, 1))

            if days.count > 1 {
                let coords = counts.enumerated().map { index, count -> CGPoint in
                    let x = ChartScale.gutter + CGFloat(index) * step
                    let y = plotHeight - CGFloat(min(Double(count) / maxValue, 1.0)) * plotHeight
                    return CGPoint(x: x, y: y)
                }

                Path { path in
                    path.move(to: CGPoint(x: coords[0].x, y: plotHeight))
                    coords.forEach { path.addLine(to: $0) }
                    path.addLine(to: CGPoint(x: coords[coords.count - 1].x, y: plotHeight))
                    path.closeSubpath()
                }
                .fill(LinearGradient(colors: [tint.opacity(0.22), tint.opacity(0.01)],
                                     startPoint: .top, endPoint: .bottom))

                Path { path in
                    path.move(to: coords[0])
                    coords.dropFirst().forEach { path.addLine(to: $0) }
                }
                .stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))

                // Only ever ~6 dated ticks, however long the range is: a
                // 30-day range used to print all 30 labels on top of each
                // other.
                let stride = max(1, Int(ceil(Double(days.count) / 6.0)))
                ForEach(Array(days.enumerated()), id: \.offset) { index, day in
                    if index % stride == 0 || index == days.count - 1 {
                        Text(day.formatted(.dateTime.month(.abbreviated).day()))
                            .font(AppFont.mono(9))
                            .foregroundColor(colors.textTertiary)
                            .fixedSize()
                            .position(x: min(max(ChartScale.gutter + CGFloat(index) * step, ChartScale.gutter + 12),
                                             size.width - 20),
                                      y: size.height - 7)
                    }
                }
            } else {
                Path { path in
                    path.move(to: CGPoint(x: ChartScale.gutter, y: plotHeight))
                    path.addLine(to: CGPoint(x: size.width - 4, y: plotHeight))
                }
                .stroke(tint.opacity(0.5), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
        }
    }

    private func paddedDayRange() -> [Date] {
        if data.isEmpty {
            let calendar = Calendar.current
            let end = calendar.startOfDay(for: Date())
            return (0..<8).compactMap { calendar.date(byAdding: .day, value: -7 + $0, to: end) }
        }
        return data.map(\.date)
    }
}
